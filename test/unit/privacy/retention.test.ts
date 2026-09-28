// WP1 — the hourly retention_sweep (01 §11.9 retention table), WP1's part plus the hooks.
import { afterEach, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '../../../src/contracts/llm.ts';
import { createPrivacyService } from '../../../src/privacy/index.ts';
import { chat, count, mkConv, mkUser, privEnv, seedUser, type PrivEnv } from './env.ts';

let p: PrivEnv;
afterEach(() => p?.dispose());

const OLD = Date.UTC(2024, 5, 1);
const NOW = Date.UTC(2026, 8, 28, 9);
const D = 86_400_000;

function llmCall(convId: string, userId: string, epoch: number) {
  p.repos.runs.recordLlmCall({
    runId: null, conversationId: convId, epoch, userId, purpose: 'side', requestHmac: 'h', modelRequested: 'm', modelServed: 'm', servedByFallback: false,
    stopReason: null, refusalCategory: null, usage: ZERO_USAGE, iterations: null, costMicros: 0, latencyMs: null, ttftMs: null, requestId: null, errorClass: null, raw: { r: 1 },
  });
}

describe('retentionSweep (01 §11.9)', () => {
  it('applies every WP1 retention rule and calls the hooks', async () => {
    p = privEnv({ now: OLD });
    const { u, c } = seedUser(p); // epoch 1 closed at OLD; ledger rows at OLD
    llmCall(c.id, u.id, 2); // old raw payload in the live epoch
    const oldGuest = mkConv(p, null, { kind: 'guest' });
    const oldDraft = mkConv(p, null, { kind: 'biz_draft', businessConnectionId: 'bcX' });
    const orphan = p.repos.messages.putBlob({ ownerUserId: u.id, dek: `u:${u.id}`, mime: 'x/y', bytes: new Uint8Array([1]) });
    p.db.prepare('INSERT INTO rate_buckets(key, window_start, count) VALUES (?, ?, 1)').run('old-bucket', OLD);
    const sweeps: number[] = [];
    p.addHook({ name: 'tg', retentionSweep: async (now) => void sweeps.push(now) });
    p.addHook({ name: 'broken', retentionSweep: async () => { throw new Error('boom'); } });

    await p.clock.set(NOW);
    const freshGuest = mkConv(p, null, { kind: 'guest' });
    const freshDraft = mkConv(p, null, { kind: 'biz_draft', businessConnectionId: 'bcY' });
    p.s.ledger.append({ userId: u.id, actor: 'user', kind: 'settings', summary: 'recent' });
    llmCall(c.id, u.id, 2);
    chat(p, freshGuest.id, 1, 'guest q', 'guest a');

    await createPrivacyService(p.s).retentionSweep(p.clock.now());

    // closed epochs > 90 d → shredded; the current epoch stays
    expect(p.repos.conversations.getEpoch(c.id, 1)!.shreddedAt).toBe(NOW);
    expect(p.crypto.isDestroyed(`e:${c.id}:1`)).toBe(true);
    expect(p.repos.messages.load(c.id, 2)).toHaveLength(2);
    // guest 24 h / biz_draft 30 d → purged; fresh ones kept
    expect(p.repos.conversations.get(oldGuest.id)).toBeUndefined();
    expect(p.repos.conversations.get(oldDraft.id)).toBeUndefined();
    expect(p.crypto.isDestroyed(`e:${oldGuest.id}:1`)).toBe(true);
    expect(p.repos.conversations.get(freshGuest.id)).toBeDefined();
    expect(p.repos.conversations.get(freshDraft.id)).toBeDefined();
    // llm_calls.raw_enc > 30 d → NULL (the row stays)
    expect(count(p, 'llm_calls', 'conversation_id = ? AND raw_enc IS NULL', c.id)).toBe(1);
    expect(count(p, 'llm_calls', 'conversation_id = ? AND raw_enc IS NOT NULL', c.id)).toBe(1);
    // ledger > 365 d → deleted; the remaining chain still verifies (anchor)
    expect(p.s.ledger.list(u.id, { limit: 10 }).map((l) => l.summary)).toEqual(['recent']);
    expect(p.s.ledger.verify(u.id)).toEqual({ ok: true });
    // rate buckets, orphan blobs
    expect(count(p, 'rate_buckets', 'key = ?', 'old-bucket')).toBe(0);
    expect(count(p, 'blobs', 'id = ?', orphan)).toBe(0);
    // hooks: called with now; a failing one does not stop the sweep
    expect(sweeps).toEqual([NOW]);
  });

  it('keeps a guest conversation with a run in flight until the next sweep', async () => {
    p = privEnv({ now: OLD });
    const g = mkConv(p, null, { kind: 'guest' });
    p.repos.conversations.casActiveRun(g.id, null, 'run_x');
    await p.clock.advance(2 * D);
    await createPrivacyService(p.s).retentionSweep(p.clock.now());
    expect(p.repos.conversations.get(g.id)).toBeDefined();
    p.repos.conversations.casActiveRun(g.id, 'run_x', null);
    await createPrivacyService(p.s).retentionSweep(p.clock.now());
    expect(p.repos.conversations.get(g.id)).toBeUndefined();
  });

  it('resumes users stuck in status deleting', async () => {
    p = privEnv();
    const a = seedUser(p);
    const b = mkUser(p);
    p.repos.users.update(a.u.id, { status: 'deleting' });
    await createPrivacyService(p.s).retentionSweep(p.clock.now());
    expect(p.repos.users.getById(a.u.id)).toBeUndefined();
    expect(p.repos.users.getById(b.id)).toBeDefined();
  });

  it('runs as the retention_sweep job', async () => {
    p = privEnv({ now: OLD });
    const g = mkConv(p, null, { kind: 'guest' });
    createPrivacyService(p.s);
    await p.clock.advance(2 * D);
    await p.scheduler.tick();
    expect(p.scheduler.ran.map((j) => j.kind)).toContain('retention_sweep');
    expect(p.repos.conversations.get(g.id)).toBeUndefined();
  });
});
