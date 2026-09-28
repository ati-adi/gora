// Fixer regressions (memory area): edge cases of the fixes for F1, F3, F4, F5, F6 and F9 beyond the reviewer's proof tests.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { ABANDON_LEASES, LEASE_MS } from '../../../src/scheduler/scheduler.ts';
import { createJobsRepo } from '../../../src/scheduler/repo.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { supportingQuote } from '../../../src/memory/extract.ts';
import { createReminderModule } from '../../../src/reminders/index.ts';
import { resolveAtLocal, resolveCron } from '../../../src/reminders/service.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

const MIN = 60_000;
let env: TestEnv;
let sch: Scheduler;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  (env.s as { scheduler: Scheduler }).scheduler = sch;
});
afterEach(() => env.close());

describe('scheduler (F6)', () => {
  it('a job whose leases kept expiring is dead-lettered instead of being launched again', async () => {
    let runs = 0;
    sch.register('backup', async () => {
      runs++;
      return { status: 'done' };
    });
    const id = sch.schedule({ kind: 'backup', runAt: env.clock.now(), maxAttempts: 2 });
    // two crashed processes each claimed it and died holding the lease
    env.db.prepare(`UPDATE jobs SET status = 'leased', lease_until = ?, attempts = 2 WHERE id = ?`).run(env.clock.now() - 1, id);
    await sch.tick();
    expect(runs).toBe(0);
    expect(createJobsRepo(env.db).byId(id)!.status).toBe('dead');
  });

  it('a hung handler is abandoned after ABANDON_LEASES leases; its late result is ignored', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    sch.register('backup', () => {
      calls++;
      if (calls === 1) return new Promise((r) => (release = () => r({ status: 'done' })));
      return Promise.resolve({ status: 'done' });
    });
    const id = sch.schedule({ kind: 'backup', runAt: env.clock.now(), maxAttempts: 5 });
    void sch.tick();
    await env.clock.advance(0);
    for (let t = 0; t <= ABANDON_LEASES + 1; t++) {
      await env.clock.advance(LEASE_MS);
      void sch.tick();
      await env.clock.advance(0);
    }
    expect(calls).toBe(2); // re-claimed exactly once, after the abandonment
    const before = createJobsRepo(env.db).byId(id)!;
    release!();
    await env.clock.advance(0);
    const after = createJobsRepo(env.db).byId(id)!;
    expect({ status: after.status, lastError: after.lastError }).toEqual({ status: before.status, lastError: before.lastError });
  });
});

describe('extraction quote (F3)', () => {
  it('keeps only the supporting sentence', () => {
    const input = 'I am vegetarian. My sister Dana is in rehab in Almaty.';
    expect(supportingQuote(input, 'Vegetarian')).toBe('I am vegetarian.');
    expect(supportingQuote(input, 'Sister Dana is in rehab in Almaty')).toBe('My sister Dana is in rehab in Almaty.');
    expect(supportingQuote('Just one sentence here', 'unrelated')).toBe('Just one sentence here');
  });
});

describe('reminder time math (F4, F5)', () => {
  it('a 15-minute cron is fine; a weekly burst created mid-burst is refused', () => {
    expect(() => resolveCron('*/15 * * * *', 'UTC', env.clock.now())).not.toThrow();
    // Monday 2026-09-28 09:02 UTC: first occurrence 09:05 today, then 09:00 next Monday — then 09:05 five minutes later
    expect(() => resolveCron('0,5 9 * * 1', 'UTC', Date.UTC(2026, 8, 28, 9, 2))).toThrow(/15 minutes/);
  });

  it('DST overlap: the earlier instant is kept while it is still ahead', () => {
    const r = resolveAtLocal('2026-10-25T03:50', 'Europe/Kyiv', Date.UTC(2026, 9, 25, 0, 10));
    expect(r).toEqual({ instant: Date.UTC(2026, 9, 25, 0, 50), adjusted: 'overlap_earlier' });
    // both instants past → still 'past'
    expect(() => resolveAtLocal('2026-10-25T03:50', 'Europe/Kyiv', Date.UTC(2026, 9, 25, 2, 0))).toThrow(/past/);
  });
});

describe('group shred orphans (F9)', () => {
  it('the retention sweeps purge group memory, to-dos and reminders left under destroyed DEKs', async () => {
    const mem: MemoryService = createMemoryService(env.s);
    const mod = createReminderModule(env.s);
    const u = env.user();
    const g: Scope = { kind: 'group', chatId: -100999 };
    await mem.save(g, { text: 'Standup is at 10:00', kind: 'group_decision', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'group_explicit' } });
    mod.todos.apply(g, null, { action: 'add', text: 'buy snacks' });
    mod.reminders.create({ scope: g, userId: u.id, kind: 'reminder', text: 'retro', cron: '0 10 * * 5', tz: 'UTC', chatId: g.chatId });
    env.crypto.destroyOwner(`grp:${g.chatId}`);
    for (const h of env.s.privacyHooks) await h.retentionSweep?.(env.clock.now());
    const count = (t: string) => env.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE scope = ?`).get<{ n: number }>(`grp:${g.chatId}`)!.n;
    expect({ facts: count('memory_facts'), todos: count('todos'), reminders: count('reminders') }).toEqual({ facts: 0, todos: 0, reminders: 0 });
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reminder_fire' AND status = 'scheduled'`).get<{ n: number }>()!.n).toBe(0);
  });
});

describe('incognito window (F1)', () => {
  it('a message written after incognito ended is still extracted', async () => {
    const svc = createMemoryService(env.s);
    const u = env.user();
    const conv = env.dmConv(u);
    env.side.extractResult = { facts: [], commitments: [] };
    env.repos.users.update(u.id, { incognitoUntil: env.clock.now() + 10 * MIN });
    env.repos.conversations.startEpoch(conv.id, 'incognito_start', 'deterministic', []);
    sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 10 * MIN, userId: u.id, dedupeKey: `incog:${u.id}` });
    await env.clock.advance(11 * MIN);
    await sch.tick();
    expect(env.repos.users.getById(u.id)!.incognitoUntil).toBeNull();
    expect(env.runner.rotations).toContainEqual({ conversationId: conv.id, reason: 'incognito_end', excludeTexts: [] });
    env.repos.conversations.startEpoch(conv.id, 'incognito_end', 'deterministic', []); // WP3 performs the requested rotation
    await env.clock.advance(MIN);
    const id = env.repos.inputs.add({
      conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'I started learning Kazakh' }],
      tgUpdateId: null, tgChatId: conv.tgChatId, tgMessageId: 11, fromTgUserId: null, replyToCardId: null,
    });
    const epoch = env.repos.conversations.get(conv.id)!.epoch;
    const run = env.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId! }, maxTokens: 1000 });
    env.repos.inputs.markConsumed([id], run.id, epoch);
    await env.clock.advance(MIN);
    await svc.extractFromConversation(conv.id);
    expect(JSON.stringify(env.side.extractCalls)).toContain('Kazakh');
  });
});
