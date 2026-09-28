// WP1 — shredEpoch in the 01 §11.7 order, shredConversation / purgeConversation, and the shred_epoch job.
import { afterEach, describe, expect, it } from 'vitest';
import { createPrivacyService, createShredder, ShredCurrentEpochError } from '../../../src/privacy/index.ts';
import { DekDestroyedError } from '../../../src/kernel/errors.ts';
import { chat, count, mkConv, mkUser, privEnv, seedUser, type PrivEnv } from './env.ts';

let p: PrivEnv;
afterEach(() => p?.dispose());

describe('shredEpoch (01 §11.7)', () => {
  it('deletes the epoch rows, destroys its DEK, sets shredded_at and calls onShredEpoch — other epochs untouched', async () => {
    p = privEnv();
    const { c, blob } = seedUser(p);
    const hooked: string[] = [];
    p.addHook({ name: 'mem', onShredEpoch: async (conv, ep) => void hooked.push(`${conv}:${ep}`) });
    const shr = createShredder(p.s);
    await shr.shredEpoch(c.id, 1, 'forget');

    expect(count(p, 'shred_tokens', 'conversation_id = ? AND epoch = 1', c.id)).toBe(1);
    expect(count(p, 'messages', 'conversation_id = ? AND epoch = 1', c.id)).toBe(0);
    expect(count(p, 'messages', 'conversation_id = ? AND epoch = 2', c.id)).toBe(2);
    expect(count(p, 'runs', 'conversation_id = ? AND epoch = 1', c.id)).toBe(0);
    expect(count(p, 'runs', 'conversation_id = ? AND epoch = 2', c.id)).toBe(1);
    expect(count(p, 'tool_calls', 'conversation_id = ?', c.id)).toBe(0);
    expect(count(p, 'llm_calls', 'conversation_id = ?', c.id)).toBe(0);
    expect(count(p, 'run_memory_uses')).toBe(0);
    expect(count(p, 'conversation_inputs', 'conversation_id = ? AND consumed_epoch = 1', c.id)).toBe(0);
    expect(count(p, 'conversation_inputs', 'conversation_id = ? AND consumed_run_id IS NULL', c.id)).toBe(1); // the pending input stays
    expect(count(p, 'blob_refs')).toBe(0);
    expect(count(p, 'blobs', 'id = ?', blob)).toBe(0);
    expect(p.crypto.isDestroyed(`e:${c.id}:1`)).toBe(true);
    expect(p.crypto.isDestroyed(`e:${c.id}:2`)).toBe(false);
    expect(p.repos.conversations.getEpoch(c.id, 1)!.shreddedAt).toBe(p.clock.now());
    expect(hooked).toEqual([`${c.id}:1`]);
    // The current epoch still works; the pending input is readable (owner DEK).
    expect(p.repos.messages.load(c.id, 2)).toHaveLength(2);
    expect(p.repos.inputs.pending(c.id)[0]!.content).toEqual([{ type: 'text', text: 'pending' }]);
    // Appending to the shredded epoch is refused.
    expect(() => chat(p, c.id, 1, 'x', 'y')).toThrow(/shredded|destroyed/i);
  });

  it('is idempotent and refuses the current epoch of an active conversation', async () => {
    p = privEnv();
    const { c } = seedUser(p);
    const shr = createShredder(p.s);
    await expect(shr.shredEpoch(c.id, 2, 'forget')).rejects.toBeInstanceOf(ShredCurrentEpochError);
    await shr.shredEpoch(c.id, 1, 'forget');
    await shr.shredEpoch(c.id, 1, 'forget');
    await shr.shredEpoch(c.id, 7, 'forget'); // no such epoch: just the key
    await shr.shredEpoch('c_missing', 1, 'forget');
    expect(count(p, 'shred_tokens', 'conversation_id = ?', c.id)).toBe(1);
  });

  it('a blob still referenced by another epoch survives', async () => {
    p = privEnv();
    const u = mkUser(p);
    const c = mkConv(p, u.id);
    const blob = p.repos.messages.putBlob({ ownerUserId: u.id, dek: `u:${u.id}`, mime: 'text/plain', bytes: new Uint8Array([1]) });
    p.repos.messages.refBlobs(c.id, 1, [blob]);
    p.repos.conversations.startEpoch(c.id, 'idle', 'none', []);
    p.repos.messages.refBlobs(c.id, 2, [blob]);
    await createShredder(p.s).shredEpoch(c.id, 1, 'forget');
    expect(count(p, 'blobs', 'id = ?', blob)).toBe(1);
    expect(p.repos.messages.getBlob(blob)).toBeDefined();
  });

  it('a failing hook is logged, never undoes the shred', async () => {
    p = privEnv();
    const { c } = seedUser(p);
    p.addHook({ name: 'bad', onShredEpoch: async () => { throw new Error('boom'); } });
    await createShredder(p.s).shredEpoch(c.id, 1, 'forget');
    expect(p.crypto.isDestroyed(`e:${c.id}:1`)).toBe(true);
  });
});

describe('shredConversation / purgeConversation', () => {
  it('shredConversation on an active conversation rotates to a fresh wipe epoch, shreds all others, stays usable', async () => {
    p = privEnv();
    const { c } = seedUser(p);
    await createShredder(p.s).shredConversation(c.id, 'forget_chat');
    const conv = p.repos.conversations.get(c.id)!;
    expect(conv.status).toBe('active');
    expect(conv.epoch).toBe(3);
    expect(p.repos.conversations.currentEpoch(c.id).reason).toBe('wipe');
    expect(count(p, 'messages', 'conversation_id = ?', c.id)).toBe(0);
    expect(p.crypto.isDestroyed(`e:${c.id}:1`)).toBe(true);
    expect(p.crypto.isDestroyed(`e:${c.id}:2`)).toBe(true);
    expect(p.crypto.isDestroyed(`e:${c.id}:3`)).toBe(false);
    expect(chat(p, c.id, 3, 'new', 'fresh')).toEqual([1, 2]);
    // An empty active conversation is not rotated again.
    await createShredder(p.s).shredConversation(c.id, 'again');
    expect(p.repos.conversations.get(c.id)!.epoch).toBe(4); // epoch 3 held messages → rotated
    await createShredder(p.s).shredConversation(c.id, 'again');
    expect(p.repos.conversations.get(c.id)!.epoch).toBe(4);
  });

  it('shredConversation on a closed conversation marks it purged', async () => {
    p = privEnv();
    const { c } = seedUser(p);
    p.repos.conversations.update(c.id, { status: 'closed' });
    await createShredder(p.s).shredConversation(c.id, 'forget_chat');
    expect(p.repos.conversations.get(c.id)!.status).toBe('purged');
    expect(count(p, 'messages', 'conversation_id = ?', c.id)).toBe(0);
  });

  it('purgeConversation deletes every row of the conversation and frees its scope key', async () => {
    p = privEnv();
    const { c, u } = seedUser(p);
    const other = mkConv(p, u.id);
    chat(p, other.id, 1, 'keep', 'me');
    await createShredder(p.s).purgeConversation(c.id, 'retention');
    for (const t of ['conversations', 'epochs', 'messages', 'runs', 'conversation_inputs', 'conv_events', 'shred_tokens', 'blob_refs']) {
      expect(count(p, t, t === 'conversations' ? 'id = ?' : 'conversation_id = ?', c.id)).toBe(0);
    }
    expect(p.repos.conversations.byScopeKey(c.scopeKey)).toBeUndefined();
    expect(p.repos.messages.load(other.id, 1)).toHaveLength(2);
    expect(() => p.crypto.seal(`e:${c.id}:2`, 'x', 'a')).toThrow(DekDestroyedError);
  });
});

describe('shred_epoch job', () => {
  it('is registered and shreds the epoch named by the payload; the current epoch goes dead', async () => {
    p = privEnv();
    const { c } = seedUser(p);
    createPrivacyService(p.s);
    expect(p.scheduler.kinds()).toEqual(expect.arrayContaining(['shred_epoch', 'retention_sweep', 'backup']));
    const id = p.s.scheduler.schedule({ kind: 'shred_epoch', runAt: p.clock.now(), refId: c.id, payload: { conversationId: c.id, epoch: 1, reason: 'forget' } });
    await p.scheduler.tick();
    expect(p.scheduler.jobs.get(id)!.status).toBe('done');
    expect(p.crypto.isDestroyed(`e:${c.id}:1`)).toBe(true);
    const cur = p.s.scheduler.schedule({ kind: 'shred_epoch', runAt: p.clock.now(), refId: c.id, payload: { epoch: 2 } });
    const bad = p.s.scheduler.schedule({ kind: 'shred_epoch', runAt: p.clock.now(), payload: { epoch: 'x' } });
    await p.scheduler.tick();
    expect(p.scheduler.jobs.get(cur)!.status).toBe('dead');
    expect(p.scheduler.jobs.get(bad)!.status).toBe('dead');
    expect(p.crypto.isDestroyed(`e:${c.id}:2`)).toBe(false);
  });

  it('upserts the sys:retention_sweep (hourly) and sys:backup (nightly) cron jobs once', () => {
    p = privEnv();
    createPrivacyService(p.s);
    createPrivacyService(p.s); // a second factory call must not duplicate them (handlers already registered → kept)
    const sys = [...p.scheduler.jobs.values()].filter((j) => j.status === 'scheduled');
    expect(sys.map((j) => j.dedupeKey).sort()).toEqual(['sys:backup', 'sys:retention_sweep']);
    const backup = sys.find((j) => j.kind === 'backup')!;
    expect(backup.cron).toBe('30 3 * * *');
    expect(backup.runAt).toBe(Date.UTC(2026, 8, 29, 3, 30));
    expect(sys.find((j) => j.kind === 'retention_sweep')!.runAt).toBe(Date.UTC(2026, 8, 28, 9, 7));
  });
});
