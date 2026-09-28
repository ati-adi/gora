// WP1 — 01 §15.2: the chain verifies; a forged row inserted with a raw connection after dropping the triggers is
// detected; deleting user A leaves B verified. Plus append-only guards, retention anchor, list paging, no plaintext.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ledger } from '../../../src/contracts/ledger.ts';
import { createLedgerCore, LEDGER_GENESIS, ledgerRowMaterial } from '../../../src/ledger/index.ts';
import { dbEnv, mkUser, type DbEnv } from './env.ts';

let e: DbEnv;
let ledger: Ledger;
afterEach(() => e?.dispose());

function setup(now?: number) {
  e = dbEnv(now === undefined ? {} : { now });
  ledger = createLedgerCore(() => e.db, () => e.crypto, () => e.clock);
}
async function fill(userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    ledger.append({ userId, actor: i % 2 ? 'agent' : 'user', kind: 'tool_call', summary: `step ${i}`, detail: { i, nested: { b: 2, a: 1 } }, runId: `r${i}` });
    await e.clock.advance(1000);
  }
}

describe('Ledger (01 §11.8)', () => {
  it('appends a per-user hash chain that verifies', async () => {
    setup();
    const a = mkUser(e).id;
    const b = mkUser(e).id;
    await fill(a, 5);
    await fill(b, 3);
    expect(ledger.verify(a)).toEqual({ ok: true });
    expect(ledger.verify(b)).toEqual({ ok: true });
    const rows = e.db.prepare('SELECT seq, prev_hmac, row_hmac FROM ledger WHERE user_id = ? ORDER BY seq').all<{ seq: number; prev_hmac: string; row_hmac: string }>(a);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0]!.prev_hmac).toBe(LEDGER_GENESIS);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hmac).toBe(rows[i - 1]!.row_hmac);
    expect(ledger.verify('nobody')).toEqual({ ok: true });
  });

  it('never stores the summary in plaintext; list pages newest first and filters', async () => {
    setup();
    const a = mkUser(e).id;
    await fill(a, 7);
    ledger.append({ userId: a, actor: 'system', kind: 'export', summary: 'multi\nline\tsummary' });
    const raw = e.db.prepare('SELECT summary_enc FROM ledger').all<{ summary_enc: Uint8Array }>();
    for (const r of raw) expect(Buffer.from(r.summary_enc).includes(Buffer.from('step'))).toBe(false);
    const p1 = ledger.list(a, { limit: 3 });
    expect(p1.map((x) => x.seq)).toEqual([8, 7, 6]);
    expect(p1[0]!.summary).toBe('multi line summary');
    expect(p1[1]).toMatchObject({ kind: 'tool_call', runId: 'r6', detail: { i: 6, nested: { a: 1, b: 2 } } });
    expect(ledger.list(a, { limit: 3, cursor: 6 }).map((x) => x.seq)).toEqual([5, 4, 3]);
    expect(ledger.list(a, { limit: 10, kinds: ['export'] }).map((x) => x.seq)).toEqual([8]);
    expect(() => ledger.append({ userId: a, actor: 'hacker' as never, kind: 'tool_call', summary: 'x' })).toThrow(/actor/);
  });

  it('is append-only: UPDATE aborts; DELETE of a recent row aborts unless the user is being deleted', async () => {
    setup();
    const a = mkUser(e).id;
    await fill(a, 2);
    expect(() => e.db.prepare('UPDATE ledger SET kind = ?').run('x')).toThrow(/append-only/);
    expect(() => e.db.prepare('DELETE FROM ledger WHERE user_id = ?').run(a)).toThrow(/append-only/);
  });

  it('detects a forged row inserted through a raw connection after dropping the triggers', async () => {
    setup();
    const a = mkUser(e).id;
    await fill(a, 4);
    const raw = new DatabaseSync(e.dbPath);
    try {
      raw.exec('DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_delete_guard;');
      // 1) A forged row appended with a made-up hmac (the attacker lacks GORA_HASH_KEY).
      const last = raw.prepare('SELECT row_hmac FROM ledger WHERE user_id = ? ORDER BY seq DESC LIMIT 1').get(a) as { row_hmac: string };
      const summary = e.crypto.seal(`u:${a}`, 'I approved everything', `ledger|summary_enc|${a}:5`);
      raw
        .prepare(`INSERT INTO ledger(user_id, seq, ts, actor, kind, summary_enc, prev_hmac, row_hmac) VALUES (?, 5, ?, 'user', 'approval_resolved', ?, ?, ?)`)
        .run(a, e.clock.now(), summary, last.row_hmac, 'f'.repeat(64));
    } finally {
      raw.close();
    }
    expect(ledger.verify(a)).toEqual({ ok: false, brokenAtSeq: 5 });
  });

  it('detects an edited summary, a deleted middle row and a re-ordered ts', async () => {
    setup();
    const a = mkUser(e).id;
    await fill(a, 5);
    const raw = new DatabaseSync(e.dbPath);
    raw.exec('DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_delete_guard;');
    const forged = e.crypto.seal(`u:${a}`, 'something else', `ledger|summary_enc|${a}:2`);
    raw.prepare('UPDATE ledger SET summary_enc = ? WHERE user_id = ? AND seq = 2').run(forged, a);
    expect(ledger.verify(a)).toEqual({ ok: false, brokenAtSeq: 2 });
    raw.prepare('DELETE FROM ledger WHERE user_id = ? AND seq = 2').run(a);
    expect(ledger.verify(a)).toEqual({ ok: false, brokenAtSeq: 3 });
    raw.prepare('UPDATE ledger SET ts = ts + 1 WHERE user_id = ? AND seq = 4').run(a);
    raw.close();
    expect(ledger.verify(a).ok).toBe(false);
  });

  it('deleting user A (status deleting) leaves user B verified', async () => {
    setup();
    const a = mkUser(e).id;
    const b = mkUser(e).id;
    await fill(a, 3);
    await fill(b, 3);
    e.repos.users.update(a, { status: 'deleting' });
    expect(Number(e.db.prepare('DELETE FROM ledger WHERE user_id = ?').run(a).changes)).toBe(3);
    expect(ledger.verify(b)).toEqual({ ok: true });
    expect(ledger.list(b, { limit: 10 })).toHaveLength(3);
    await fill(b, 1);
    expect(ledger.verify(b)).toEqual({ ok: true });
  });

  it('retention: after the oldest rows are removed the first remaining row is the anchor', async () => {
    setup(Date.UTC(2024, 0, 1));
    const a = mkUser(e).id;
    await fill(a, 3);
    await e.clock.set(Date.UTC(2026, 8, 28));
    await fill(a, 2);
    const cutoff = Date.UTC(2025, 0, 1);
    expect(Number(e.db.prepare('DELETE FROM ledger WHERE user_id = ? AND ts < ?').run(a, cutoff).changes)).toBe(3);
    expect(ledger.verify(a)).toEqual({ ok: true });
    // …but a first row claiming seq 1 must hang off GENESIS.
    expect(ledgerRowMaterial(LEDGER_GENESIS, { seq: 1, ts: 0, actor: 'user', kind: 'x', summary: 's', detail: null, refs: { runId: null, toolUseId: null, pendingActionId: null, sourceRef: null } })).toContain('"seq":1');
  });

  it('a shredded u: DEK makes verify fail loudly and list skip rows (never a crash)', async () => {
    setup();
    const a = mkUser(e).id;
    await fill(a, 2);
    e.crypto.destroyDek(`u:${a}`);
    expect(ledger.list(a, { limit: 10 })).toEqual([]);
    expect(ledger.verify(a)).toEqual({ ok: false, brokenAtSeq: 1 });
  });
});
