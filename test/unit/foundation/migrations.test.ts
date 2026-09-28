import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { USER_DATA_TABLES } from '../../../src/contracts/storage.ts';
import { appliedVersions, loadMigrations, migrate } from '../../../src/db/migrate.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';

let t: TmpDb | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});
const NOW = Date.UTC(2026, 8, 28);

function seedEpoch(db: TmpDb['db']) {
  db.prepare(`INSERT INTO users(id, tg_user_id, created_at, updated_at) VALUES ('u1', 1001, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO conversations(id, scope_key, kind, user_id, route, model, effort, toolset, tools_hash, system_version, betas_json, created_at, last_activity_at)
              VALUES ('c1', 'dm:1001', 'dm', 'u1', 'chat', 'claude-opus-5', 'medium', 'FULL', 'h', 'v', '[]', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO epochs(conversation_id, epoch, dek_id, reason, started_at) VALUES ('c1', 1, 'e:c1:1', 'initial', ?)`).run(NOW);
  db.prepare(`INSERT INTO messages(conversation_id, epoch, seq, role, kind, content_enc, content_hmac, created_at) VALUES ('c1', 1, 1, 'user', 'user_input', x'01', 'h', ?)`).run(NOW);
}

describe('migrations (01 §7.1 + 03 R7)', () => {
  it('001 applies once and records its version', () => {
    t = openTmpDb({ migrate: false });
    expect(migrate(t.db, { now: NOW })).toEqual([1, 2, 3]);
    expect(migrate(t.db, { now: NOW })).toEqual([]);
    expect([...appliedVersions(t.db)]).toEqual([1, 2, 3]);
    expect(loadMigrations().map((m) => m.name)).toContain('001_init.sql');
  });
  it('003 (spec 05 §D) applies on top of a populated 001+002 database and keeps existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gora-mig-'));
    try {
      const only12 = join(dir, 'm');
      mkdirSync(only12);
      for (const m of loadMigrations().filter((x) => x.version <= 2)) writeFileSync(join(only12, m.name), m.sql);
      t = openTmpDb({ migrate: false });
      expect(migrate(t.db, { now: NOW, dir: only12 + '/' })).toEqual([1, 2]);
      t.db.prepare(`INSERT INTO users(id, tg_user_id, created_at, updated_at) VALUES ('u1', 1001, ?, ?)`).run(NOW, NOW);
      t.db.prepare(`INSERT INTO user_settings(user_id, updated_at) VALUES ('u1', ?)`).run(NOW);
      t.db.prepare(`INSERT INTO memory_facts(id, user_id, scope, kind, text_enc, dek_gen, sensitivity, confidence, status, source_kind, created_by, created_at, updated_at)
                    VALUES ('m1', 'u1', 'user:u1', 'fact', x'01', 1, 'normal', 0.9, 'active', 'user_message', 'extractor', ?, ?)`).run(NOW, NOW);
      expect(migrate(t.db, { now: NOW })).toEqual([3]);
      const u = t.db.prepare(`SELECT proactive_level, tz_hint_at, status FROM users WHERE id = 'u1'`).get<{ proactive_level: string; tz_hint_at: number | null; status: string }>();
      expect(u).toEqual({ proactive_level: 'normal', tz_hint_at: null, status: 'active' });
      expect(t.db.prepare(`SELECT importance, expires_at FROM memory_facts WHERE id = 'm1'`).get()).toEqual({ importance: 0.5, expires_at: null });
      expect(t.db.prepare(`SELECT style_json FROM user_settings WHERE user_id = 'u1'`).get()).toEqual({ style_json: null });
      expect(() => t!.db.prepare(`UPDATE users SET proactive_level = 'always'`).run()).toThrow(/CHECK/);
      t.db.prepare(`UPDATE users SET status = 'blocked'`).run();
      // the new tables exist, are STRICT, and cascade with the user
      t.db.prepare(`INSERT INTO fact_embeddings(fact_id, user_id, scope, model, dim, dek_gen, vec_enc, created_at) VALUES ('m1', 'u1', 'user:u1', 'e5', 384, 1, x'00', ?)`).run(NOW);
      t.db.prepare(`INSERT INTO user_signals(user_id, kind, at, local_hour, local_weekday) VALUES ('u1', 'inbound', ?, 9, 1)`).run(NOW);
      t.db.prepare(`INSERT INTO proactive_arms(user_id, arm, alpha, beta, updated_at) VALUES ('u1', 'type:checkin', 1, 3, ?)`).run(NOW);
      t.db.prepare(`INSERT INTO proactive_log(id, user_id, arm, content_type, gap_bucket, score, sent, created_at) VALUES ('p1', 'u1', 'checkin|3-5d', 'checkin', '3-5d', 0.4, 1, ?)`).run(NOW);
      t.db.prepare(`INSERT INTO user_rhythm(user_id, hist_blob, updated_at) VALUES ('u1', x'00', ?)`).run(NOW);
      t.db.prepare(`INSERT INTO user_profile(user_id, version, profile_enc, dek_gen, created_at) VALUES ('u1', 1, x'00', 1, ?)`).run(NOW);
      t.db.prepare(`DELETE FROM memory_facts WHERE id = 'm1'`).run();
      expect(t.db.prepare(`SELECT COUNT(*) AS n FROM fact_embeddings`).get()).toEqual({ n: 0 });
      t.db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
      for (const tbl of ['user_signals', 'proactive_arms', 'proactive_log', 'user_rhythm', 'user_profile']) expect(t.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get()).toEqual({ n: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('every table is STRICT', () => {
    t = openTmpDb();
    const rows = t.db.prepare(`SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'`).all<{ name: string; strict: number }>();
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(rows.filter((r) => r.strict !== 1).map((r) => r.name)).toEqual([]);
  });
  it('03 R7 additions exist', () => {
    t = openTmpDb();
    const cols = (tbl: string) => t!.db.prepare(`SELECT name FROM pragma_table_info(?)`).all<{ name: string }>(tbl).map((r) => r.name);
    expect(cols('users')).toContain('voice_replies');
    expect(cols('conversation_toolkits')).toEqual(['conversation_id', 'toolkit', 'expires_after_turn', 'loaded_at']);
    expect(cols('llm_rate_daily')).toEqual(expect.arrayContaining(['model', 'day_utc', 'requests', 'tokens']));
    expect(cols('conversation_turns')).toEqual(['conversation_id', 'user_turns']);
    expect(cols('runs')).toContain('priority');
    expect(cols('tg_links')).toContain('part');
    t.db.prepare(`INSERT INTO llm_calls(id, purpose, request_hmac, model_requested, created_at) VALUES ('l1', 'guard', 'h', 'groq:m', ?)`).run(NOW);
    expect(() => t!.db.prepare(`INSERT INTO llm_calls(id, purpose, request_hmac, model_requested, created_at) VALUES ('l2', 'bogus', 'h', 'm', ?)`).run(NOW)).toThrow(/CHECK/);
  });
  it('conversation_inputs: re-delivered updates are idempotent per (conversation, tg_update_id, untrusted)', () => {
    t = openTmpDb();
    seedEpoch(t.db);
    const ins = (id: string, upd: number | null, untrusted: number) =>
      t!.db.prepare(`INSERT OR IGNORE INTO conversation_inputs(id, conversation_id, tg_update_id, kind, author, content_enc, untrusted, created_at) VALUES (?, 'c1', ?, 'text', 'owner', x'01', ?, ?)`).run(id, upd, untrusted, NOW).changes;
    expect(Number(ins('i1', 7, 0))).toBe(1);
    expect(Number(ins('i2', 7, 0))).toBe(0);
    expect(Number(ins('i3', 7, 1))).toBe(1);
    expect(Number(ins('i4', null, 0))).toBe(1);
    expect(Number(ins('i5', null, 0))).toBe(1);
  });
  it('messages: UPDATE aborts; DELETE aborts without a shred token and succeeds with one', () => {
    t = openTmpDb();
    seedEpoch(t.db);
    expect(() => t!.db.prepare(`UPDATE messages SET stop_reason = 'x'`).run()).toThrow(/append-only: messages/);
    expect(() => t!.db.prepare(`DELETE FROM messages WHERE conversation_id = 'c1'`).run()).toThrow(/append-only: messages/);
    t.db.prepare(`INSERT INTO shred_tokens(conversation_id, epoch, reason, created_at) VALUES ('c1', 1, 'forget', ?)`).run(NOW);
    expect(Number(t.db.prepare(`DELETE FROM messages WHERE conversation_id = 'c1'`).run().changes)).toBe(1);
  });
  it('ledger and sentinel_decisions: no UPDATE; recent rows only deletable while the user is deleting; rows older than 365 days are deletable', () => {
    t = openTmpDb();
    const db = t.db;
    const now = Date.now(); // the triggers use strftime('now')
    db.prepare(`INSERT INTO users(id, tg_user_id, created_at, updated_at) VALUES ('u1', 1001, ?, ?)`).run(now, now);
    const insLedger = (id: number, ts: number) => db.prepare(`INSERT INTO ledger(id, user_id, seq, ts, actor, kind, summary_enc, prev_hmac, row_hmac) VALUES (?, 'u1', ?, ?, 'system', 'consent', x'01', 'p', 'r')`).run(id, id, ts);
    const insSd = (id: string, ts: number) => db.prepare(`INSERT INTO sentinel_decisions(id, user_id, tool_name, action_class, risk, decision, rule_id, reason, tainted, phase, created_at) VALUES (?, 'u1', 't', 'read_public', 0, 'allow', 'S18', 'r', 0, 'propose', ?)`).run(id, ts);
    insLedger(1, now - 400 * 86_400_000);
    insLedger(2, now);
    insSd('old', now - 400 * 86_400_000);
    insSd('new', now);
    expect(() => db.prepare(`UPDATE ledger SET kind = 'x'`).run()).toThrow(/append-only: ledger/);
    expect(() => db.prepare(`UPDATE sentinel_decisions SET reason = 'x'`).run()).toThrow(/append-only: sentinel_decisions/);
    expect(() => db.prepare(`DELETE FROM ledger WHERE id = 2`).run()).toThrow(/append-only: ledger/);
    expect(() => db.prepare(`DELETE FROM sentinel_decisions WHERE id = 'new'`).run()).toThrow(/append-only: sentinel_decisions/);
    expect(Number(db.prepare(`DELETE FROM ledger WHERE id = 1`).run().changes)).toBe(1); // retention (365 days)
    expect(Number(db.prepare(`DELETE FROM sentinel_decisions WHERE id = 'old'`).run().changes)).toBe(1);
    db.prepare(`UPDATE users SET status = 'deleting' WHERE id = 'u1'`).run();
    expect(Number(db.prepare(`DELETE FROM ledger WHERE user_id = 'u1'`).run().changes)).toBe(1);
    expect(Number(db.prepare(`DELETE FROM sentinel_decisions WHERE user_id = 'u1'`).run().changes)).toBe(1);
  });
  it('STRICT typing and CHECK constraints are enforced', () => {
    t = openTmpDb();
    expect(() => t!.db.prepare(`INSERT INTO kv(key, value_json, updated_at) VALUES ('k', '{}', 'not-a-number')`).run()).toThrow();
    expect(() => t!.db.prepare(`INSERT INTO users(id, tg_user_id, plan, created_at, updated_at) VALUES ('u', 1, 'gold', 0, 0)`).run()).toThrow(/CHECK/);
    const r = t.db.prepare(`INSERT INTO kv(key, value_json, updated_at) VALUES ('k', '{}', 1) RETURNING key`).get<{ key: string }>();
    expect(r?.key).toBe('k');
  });
  it('USER_DATA_TABLES names real tables and every WHERE clause compiles', () => {
    t = openTmpDb();
    const tables = new Set(t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>().map((r) => r.name));
    for (const e of USER_DATA_TABLES) {
      expect(tables.has(e.table), e.table).toBe(true);
      const stmt = t.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${e.table} WHERE ${e.where}`);
      const params: Record<string, string | number> = {};
      if (e.where.includes(':userId')) params['userId'] = 'u_none';
      if (e.where.includes(':tgUserId')) params['tgUserId'] = 0;
      expect(stmt.get(params)).toEqual({ n: 0 });
    }
    expect(USER_DATA_TABLES[USER_DATA_TABLES.length - 1]!.table).toBe('users');
    expect(USER_DATA_TABLES.find((e) => e.table === 'payments')?.via).toBe('hook');
  });
  it('USER_DATA_TABLES covers every table that has a user_id column (except the append-only exemptions handled elsewhere)', () => {
    t = openTmpDb();
    const tables = t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all<{ name: string }>().map((r) => r.name);
    const planned = new Set(USER_DATA_TABLES.map((e) => e.table));
    const missing = tables.filter((tbl) => {
      const cols = t!.db.prepare(`SELECT name FROM pragma_table_info(?)`).all<{ name: string }>(tbl).map((r) => r.name);
      return (cols.includes('user_id') || cols.includes('owner_user_id')) && !planned.has(tbl);
    });
    expect(missing).toEqual([]);
  });
});
