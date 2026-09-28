// WP1 — deleteUser (01 §7.2 deletion plan): every WP1 row of the user goes, the DEKs are destroyed, the hooks run in
// order, other users are untouched, a crash mid-way is resumed, and the request is recorded under a pseudonym.
import { afterEach, describe, expect, it } from 'vitest';
import { USER_DATA_TABLES } from '../../../src/contracts/storage.ts';
import { createDeleter, createShredder, deletedUserRef } from '../../../src/privacy/index.ts';
import { count, mkConv, privEnv, seedUser, type PrivEnv } from './env.ts';

let p: PrivEnv;
afterEach(() => p?.dispose());

const WP1_TABLES = ['users', 'user_settings', 'consents', 'permissions', 'conversations', 'epochs', 'shred_tokens', 'messages', 'blobs', 'blob_refs', 'conversation_inputs', 'conv_events', 'runs', 'run_waits', 'tool_calls', 'llm_calls', 'run_memory_uses', 'jobs'];

function deleter() {
  return createDeleter(p.s, createShredder(p.s));
}

describe('deleteUser (01 §7.2)', () => {
  it('removes every row of the user across the WP1 tables, destroys all their DEKs and keeps user B intact', async () => {
    p = privEnv();
    const a = seedUser(p, 111);
    const b = seedUser(p, 222);
    const order: string[] = [];
    p.addHook({ name: 'integrations', onDeleteUser: async (uid, tg) => void order.push(`integrations:${uid === a.u.id}:${tg}`) });
    p.addHook({ name: 'surfaces', onDeleteUser: async () => void order.push('surfaces') });

    await deleter().deleteUser(a.u.id, 'user');

    expect(order).toEqual(['integrations:true:111', 'surfaces']);
    expect(p.repos.users.getById(a.u.id)).toBeUndefined();
    expect(count(p, 'users')).toBe(1);
    const conv = ['epochs', 'shred_tokens', 'messages', 'blob_refs', 'conversation_inputs', 'conv_events', 'tool_calls', 'llm_calls', 'runs'];
    const byRun = ['run_waits', 'run_memory_uses'];
    for (const t of WP1_TABLES) {
      const where = t === 'users' ? 'id = ?' : conv.includes(t) ? 'conversation_id = ?' : byRun.includes(t) ? 'run_id = ?' : t === 'blobs' ? 'owner_user_id = ?' : t === 'conversations' ? 'id = ?' : 'user_id = ?';
      const arg = conv.includes(t) || t === 'conversations' ? a.c.id : byRun.includes(t) ? a.run1.id : a.u.id;
      expect({ t, n: count(p, t, where, arg) }).toEqual({ t, n: 0 });
    }
    expect(count(p, 'ledger', 'user_id = ?', a.u.id) + count(p, 'usage_daily', 'user_id = ?', a.u.id)).toBe(0);
    expect(count(p, 'kv', 'key = ?', `cooldown:${a.u.id}`)).toBe(0);
    expect(count(p, 'rate_buckets', 'key = ?', 'guest:111')).toBe(0);
    // DEKs: u:, epoch DEKs of both epochs.
    for (const dek of [`u:${a.u.id}`, `e:${a.c.id}:1`, `e:${a.c.id}:2`]) expect(p.crypto.isDestroyed(dek)).toBe(true);
    // B untouched.
    expect(p.repos.messages.load(b.c.id, 2)).toHaveLength(2);
    expect(p.s.ledger.verify(b.u.id)).toEqual({ ok: true });
    expect(count(p, 'rate_buckets', 'key = ?', 'guest:222')).toBe(1);
    expect(p.crypto.isDestroyed(`u:${b.u.id}`)).toBe(false);
    // The request row is pseudonymous and done.
    const req = p.db.prepare('SELECT user_ref, scope, status, target_ref, completed_at FROM deletion_requests').get<Record<string, unknown>>()!;
    expect(req).toMatchObject({ user_ref: deletedUserRef(p.s, a.u.id), scope: 'account', status: 'done', target_ref: 'user' });
    expect(String(req.user_ref)).not.toContain(a.u.id);
  });

  it('stops unfinished runs and removes jobs', async () => {
    p = privEnv();
    const a = seedUser(p);
    await deleter().deleteUser(a.u.id, 'admin');
    expect(p.stopped).toEqual([a.run2.id]);
    expect(count(p, 'jobs')).toBe(0);
  });

  it('a failing hook is recorded but the plan still completes', async () => {
    p = privEnv();
    const a = seedUser(p);
    p.addHook({ name: 'broken', onDeleteUser: async () => { throw new Error('provider down'); } });
    p.addHook({ name: 'after', onDeleteUser: async () => void p.hookCalls.push('after') });
    await deleter().deleteUser(a.u.id, 'user');
    expect(p.hookCalls).toEqual(['after']);
    expect(p.repos.users.getById(a.u.id)).toBeUndefined();
    expect(p.db.prepare('SELECT status, error FROM deletion_requests').get()).toEqual({ status: 'done', error: 'hooks_failed:broken' });
  });

  it('destroys the biz:<connId> DEKs and purges the biz_draft conversations of the user\'s business connections', async () => {
    p = privEnv();
    const a = seedUser(p);
    p.db.prepare(`INSERT INTO business_connections(id, user_id, tg_user_id, user_chat_id, rights_json, is_enabled, connected_at, updated_at) VALUES ('bc1', ?, ?, ?, '{}', 1, 0, 0)`).run(a.u.id, a.u.tgUserId, a.u.tgUserId);
    const draft = mkConv(p, null, { kind: 'biz_draft', businessConnectionId: 'bc1' });
    p.crypto.seal('b:bc1', 'peer text', 'business_messages|text_enc|x');
    await deleter().deleteUser(a.u.id, 'user');
    expect(p.crypto.isDestroyed('b:bc1')).toBe(true);
    expect(p.crypto.isDestroyed(`e:${draft.id}:1`)).toBe(true);
    expect(p.repos.conversations.get(draft.id)).toBeUndefined();
    expect(count(p, 'business_connections')).toBe(0);
  });

  it('never deletes payments (via:hook); the hook pseudonymizes them', async () => {
    p = privEnv();
    const a = seedUser(p);
    p.db.prepare(`INSERT INTO payments(telegram_payment_charge_id, user_ref, invoice_payload, total_amount, created_at) VALUES ('ch1', ?, 'sub:plus:v1', 500, 0)`).run(a.u.id);
    p.addHook({
      name: 'payments',
      onDeleteUser: async (uid) => void p.db.prepare(`UPDATE payments SET user_ref = ? WHERE user_ref = ?`).run('deleted:' + p.crypto.hmac('target', uid), uid),
    });
    await deleter().deleteUser(a.u.id, 'user');
    expect(count(p, 'payments')).toBe(1);
    expect(count(p, 'payments', 'user_ref = ?', a.u.id)).toBe(0);
    expect(USER_DATA_TABLES.find((t) => t.table === 'payments')!.via).toBe('hook');
  });

  it('resumes a deletion that crashed half-way (status deleting) and is idempotent', async () => {
    p = privEnv();
    const a = seedUser(p);
    let fail = true;
    p.addHook({ name: 'x', onDeleteUser: async () => {} });
    const d = deleter();
    // Crash inside step 3: the shredder throws once.
    const realPurge = p.s.repos.conversations.get.bind(p.s.repos.conversations);
    p.s.repos.conversations.get = (id: string) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      return realPurge(id);
    };
    await expect(d.deleteUser(a.u.id, 'user')).rejects.toThrow(/disk full/);
    expect(p.repos.users.getById(a.u.id)!.status).toBe('deleting');
    expect(p.db.prepare('SELECT status FROM deletion_requests').get()).toEqual({ status: 'failed' });
    expect(await d.resumeStuck()).toBe(1);
    expect(p.repos.users.getById(a.u.id)).toBeUndefined();
    expect(count(p, 'messages')).toBe(0);
    await d.deleteUser(a.u.id, 'user'); // gone: no-op
  });

  it('concurrent calls share one run', async () => {
    p = privEnv();
    const a = seedUser(p);
    let calls = 0;
    p.addHook({ name: 'count', onDeleteUser: async () => void calls++ });
    const d = deleter();
    await Promise.all([d.deleteUser(a.u.id, 'user'), d.deleteUser(a.u.id, 'user')]);
    expect(calls).toBe(1);
  });
});
