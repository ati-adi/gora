// ledger/ledger.ts (WP1) — the per-user, hash-chained, append-only audit ledger (01 §11.8, F8).
//
// row_hmac = hmac('ledger', prev_hmac ‖ canonicalJson({seq, ts, actor, kind, summary, detail, refs})), keyed with
// GORA_HASH_KEY, so a row inserted or altered with a raw connection cannot carry a valid HMAC. The first row of a chain
// has prev_hmac = GENESIS; after retention removed the oldest rows, the first remaining row's prev_hmac is the anchor.
// summary/detail are sealed under the user's DEK 'u:<userId>' (AAD 'ledger|summary_enc|<userId>:<seq>' / detail_enc).
import type { Clock, UserId } from '../contracts/common.ts';
import type { Ledger, LedgerEntry, LedgerKind } from '../contracts/ledger.ts';
import type { Crypto, Db, SqlValue } from '../contracts/storage.ts';
import { canonicalJson } from '../kernel/canonicalJson.ts';
import { isShredded } from '../db/crypto.ts';

export const LEDGER_GENESIS = '0'.repeat(64);
export const LEDGER_SUMMARY_MAX = 300;
const ACTORS: ReadonlySet<string> = new Set(['agent', 'user', 'sentinel', 'system', 'scheduler']);

const aadSummary = (userId: string, seq: number) => `ledger|summary_enc|${userId}:${seq}`;
const aadDetail = (userId: string, seq: number) => `ledger|detail_enc|${userId}:${seq}`;

interface Refs { runId: string | null; toolUseId: string | null; pendingActionId: string | null; sourceRef: string | null }

export function ledgerRowMaterial(prevHmac: string, r: { seq: number; ts: number; actor: string; kind: string; summary: string; detail: unknown; refs: Refs }): string {
  return prevHmac + canonicalJson({ seq: r.seq, ts: r.ts, actor: r.actor, kind: r.kind, summary: r.summary, detail: r.detail ?? null, refs: r.refs });
}

/** JSON round trip: the value the ledger stores and hashes is exactly what JSON.parse gives back on verify. */
function normalizeDetail(d: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (d === undefined || d === null) return null;
  const s = JSON.stringify(d, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `[${v.length} bytes]` : v));
  return s === undefined ? null : (JSON.parse(s) as Record<string, unknown>);
}

/**
 * One line, at most LEDGER_SUMMARY_MAX UTF-16 units, cut on a code-point boundary, and well-formed: the HMAC must be
 * computed over exactly the text seal() stores (UTF-8 turns a lone surrogate into U+FFFD, which would make verify()
 * report an intact row as tampered).
 */
function oneLine(s: string): string {
  let t = String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (t.length > LEDGER_SUMMARY_MAX) {
    let cut = LEDGER_SUMMARY_MAX - 1;
    const c = t.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--; // do not keep half of a surrogate pair
    t = t.slice(0, cut) + '…';
  }
  return t.toWellFormed();
}

interface Row { seq: number; ts: number; actor: string; kind: string; summary_enc: Uint8Array; detail_enc: Uint8Array | null; run_id: string | null; tool_use_id: string | null; pending_action_id: string | null; source_ref: string | null; prev_hmac: string; row_hmac: string }

/** A verified position in a user's chain: the last row checked and its row_hmac. */
export interface LedgerCheckpoint { seq: number; rowHmac: string }

export type LedgerChainResult =
  | { ok: true; head: LedgerCheckpoint | null; done: boolean }
  | { ok: false; brokenAtSeq: number };

/**
 * Walks a user's chain, checking at most `limit` rows. `from` null starts at the chain start (seq 1 must hang off
 * GENESIS; a later first row, after retention, is its own anchor). With a checkpoint, only the rows after it are
 * read, and the first must link to it (contiguous seq and prev_hmac). `done` is false when rows remain after `limit`,
 * so a caller can continue from `head` (e.g. yielding to the event loop between batches).
 */
export function verifyLedgerChain(db: Db, crypto: Crypto, userId: UserId, from: LedgerCheckpoint | null, limit: number): LedgerChainResult {
  const refsOf = (r: Row): Refs => ({ runId: r.run_id ?? null, toolUseId: r.tool_use_id ?? null, pendingActionId: r.pending_action_id ?? null, sourceRef: r.source_ref ?? null });
  const lim = Math.max(1, Math.floor(limit));
  const sqlLimit = lim >= 1_000_000_000 ? -1 : lim + 1; // SQLite: a negative LIMIT means no limit
  const rows = from
    ? db.prepare('SELECT * FROM ledger WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all<Row>(userId, from.seq, sqlLimit)
    : db.prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY seq ASC LIMIT ?').all<Row>(userId, sqlLimit);
  const done = rows.length <= lim;
  let prevHmac: string | null = from ? from.rowHmac : null;
  let prevSeq: number | null = from ? from.seq : null;
  for (const r of done ? rows : rows.slice(0, lim)) {
    const seq = Number(r.seq);
    const broken = { ok: false as const, brokenAtSeq: seq };
    if (prevSeq === null) {
      if (seq === 1 && r.prev_hmac !== LEDGER_GENESIS) return broken;
    } else if (seq !== prevSeq + 1 || r.prev_hmac !== prevHmac) {
      return broken;
    }
    let summary: string;
    let detail: unknown = null;
    try {
      summary = crypto.openText(r.summary_enc, aadSummary(userId, seq));
      if (r.detail_enc) detail = crypto.openJson<unknown>(r.detail_enc, aadDetail(userId, seq));
    } catch {
      return broken;
    }
    const expect = crypto.hmac('ledger', ledgerRowMaterial(r.prev_hmac, { seq, ts: Number(r.ts), actor: r.actor, kind: r.kind, summary, detail, refs: refsOf(r) }));
    if (expect !== r.row_hmac) return broken;
    prevHmac = r.row_hmac;
    prevSeq = seq;
  }
  return { ok: true, head: prevSeq === null ? from : { seq: prevSeq, rowHmac: prevHmac! }, done };
}

/** The newest row of a user's chain (seq + row_hmac), or undefined for an empty ledger. */
export function ledgerHead(db: Db, userId: UserId): LedgerCheckpoint | undefined {
  const r = db.prepare('SELECT seq, row_hmac FROM ledger WHERE user_id = ? ORDER BY seq DESC LIMIT 1').get<{ seq: number; row_hmac: string }>(userId);
  return r ? { seq: Number(r.seq), rowHmac: r.row_hmac } : undefined;
}

/** row_hmac of one row, or undefined when that row no longer exists (retention, deletion). */
export function ledgerRowHmac(db: Db, userId: UserId, seq: number): string | undefined {
  return db.prepare('SELECT row_hmac FROM ledger WHERE user_id = ? AND seq = ?').get<{ row_hmac: string }>(userId, seq)?.row_hmac;
}

export function createLedgerCore(dbOf: () => Db, cryptoOf: () => Crypto, clockOf: () => Clock): Ledger {
  return {
    append(e: LedgerEntry): number {
      const db = dbOf();
      const crypto = cryptoOf();
      if (!e.userId) throw new Error('ledger.append: userId is required');
      if (!ACTORS.has(e.actor)) throw new Error(`ledger.append: bad actor ${String(e.actor)}`);
      const summary = oneLine(e.summary);
      const detail = normalizeDetail(e.detail);
      const refs: Refs = { runId: e.runId ?? null, toolUseId: e.toolUseId ?? null, pendingActionId: e.pendingActionId ?? null, sourceRef: e.sourceRef ?? null };
      return db.tx(() => {
        const last = db.prepare('SELECT seq, row_hmac FROM ledger WHERE user_id = ? ORDER BY seq DESC LIMIT 1').get<{ seq: number; row_hmac: string }>(e.userId);
        const seq = last ? Number(last.seq) + 1 : 1;
        const prev = last ? last.row_hmac : LEDGER_GENESIS;
        const ts = clockOf().now();
        const rowHmac = crypto.hmac('ledger', ledgerRowMaterial(prev, { seq, ts, actor: e.actor, kind: e.kind, summary, detail, refs }));
        const dek = `u:${e.userId}`;
        db.prepare(
          `INSERT INTO ledger(user_id, seq, ts, actor, kind, summary_enc, detail_enc, run_id, tool_use_id, pending_action_id, source_ref, prev_hmac, row_hmac)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.userId, seq, ts, e.actor, e.kind, crypto.seal(dek, summary, aadSummary(e.userId, seq)), detail === null ? null : crypto.sealJson(dek, detail, aadDetail(e.userId, seq)),
          refs.runId, refs.toolUseId, refs.pendingActionId, refs.sourceRef, prev, rowHmac,
        );
        return seq;
      });
    },

    list(userId: UserId, q) {
      const db = dbOf();
      const crypto = cryptoOf();
      const where = ['user_id = ?'];
      const params: SqlValue[] = [userId];
      if (q.cursor !== undefined && q.cursor !== null) {
        where.push('seq < ?');
        params.push(q.cursor);
      }
      if (q.kinds && q.kinds.length) {
        where.push(`kind IN (${q.kinds.map(() => '?').join(', ')})`);
        params.push(...q.kinds);
      }
      if (q.fromMs !== undefined) {
        where.push('ts >= ?');
        params.push(q.fromMs);
      }
      if (q.toMs !== undefined) {
        where.push('ts <= ?');
        params.push(q.toMs);
      }
      const limit = Math.max(0, Math.min(500, Math.floor(q.limit)));
      const rows = db.prepare(`SELECT * FROM ledger WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all<Row>(...params, limit);
      const out: Array<LedgerEntry & { seq: number; ts: number }> = [];
      for (const r of rows) {
        const seq = Number(r.seq);
        let summary: string;
        let detail: Record<string, unknown> | null = null;
        try {
          summary = crypto.openText(r.summary_enc, aadSummary(userId, seq));
          if (r.detail_enc) detail = crypto.openJson<Record<string, unknown>>(r.detail_enc, aadDetail(userId, seq));
        } catch (err) {
          if (isShredded(err)) continue;
          throw err;
        }
        out.push({
          userId, seq, ts: Number(r.ts), actor: r.actor as LedgerEntry['actor'], kind: r.kind as LedgerKind, summary,
          ...(detail !== null ? { detail } : {}),
          ...(r.run_id ? { runId: r.run_id } : {}),
          ...(r.tool_use_id ? { toolUseId: r.tool_use_id } : {}),
          ...(r.pending_action_id ? { pendingActionId: r.pending_action_id } : {}),
          ...(r.source_ref ? { sourceRef: r.source_ref } : {}),
        });
      }
      return out;
    },

    verify(userId: UserId) {
      const r = verifyLedgerChain(dbOf(), cryptoOf(), userId, null, Number.MAX_SAFE_INTEGER);
      return r.ok ? { ok: true } : { ok: false, brokenAtSeq: r.brokenAtSeq };
    },
  };
}
