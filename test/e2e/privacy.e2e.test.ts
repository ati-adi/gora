// WP1 e2e — 01 §15.2: /deletemydata leaves zero rows across USER_DATA_TABLES except pseudonymized payments; the DEKs
// are destroyed; the hooks were invoked (provider revoke, files.delete, editUserStarSubscription); retention sweeps work.
//
// The app runs with WP1's real factories (keys.db, crypto, repos, ledger, quotas, privacy) and every other factory
// pinned to its NOOP fake, so the test is deterministic while the other WPs land. The privacy hooks of WP5 and WP7 are
// emulated here exactly as §7.2 step 2 describes them (their own tests cover their real hooks); the confirmation card
// (`dl:yes`) is WP7a's and ends in the same `s.privacy.deleteUser(userId, 'user')` call this test makes.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Factories } from '../../src/contracts/services.ts';
import { USER_DATA_TABLES, type UserDataTable } from '../../src/contracts/storage.ts';
import { NOOP_FACTORIES } from '../harness/fakes.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';

const WP1_REAL = new Set<keyof Factories>(['openKeyStore', 'createCrypto', 'createCoreRepos', 'createLedger', 'createQuotaService', 'createPrivacyService']);
const PINNED = Object.fromEntries(Object.entries(NOOP_FACTORIES).filter(([k]) => !WP1_REAL.has(k as keyof Factories))) as Partial<Factories>;

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

type Ids = { userId: string; tgUserId: number; convId: string; runId: string };

/** Named params used by a plan `where` (node:sqlite rejects unknown names). */
function params(where: string, ids: Ids): Record<string, string | number> {
  const p: Record<string, string | number> = {};
  if (where.includes(':userId')) p.userId = ids.userId;
  if (where.includes(':tgUserId')) p.tgUserId = ids.tgUserId;
  return p;
}
function planCount(db: DatabaseSync, tbl: UserDataTable, ids: Ids): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${tbl.table} WHERE ${tbl.where}`).get(params(tbl.where, ids)) as { n: number }).n);
}

/**
 * Inserts one row owned by the user into every plan table that is still empty for them, filling NOT NULL columns
 * from the column name (ids) or the first value of its CHECK (… IN (…)) list. Returns the tables it could not seed.
 */
function seedEveryTable(db: DatabaseSync, ids: Ids, now: number): string[] {
  const failed: string[] = [];
  let n = 0;
  for (const tbl of [...USER_DATA_TABLES].reverse()) {
    if (tbl.table === 'users' || tbl.via === 'hook' || planCount(db, tbl, ids) > 0) continue;
    const sql = String((db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tbl.table) as { sql: string }).sql);
    const checks = new Map<string, string>();
    for (const m of sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(\s*'([^']*)'/g)) if (!checks.has(m[1]!)) checks.set(m[1]!, m[2]!);
    const cols = db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info(?)`).all(tbl.table) as Array<{ name: string; type: string; nn: number; d: unknown; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).length;
    const names: string[] = [];
    const vals: Array<string | number | Uint8Array> = [];
    for (const c of cols) {
      const v = ((): string | number | Uint8Array | undefined => {
        const nm = c.name;
        if (checks.has(nm)) return checks.get(nm)!;
        if (nm === 'user_id') return ids.userId;
        if (nm === 'user_ref') return ids.userId;
        if (nm === 'scope') return `user:${ids.userId}`;
        if (nm === 'conversation_id') return ids.convId;
        if (nm === 'run_id') return ids.runId;
        // spec 05 (003): fact_embeddings.fact_id references memory_facts (seeded earlier in this reversed plan)
        if (nm === 'fact_id') return (db.prepare(`SELECT id FROM memory_facts WHERE user_id = ? LIMIT 1`).get(ids.userId) as { id: string } | undefined)?.id ?? 'm_missing';
        if (nm === 'connection_id') return 'bc_e2e';
        if (nm === 'owner_tg_id' || nm === 'caller_tg_id' || nm === 'tg_user_id' || nm === 'user_chat_id') return ids.tgUserId;
        if (c.pk === 1 && pkCols === 1 && c.type.toUpperCase() === 'INTEGER') return undefined; // rowid alias
        if (!c.nn || c.d !== null) return undefined;
        if (/BLOB/i.test(c.type)) return new Uint8Array([1]);
        if (/INT|REAL/i.test(c.type)) return nm.endsWith('_at') ? now : 1;
        return `${tbl.table}_${nm}_${++n}`;
      })();
      if (v === undefined) continue;
      names.push(c.name);
      vals.push(v);
    }
    try {
      db.prepare(`INSERT INTO ${tbl.table}(${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...vals);
    } catch (e) {
      failed.push(`${tbl.table}: ${(e as Error).message}`);
    }
  }
  return failed;
}

describe('privacy e2e (01 §7.2, §11.7, §11.9)', () => {
  it('/deletemydata leaves zero rows across USER_DATA_TABLES (payments pseudonymized), destroys DEKs, runs the hooks', async () => {
    t = await createTestApp({ factories: PINNED });
    const s = t.s;
    expect(t.app.fallbacksUsed).toEqual([]);

    // A real user with real WP1 data: two epochs, runs, ledger, usage, settings, consents …
    const u = s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Ann', language_code: 'en' }, { dmChatId: 1001 });
    const other = s.repos.users.upsertFromTelegram({ id: 2002, first_name: 'Bob' }, { dmChatId: 2002 });
    const conv = s.repos.conversations.create({
      scopeKey: 'dm:1001', kind: 'dm', userId: u.id, tgChatId: 1001, threadId: null, businessConnectionId: null, route: 'chat', model: 'claude-opus-5',
      effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
    });
    const run = s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1001 }, maxTokens: 1000 });
    s.repos.messages.append(conv.id, 1, [
      { role: 'user', kind: 'user_input', content: { role: 'user', content: [{ type: 'text', text: 'remember my passport number' }] } },
      { role: 'assistant', kind: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, runId: run.id },
    ]);
    s.repos.conversations.startEpoch(conv.id, 'idle', 'none', []);
    s.repos.messages.append(conv.id, 2, [{ role: 'user', kind: 'user_input', content: { role: 'user', content: [{ type: 'text', text: 'hi again' }] } }]);
    s.repos.users.grantConsent({ userId: u.id, kind: 'memory', textVersion: 'v1', via: 'callback' });
    s.repos.users.updateSettings(u.id, { homeCity: { name: 'Almaty', lat: 43.2, lon: 76.9 } });
    s.ledger.append({ userId: u.id, actor: 'user', kind: 'consent', summary: 'Memory on' });
    s.ledger.append({ userId: other.id, actor: 'user', kind: 'consent', summary: 'Memory on' });
    s.quotas.consume(u.id, 'turn', 3);
    s.crypto.seal(`m:${u.id}:1`, 'a memory fact', 'memory_facts|text_enc|m1');

    // Every other plan table gets a row of this user (the other WPs' tables included).
    const db = s.db.raw;
    const ids: Ids = { userId: u.id, tgUserId: 1001, convId: conv.id, runId: run.id };
    db.prepare(`INSERT INTO business_connections(id, user_id, tg_user_id, user_chat_id, rights_json, is_enabled, connected_at, updated_at) VALUES ('bc_e2e', ?, 1001, 1001, '{}', 1, 0, 0)`).run(u.id);
    s.crypto.seal('b:bc_e2e', 'peer message', 'business_messages|text_enc|x');
    const blob = s.repos.messages.putBlob({ ownerUserId: u.id, dek: `e:${conv.id}:2`, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    s.repos.messages.refBlobs(conv.id, 2, [blob]);
    const failed = seedEveryTable(db, ids, t.clock.now());
    expect(failed).toEqual([]);
    db.prepare(`INSERT INTO payments(telegram_payment_charge_id, user_ref, invoice_payload, total_amount, is_recurring, created_at) VALUES ('stxCharge1', ?, 'sub:plus:v1:x', 500, 1, 0)`).run(u.id);
    const seeded = USER_DATA_TABLES.filter((tbl) => planCount(db, tbl, ids) > 0).map((tbl) => tbl.table);
    expect(seeded).toEqual(USER_DATA_TABLES.map((tbl) => tbl.table)); // every table really holds data before

    // §7.2 step 2 hooks, as WP5 and WP7 implement them.
    const revoked: string[] = [];
    const filesDeleted: string[] = [];
    s.privacyHooks.push({
      name: 'integrations',
      onDeleteUser: async (userId) => {
        revoked.push(`provider.revoke:${userId}`);
        for (const r of db.prepare('SELECT file_id FROM anthropic_files WHERE user_id = ?').all(userId) as Array<{ file_id: string }>) filesDeleted.push(r.file_id);
      },
    });
    s.privacyHooks.push({
      name: 'surfaces',
      onDeleteUser: async (userId, tgUserId) => {
        const sub = db.prepare(`SELECT telegram_payment_charge_id AS c FROM payments WHERE user_ref = ? AND is_recurring = 1`).get(userId) as { c: string } | undefined;
        if (sub) await s.telegram.api.editUserStarSubscription(tgUserId, sub.c, true);
        db.prepare(`UPDATE payments SET user_ref = ? WHERE user_ref = ?`).run('deleted:' + s.crypto.hmac('target', userId), userId);
      },
    });

    await s.privacy.deleteUser(u.id, 'user');
    await t.settle();

    // Zero rows in every plan table, except the pseudonymized payment.
    for (const tbl of USER_DATA_TABLES) expect({ table: tbl.table, n: planCount(db, tbl, ids) }).toEqual({ table: tbl.table, n: 0 });
    const pay = db.prepare('SELECT user_ref FROM payments').all() as Array<{ user_ref: string }>;
    expect(pay).toHaveLength(1);
    expect(pay[0]!.user_ref).toMatch(/^deleted:[0-9a-f]{64}$/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    // Hooks.
    expect(revoked).toEqual([`provider.revoke:${u.id}`]);
    expect(filesDeleted).toHaveLength(1);
    expect(t.tg.byMethod('editUserStarSubscription')).toEqual([expect.objectContaining({ user_id: 1001, telegram_payment_charge_id: 'stxCharge1', is_canceled: true })]);
    // DEKs: nothing of this user is left unwrapped in keys.db.
    const keys = new DatabaseSync(t.config.keysDbPath, { readOnly: true });
    try {
      const live = keys.prepare(`SELECT id FROM deks WHERE wrapped IS NOT NULL AND (owner = ? OR owner = 'biz:bc_e2e')`).all(u.id);
      expect(live).toEqual([]);
      const dead = (keys.prepare(`SELECT id FROM deks WHERE wrapped IS NULL`).all() as Array<{ id: string }>).map((r) => r.id);
      expect(dead).toEqual(expect.arrayContaining([`u:${u.id}`, `m:${u.id}:1`, `e:${conv.id}:1`, `e:${conv.id}:2`, 'b:bc_e2e']));
    } finally {
      keys.close();
    }
    for (const dek of [`u:${u.id}`, `e:${conv.id}:1`, `e:${conv.id}:2`]) expect(s.crypto.isDestroyed(dek)).toBe(true);
    // The other user is untouched and the account deletion is recorded pseudonymously.
    expect(s.repos.users.getById(other.id)).toBeDefined();
    expect(s.ledger.verify(other.id)).toEqual({ ok: true });
    const req = db.prepare('SELECT user_ref, status FROM deletion_requests').get() as { user_ref: string; status: string };
    expect(req.status).toBe('done');
    expect(req.user_ref).not.toContain(u.id);
    // The user can start over as a new account.
    const again = s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Ann' }, { dmChatId: 1001 });
    expect(again.id).not.toBe(u.id);
  });

  it('the hourly retention_sweep shreds closed epochs after 90 days and guest conversations after 24 h', async () => {
    t = await createTestApp({ factories: PINNED });
    const s = t.s;
    const u = s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Ann' }, { dmChatId: 1001 });
    const base = { threadId: null, businessConnectionId: null, model: 'claude-opus-5', effort: 'medium' as const, toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system' as const };
    const dm = s.repos.conversations.create({ ...base, scopeKey: 'dm:1001', kind: 'dm', userId: u.id, tgChatId: 1001, route: 'chat', toolset: 'FULL', singleShot: false });
    s.repos.messages.append(dm.id, 1, [{ role: 'user', kind: 'user_input', content: { role: 'user', content: 'old' } }]);
    s.repos.conversations.startEpoch(dm.id, 'idle', 'none', []);
    const guest = s.repos.conversations.create({ ...base, scopeKey: 'guest:q1', kind: 'guest', userId: null, tgChatId: null, route: 'guest', toolset: 'GUEST', singleShot: true });
    s.repos.messages.append(guest.id, 1, [{ role: 'user', kind: 'user_input', content: { role: 'user', content: 'guest question' } }]);
    const hookSweeps: number[] = [];
    s.privacyHooks.push({ name: 'tg', onDeleteUser: async () => {}, retentionSweep: async (now) => void hookSweeps.push(now) });

    await t.advance(25 * 3_600_000); // the hourly sys:retention_sweep job runs
    expect(s.repos.conversations.get(guest.id)).toBeUndefined();
    expect(s.crypto.isDestroyed(`e:${guest.id}:1`)).toBe(true);
    expect(s.repos.conversations.getEpoch(dm.id, 1)!.shreddedAt).toBeNull();
    expect(hookSweeps.length).toBeGreaterThanOrEqual(1);

    // The NOOP scheduler does not re-arm cron jobs (WP6a's real one does): run the next hourly sweep directly.
    await t.advance(90 * 86_400_000);
    await s.privacy.retentionSweep(t.clock.now());
    expect(s.repos.conversations.getEpoch(dm.id, 1)!.shreddedAt).not.toBeNull();
    expect(s.crypto.isDestroyed(`e:${dm.id}:1`)).toBe(true);
    expect(s.crypto.isDestroyed(`e:${dm.id}:2`)).toBe(false);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND epoch = 1').get(dm.id)).toEqual({ n: 0 });
  });
});
