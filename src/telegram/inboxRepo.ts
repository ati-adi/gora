// telegram/inboxRepo.ts (WP2) — the durable inbox (table tg_updates, 01 §4.1). Payloads are sealed under the 'sys' DEK with
// AAD 'tg_updates|payload_enc|<update_id>'; retention (§11.9): payload nulled after 24 h, row deleted after 72 h.
// `lease_until` doubles as the not-before instant of a queued row that is waiting for a retry.
import type { Update } from 'grammy/types';
import type { Crypto, Db, Ms } from '../contracts/index.ts';

export interface InboxRow { updateId: number; kind: string; lane: string; status: string; attempts: number; receivedAt: Ms; leaseUntil: Ms | null }

const aad = (id: number) => `tg_updates|payload_enc|${id}`;

export function createInboxRepo(db: Db, crypto: Crypto) {
  const toRow = (r: Record<string, unknown>): InboxRow => ({
    updateId: Number(r['update_id']), kind: String(r['kind']), lane: String(r['lane']), status: String(r['status']),
    attempts: Number(r['attempts']), receivedAt: Number(r['received_at']), leaseUntil: r['lease_until'] === null ? null : Number(r['lease_until']),
  });
  return {
    /** INSERT OR IGNORE keyed on update_id; true when the update is new. */
    insert(u: Update, kind: string, lane: string, now: Ms, status: 'queued' | 'skipped' = 'queued'): boolean {
      const payload = crypto.sealJson('sys', u, aad(u.update_id));
      const r = db
        .prepare('INSERT OR IGNORE INTO tg_updates (update_id, kind, lane, payload_enc, status, attempts, received_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(u.update_id, kind, lane, payload, status, now);
      return Number(r.changes) > 0;
    },
    /** Queued rows that are due, oldest first. */
    due(now: Ms, limit: number): InboxRow[] {
      return db
        .prepare(`SELECT update_id, kind, lane, status, attempts, received_at, lease_until FROM tg_updates
                  WHERE status = 'queued' AND (lease_until IS NULL OR lease_until <= ?) ORDER BY received_at, update_id LIMIT ?`)
        .all(now, limit)
        .map(toRow);
    },
    /** Due rows of one lane (the control lane runs every row concurrently), oldest first. */
    dueInLane(lane: string, now: Ms, limit: number): InboxRow[] {
      return db
        .prepare(`SELECT update_id, kind, lane, status, attempts, received_at, lease_until FROM tg_updates
                  WHERE status = 'queued' AND lane = ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY received_at, update_id LIMIT ?`)
        .all(lane, now, limit)
        .map(toRow);
    },
    /**
     * The first queued row of every lane except `exceptLane` (serial lanes run in update_id order), when it is due,
     * oldest first. One row per lane, so a long backlog in one lane never hides other lanes (review F6).
     */
    laneHeads(now: Ms, limit: number, exceptLane: string): InboxRow[] {
      return db
        .prepare(`SELECT update_id, kind, lane, status, attempts, received_at, lease_until FROM tg_updates
                  WHERE update_id IN (SELECT MIN(update_id) FROM tg_updates WHERE status = 'queued' AND lane <> ? GROUP BY lane)
                    AND (lease_until IS NULL OR lease_until <= ?) ORDER BY received_at, update_id LIMIT ?`)
        .all(exceptLane, now, limit)
        .map(toRow);
    },
    /** CAS queued → processing; false when another worker took it. */
    claim(updateId: number, now: Ms, leaseMs: number): boolean {
      const r = db
        .prepare(`UPDATE tg_updates SET status = 'processing', attempts = attempts + 1, lease_until = ? WHERE update_id = ? AND status = 'queued'`)
        .run(now + leaseMs, updateId);
      return Number(r.changes) === 1;
    },
    payload(updateId: number): Update | null {
      const r = db.prepare('SELECT payload_enc FROM tg_updates WHERE update_id = ?').get<{ payload_enc: Uint8Array | null }>(updateId);
      if (!r?.payload_enc) return null;
      return crypto.openJson<Update>(r.payload_enc, aad(updateId));
    },
    finish(updateId: number, status: 'done' | 'skipped' | 'failed', now: Ms, error?: string): void {
      db.prepare('UPDATE tg_updates SET status = ?, done_at = ?, lease_until = NULL, error = ? WHERE update_id = ?').run(status, now, error ?? null, updateId);
    },
    /** Back to queued, not before `notBefore` (retry with backoff). */
    requeue(updateId: number, notBefore: Ms, error: string): void {
      db.prepare(`UPDATE tg_updates SET status = 'queued', lease_until = ?, error = ? WHERE update_id = ?`).run(notBefore, error, updateId);
    },
    /** Boot: rows a crashed process left in 'processing' go back to the queue (handlers are idempotent per update_id). */
    resetProcessing(): number {
      const r = db.prepare(`UPDATE tg_updates SET status = 'queued', lease_until = NULL WHERE status = 'processing'`).run();
      return Number(r.changes);
    },
    oldestQueuedAt(): Ms | null {
      const r = db.prepare(`SELECT MIN(received_at) AS t FROM tg_updates WHERE status IN ('queued', 'processing')`).get<{ t: number | null }>();
      return r?.t ?? null;
    },
    status(updateId: number): string | null {
      const r = db.prepare('SELECT status FROM tg_updates WHERE update_id = ?').get<{ status: string }>(updateId);
      return r?.status ?? null;
    },
    /** §11.9: payloads nulled after 24 h, rows deleted after 72 h (terminal rows only for the delete). */
    retention(now: Ms): { nulled: number; deleted: number } {
      const nulled = db.prepare('UPDATE tg_updates SET payload_enc = NULL WHERE payload_enc IS NOT NULL AND received_at < ?').run(now - 24 * 3600_000);
      const deleted = db.prepare(`DELETE FROM tg_updates WHERE received_at < ? AND status IN ('done', 'skipped', 'failed')`).run(now - 72 * 3600_000);
      return { nulled: Number(nulled.changes), deleted: Number(deleted.changes) };
    },
  };
}
export type InboxRepo = ReturnType<typeof createInboxRepo>;
