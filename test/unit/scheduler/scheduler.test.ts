// 01 §15.2 WP6: leases, retries, dead jobs, cron with tz, coalescing, dedupe (+ 03 R6 budget gate).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobRow, Scheduler } from '../../../src/contracts/index.ts';
import { createScheduler, cronNext, retryDelay } from '../../../src/scheduler/index.ts';
import { createJobsRepo } from '../../../src/scheduler/repo.ts';
import { makeEnv, type TestEnv } from '../memory/env.ts';

const H = 3_600_000;
let env: TestEnv;
let sch: Scheduler;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s, { random: () => 0.5 });
  (env.s as { scheduler: Scheduler }).scheduler = sch;
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

const row = (id: string) => createJobsRepo(env.db).byId(id)!;

describe('scheduler', () => {
  it('runs a due one-off job once and marks it done', async () => {
    const ran: JobRow[] = [];
    sch.register('incognito_end', async (j) => {
      ran.push(j);
      return { status: 'done' };
    });
    const id = sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 60_000, userId: 'u1', refId: 'r1', payload: { a: 1 } });
    expect(await sch.tick()).toBe(0);
    await env.clock.advance(60_000);
    expect(await sch.tick()).toBe(1);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.payload).toEqual({ a: 1 });
    expect(ran[0]!.attempts).toBe(1);
    expect(row(id).status).toBe('done');
    expect(await sch.tick()).toBe(0);
    expect(sch.health().lastTickAt).toBe(env.clock.now());
  });

  it('rejects content-like payloads (ids and enums only)', () => {
    expect(() => sch.schedule({ kind: 'incognito_end', runAt: 1, payload: { text: 'x'.repeat(500) } })).toThrow(/too long/);
    expect(() => sch.schedule({ kind: 'incognito_end', runAt: 1, payload: { o: { a: 1 } as never } })).toThrow(/scalar/);
  });

  it('leases: a job leased by a crashed worker is re-claimed after the lease expires', async () => {
    const id = sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() });
    // another (crashed) process claimed it with a 5-min lease
    const claimed = createJobsRepo(env.db).claim(['incognito_end'], env.clock.now(), 300_000, 20);
    expect(claimed.map((j) => j.id)).toEqual([id]);
    let runs = 0;
    sch.register('incognito_end', async () => {
      runs++;
      return { status: 'done' };
    });
    expect(await sch.tick()).toBe(0); // still leased
    await env.clock.advance(300_001);
    expect(await sch.tick()).toBe(1);
    expect(runs).toBe(1);
    expect(row(id).status).toBe('done');
    expect(row(id).attempts).toBe(2);
  });

  it('retries with exponential backoff, then dead-letters with a ledger entry and a user notice', async () => {
    const u = env.user();
    let calls = 0;
    sch.register('reminder_fire', async () => {
      calls++;
      throw new Error('boom');
    });
    const id = sch.schedule({ kind: 'reminder_fire', runAt: env.clock.now(), userId: u.id, refId: 'rem1', maxAttempts: 3 });
    await sch.tick();
    let r = row(id);
    expect(r.status).toBe('scheduled');
    expect(r.runAt - env.clock.now()).toBe(retryDelay(1, () => 0.5)); // 60 s
    expect(r.runAt - env.clock.now()).toBe(60_000);
    expect(r.lastError).toBe('boom');
    await env.clock.advance(60_000);
    await sch.tick();
    r = row(id);
    expect(r.runAt - env.clock.now()).toBe(120_000);
    await env.clock.advance(120_000);
    await sch.tick();
    r = row(id);
    expect(calls).toBe(3);
    expect(r.status).toBe('dead');
    expect(env.ledger.entries.some((e) => e.userId === u.id && e.detail?.['jobId'] === id)).toBe(true);
    expect(env.outbox.queued.filter((q) => q.chatId === u.dmChatId)).toHaveLength(1);
    // no text of the reminder in the ledger or job row
    expect(JSON.stringify(env.ledger.entries)).not.toMatch(/boom.*boom/);
  });

  it('backoff is capped at 1 h with ±10 % jitter', () => {
    expect(retryDelay(20, () => 0.5)).toBe(H);
    expect(retryDelay(20, () => 0)).toBe(0.9 * H);
    expect(retryDelay(20, () => 1)).toBe(3_960_000);
    expect(retryDelay(0, () => 0.5)).toBe(30_000);
  });

  it("'dead' result is terminal at once; 'reschedule' re-arms", async () => {
    let n = 0;
    sch.register('nudge_ignore', async () => (++n === 1 ? { status: 'reschedule', runAt: env.clock.now() + 1000 } : { status: 'dead', error: 'gone' }));
    const id = sch.schedule({ kind: 'nudge_ignore', runAt: env.clock.now() });
    await sch.tick();
    expect(row(id).status).toBe('scheduled');
    await env.clock.advance(1000);
    await sch.tick();
    expect(row(id).status).toBe('dead');
  });

  it('cron in the job zone (croner {timezone}), next occurrence after done', async () => {
    const seen: number[] = [];
    sch.register('checkin_fire', async (_j, ctx) => {
      seen.push(ctx.now);
      return { status: 'done' };
    });
    // FakeClock = 2026-09-28 09:00 UTC = 14:00 in Almaty (+05:00): next 09:00 Almaty is 2026-09-29 04:00 UTC
    const id = sch.schedule({ kind: 'checkin_fire', runAt: 0, cron: '0 9 * * *', tz: 'Asia/Almaty' });
    expect(row(id).runAt).toBe(Date.UTC(2026, 8, 29, 4, 0));
    await env.clock.set(Date.UTC(2026, 8, 29, 4, 0));
    await sch.tick();
    expect(seen).toHaveLength(1);
    expect(row(id).status).toBe('scheduled');
    expect(row(id).runAt).toBe(Date.UTC(2026, 8, 30, 4, 0));
    // Kyiv crosses DST on 2026-10-25: 09:00 local is 06:00 UTC before, 07:00 UTC after
    expect(cronNext('0 9 * * *', 'Europe/Kyiv', Date.UTC(2026, 9, 24, 12))).toBe(Date.UTC(2026, 9, 25, 7));
    expect(cronNext('0 9 * * *', 'Europe/Kyiv', Date.UTC(2026, 9, 23, 12))).toBe(Date.UTC(2026, 9, 24, 6));
  });

  it('rejects invalid cron and zones', () => {
    expect(() => sch.schedule({ kind: 'checkin_fire', runAt: 0, cron: 'every day', tz: 'UTC' })).toThrow(/cron/);
    expect(() => sch.schedule({ kind: 'checkin_fire', runAt: 0, cron: '0 9 * * *', tz: 'Mars/Base' })).toThrow(/time zone/);
  });

  it('coalesces a cron job whose missed runs exceed 2 intervals into one run', async () => {
    let runs = 0;
    sch.register('checkin_fire', async () => {
      runs++;
      return { status: 'done' };
    });
    const id = sch.schedule({ kind: 'checkin_fire', runAt: 0, cron: '0 * * * *', tz: 'UTC' });
    const first = row(id).runAt;
    await env.clock.set(first + 5 * H + 60_000); // 5 hourly runs missed (e.g. the process was down)
    await sch.tick();
    expect(runs).toBe(1);
    const next = row(id).runAt;
    expect(next).toBeGreaterThan(env.clock.now());
    expect(next - env.clock.now()).toBeLessThanOrEqual(H);
    expect(await sch.tick()).toBe(0);
    expect(runs).toBe(1);
  });

  it('a cron job missing ≤ 2 intervals catches up one run at a time', async () => {
    let runs = 0;
    sch.register('checkin_fire', async () => {
      runs++;
      return { status: 'done' };
    });
    const id = sch.schedule({ kind: 'checkin_fire', runAt: 0, cron: '0 * * * *', tz: 'UTC' });
    const first = row(id).runAt;
    await env.clock.set(first + H + 60_000);
    await sch.tick();
    expect(row(id).runAt).toBe(first + H); // the one missed run is still due
    await sch.tick();
    expect(runs).toBe(2);
    expect(row(id).runAt).toBe(first + 2 * H);
  });

  it('dedupe: schedule() upserts by dedupeKey; cancel by key', async () => {
    const a = sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 1000, dedupeKey: 'k1' });
    const b = sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 5000, dedupeKey: 'k1' });
    expect(b).toBe(a);
    expect(row(a).runAt).toBe(env.clock.now() + 5000);
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key = 'k1'`).get<{ n: number }>()!.n).toBe(1);
    let runs = 0;
    sch.register('incognito_end', async () => {
      runs++;
      return { status: 'done' };
    });
    sch.cancel('k1');
    await env.clock.advance(10_000);
    await sch.tick();
    expect(runs).toBe(0);
    expect(row(a).status).toBe('cancelled');
    // re-arming a finished key reuses the row
    const c = sch.schedule({ kind: 'incognito_end', runAt: env.clock.now(), dedupeKey: 'k1' });
    expect(c).toBe(a);
    await sch.tick();
    expect(runs).toBe(1);
  });

  it('a job re-armed while its handler runs keeps the new schedule', async () => {
    const id = sch.schedule({ kind: 'incognito_end', runAt: env.clock.now(), dedupeKey: 'k2' });
    sch.register('incognito_end', async () => {
      sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 7 * H, dedupeKey: 'k2' });
      return { status: 'done' };
    });
    await sch.tick();
    expect(row(id).status).toBe('scheduled');
    expect(row(id).runAt).toBe(env.clock.now() + 7 * H);
  });

  it('03 R6: LLM-backed kinds wait while llmBudget.allow(priority) says no; reminder_fire never waits', async () => {
    const ran: string[] = [];
    sch.register('memory_extract', async () => {
      ran.push('memory_extract');
      return { status: 'done' };
    });
    sch.register('reminder_fire', async () => {
      ran.push('reminder_fire');
      return { status: 'done' };
    });
    const mx = sch.schedule({ kind: 'memory_extract', runAt: env.clock.now() });
    sch.schedule({ kind: 'reminder_fire', runAt: env.clock.now() });
    env.llmBudget.blocked.add('background');
    await sch.tick();
    expect(ran).toEqual(['reminder_fire']);
    expect(row(mx).status).toBe('scheduled');
    expect(row(mx).attempts).toBe(0);
    expect(row(mx).runAt).toBeGreaterThan(env.clock.now());
    env.llmBudget.blocked.clear();
    await env.clock.advance(11 * 60_000);
    await sch.tick();
    expect(ran).toEqual(['reminder_fire', 'memory_extract']);
  });

  it('claims by priority then run_at', async () => {
    const order: string[] = [];
    sch.register('incognito_end', async (j) => {
      order.push(j.refId!);
      return { status: 'done' };
    });
    sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() - 2000, refId: 'late-low', priority: 9 });
    sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() - 1000, refId: 'hi', priority: 1 });
    sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() - 3000, refId: 'mid', priority: 5 });
    await sch.tick();
    expect(order).toEqual(['hi', 'mid', 'late-low']);
  });

  it('list() returns a user’s scheduled jobs soonest first', () => {
    sch.schedule({ kind: 'reminder_fire', runAt: env.clock.now() + 2000, userId: 'u9', refId: 'b' });
    sch.schedule({ kind: 'checkin_fire', runAt: env.clock.now() + 1000, userId: 'u9', refId: 'a' });
    sch.schedule({ kind: 'reminder_fire', runAt: env.clock.now() + 500, userId: 'other', refId: 'x' });
    expect(sch.list({ userId: 'u9', limit: 10 }).map((j) => j.refId)).toEqual(['a', 'b']);
    expect(sch.list({ userId: 'u9', kinds: ['reminder_fire'], limit: 10 }).map((j) => j.refId)).toEqual(['b']);
  });

  it('start() loops on the Clock and stop() drains', async () => {
    let runs = 0;
    sch.register('incognito_end', async () => {
      runs++;
      return { status: 'done' };
    });
    expect(sch.health().lastTickAt).toBeNull();
    sch.start();
    sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 2500 });
    await env.clock.advance(3000);
    await env.clock.advance(1000);
    expect(runs).toBe(1);
    expect(sch.health().lastTickAt).not.toBeNull();
    await sch.stop();
  });

  it('privacy hook cancels a deleted user’s jobs', async () => {
    const id = sch.schedule({ kind: 'reminder_fire', runAt: env.clock.now() + 1000, userId: 'gone' });
    const hook = env.s.privacyHooks.find((h) => h.name === 'scheduler')!;
    await hook.onDeleteUser('gone', 1);
    expect(row(id).status).toBe('cancelled');
  });
});
