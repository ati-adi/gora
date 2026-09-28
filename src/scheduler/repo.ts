// scheduler/repo.ts (WP6a) — the only SQL over `jobs` (01 §7.2: WP6 owns it).
import type { Db, SqlValue } from '../contracts/storage.ts';
import type { JobKind, JobPayload, JobRow, NewJob } from '../contracts/scheduler.ts';
import type { Ms, UserId } from '../contracts/common.ts';
import { ulid } from '../kernel/ids.ts';

export type JobStatus = 'scheduled' | 'leased' | 'done' | 'failed' | 'dead' | 'cancelled';

interface RawJob {
  id: string; kind: string; user_id: string | null; ref_id: string | null; run_at: number; cron: string | null; tz: string | null;
  payload_json: string; status: JobStatus; priority: number; lease_until: number | null; attempts: number; max_attempts: number;
  last_error: string | null; dedupe_key: string | null; created_at: number; updated_at: number;
}

export interface StoredJob extends JobRow { status: JobStatus; priority: number; leaseUntil: Ms | null; dedupeKey: string | null; lastError: string | null }

function parsePayload(s: string): JobPayload {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as JobPayload) : {};
  } catch {
    return {};
  }
}

function toRow(r: RawJob): StoredJob {
  return {
    id: r.id, kind: r.kind as JobKind, runAt: Number(r.run_at), userId: r.user_id, refId: r.ref_id, cron: r.cron, tz: r.tz,
    payload: parsePayload(r.payload_json), attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
    status: r.status, priority: Number(r.priority), leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
    dedupeKey: r.dedupe_key, lastError: r.last_error,
  };
}

/** Payloads hold ids and enums only (01 §7.1): scalars are kept, anything else is rejected. */
export function checkPayload(p: JobPayload | undefined): string {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    else throw new TypeError(`job payload field ${k} must be a scalar`);
    if (typeof v === 'string' && v.length > 200) throw new TypeError(`job payload field ${k} is too long (ids and enums only)`);
  }
  return JSON.stringify(out);
}

export function createJobsRepo(db: Db) {
  const byId = (id: string): StoredJob | undefined => {
    const r = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get<RawJob>(id);
    return r ? toRow(r) : undefined;
  };
  const byDedupe = (key: string): StoredJob | undefined => {
    const r = db.prepare(`SELECT * FROM jobs WHERE dedupe_key = ?`).get<RawJob>(key);
    return r ? toRow(r) : undefined;
  };

  return {
    byId,
    byDedupe,

    /**
     * Insert, or upsert by dedupe key. An existing row with the same key is re-armed with the new values: a finished row
     * (done/dead/failed/cancelled) becomes 'scheduled' again; a 'scheduled' row is updated in place; a 'leased' row keeps its
     * lease (the running handler owns it) and reports `leased: true` so the scheduler re-arms it when the handler returns.
     * A 'scheduled' recurring row upserted again with the same cron and zone keeps an earlier run_at: re-registering a
     * system cron job at boot must not drop a run that came due while the process was down (01 §8.2 coalescing).
     */
    upsert(j: NewJob & { runAt: Ms; now: Ms }): { id: string; leased: boolean } {
      const payload = checkPayload(j.payload);
      const priority = j.priority ?? 5;
      const maxAttempts = j.maxAttempts ?? 5;
      const existing = j.dedupeKey ? byDedupe(j.dedupeKey) : undefined;
      if (existing) {
        const leased = existing.status === 'leased';
        const sameSeries = existing.status === 'scheduled' && !!existing.cron && existing.cron === (j.cron ?? null) && existing.tz === (j.tz ?? null);
        const runAt = sameSeries && existing.runAt < j.runAt ? existing.runAt : j.runAt;
        db.prepare(
          `UPDATE jobs SET kind = ?, user_id = ?, ref_id = ?, run_at = ?, cron = ?, tz = ?, payload_json = ?, priority = ?, max_attempts = ?,
             status = CASE WHEN status = 'leased' THEN 'leased' ELSE 'scheduled' END,
             attempts = CASE WHEN status = 'leased' THEN attempts ELSE 0 END,
             lease_until = CASE WHEN status = 'leased' THEN lease_until ELSE NULL END,
             last_error = NULL, updated_at = ? WHERE id = ?`,
        ).run(j.kind, j.userId ?? null, j.refId ?? null, runAt, j.cron ?? null, j.tz ?? null, payload, priority, maxAttempts, j.now, existing.id);
        return { id: existing.id, leased };
      }
      const id = `job_${ulid(j.now)}`;
      db.prepare(
        `INSERT INTO jobs (id, kind, user_id, ref_id, run_at, cron, tz, payload_json, status, priority, lease_until, attempts, max_attempts, last_error, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, NULL, 0, ?, NULL, ?, ?, ?)`,
      ).run(id, j.kind, j.userId ?? null, j.refId ?? null, j.runAt, j.cron ?? null, j.tz ?? null, payload, priority, maxAttempts, j.dedupeKey ?? null, j.now, j.now);
      return { id, leased: false };
    },

    /** Cancels a scheduled or leased job by id or dedupe key; returns the ids cancelled. */
    cancel(idOrKey: string, now: Ms): string[] {
      const rows = db
        .prepare(`UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE (id = ? OR dedupe_key = ?) AND status IN ('scheduled','leased') RETURNING id`)
        .all<{ id: string }>(now, idOrKey, idOrKey);
      return rows.map((r) => r.id);
    },

    /** Lease heartbeat: the jobs whose handlers still run in this process keep their lease (never re-claimed mid-run). */
    extendLeases(ids: readonly string[], until: Ms, ifBefore: Ms, now: Ms): number {
      if (!ids.length) return 0;
      return Number(
        db
          .prepare(`UPDATE jobs SET lease_until = ?, updated_at = ? WHERE status = 'leased' AND (lease_until IS NULL OR lease_until < ?) AND id IN (SELECT value FROM json_each(?))`)
          .run(until, now, ifBefore, JSON.stringify(ids)).changes,
      );
    },

    /** Expired leases go back to 'scheduled' (01 §8.2, on every tick). */
    releaseExpired(now: Ms): number {
      return Number(db.prepare(`UPDATE jobs SET status = 'scheduled', lease_until = NULL, updated_at = ? WHERE status = 'leased' AND lease_until < ?`).run(now, now).changes);
    },

    /** Due scheduled jobs of the given kinds get pushed to `runAt` (the LLM budget said no). */
    deferKinds(kinds: readonly JobKind[], now: Ms, runAt: Ms): number {
      if (!kinds.length) return 0;
      return Number(
        db
          .prepare(`UPDATE jobs SET run_at = ?, updated_at = ? WHERE status = 'scheduled' AND run_at <= ? AND kind IN (SELECT value FROM json_each(?))`)
          .run(runAt, now, now, JSON.stringify(kinds)).changes,
      );
    },

    /** 01 §8.2 claim: atomically leases up to `limit` due jobs of the given kinds, by priority then run_at. */
    claim(kinds: readonly JobKind[], now: Ms, leaseMs: number, limit: number): StoredJob[] {
      if (!kinds.length) return [];
      const rows = db
        .prepare(
          `UPDATE jobs SET status = 'leased', lease_until = ?, attempts = attempts + 1, updated_at = ?
           WHERE id IN (SELECT id FROM jobs WHERE status = 'scheduled' AND run_at <= ? AND kind IN (SELECT value FROM json_each(?)) ORDER BY priority, run_at LIMIT ?)
           RETURNING *`,
        )
        .all<RawJob>(now + leaseMs, now, now, JSON.stringify(kinds), limit);
      return rows.map(toRow).sort((a, b) => a.priority - b.priority || a.runAt - b.runAt);
    },

    /** Earliest instant something may need attention: a due scheduled job of these kinds, or a lease expiry. */
    nextWake(kinds: readonly JobKind[]): Ms | null {
      const a = db.prepare(`SELECT MIN(run_at) AS t FROM jobs WHERE status = 'scheduled' AND kind IN (SELECT value FROM json_each(?))`).get<{ t: number | null }>(JSON.stringify(kinds));
      const b = db.prepare(`SELECT MIN(lease_until) AS t FROM jobs WHERE status = 'leased'`).get<{ t: number | null }>();
      const xs = [a?.t, b?.t].filter((x): x is number => typeof x === 'number');
      return xs.length ? Math.min(...xs) : null;
    },

    /** Finishes a leased job (CAS on status='leased' so a cancel during the run wins). */
    finish(id: string, patch: { status: JobStatus; runAt?: Ms; attempts?: number; lastError?: string | null }, now: Ms): boolean {
      const sets: string[] = ['status = ?', 'lease_until = NULL', 'updated_at = ?'];
      const params: SqlValue[] = [patch.status, now];
      if (patch.runAt !== undefined) {
        sets.push('run_at = ?');
        params.push(patch.runAt);
      }
      if (patch.attempts !== undefined) {
        sets.push('attempts = ?');
        params.push(patch.attempts);
      }
      if (patch.lastError !== undefined) {
        sets.push('last_error = ?');
        params.push(patch.lastError === null ? null : patch.lastError.slice(0, 300));
      }
      params.push(id);
      return Number(db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND status = 'leased'`).run(...params).changes) > 0;
    },

    list(q: { userId: UserId; kinds?: JobKind[]; limit: number }): StoredJob[] {
      const rows = q.kinds
        ? db
            .prepare(`SELECT * FROM jobs WHERE user_id = ? AND status IN ('scheduled','leased') AND kind IN (SELECT value FROM json_each(?)) ORDER BY run_at, id LIMIT ?`)
            .all<RawJob>(q.userId, JSON.stringify(q.kinds), q.limit)
        : db.prepare(`SELECT * FROM jobs WHERE user_id = ? AND status IN ('scheduled','leased') ORDER BY run_at, id LIMIT ?`).all<RawJob>(q.userId, q.limit);
      return rows.map(toRow);
    },

    /** Active (scheduled/leased) jobs of a user and kinds; used by rescheduling after a tz change. */
    activeFor(userId: UserId, kinds: readonly JobKind[]): StoredJob[] {
      return db
        .prepare(`SELECT * FROM jobs WHERE user_id = ? AND status IN ('scheduled','leased') AND kind IN (SELECT value FROM json_each(?))`)
        .all<RawJob>(userId, JSON.stringify(kinds))
        .map(toRow);
    },

    cancelAllForUser(userId: UserId, now: Ms): number {
      return Number(db.prepare(`UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE user_id = ? AND status IN ('scheduled','leased')`).run(now, userId).changes);
    },

    /** Retention: finished rows older than `before` (keeps rows that still hold a dedupe key re-armed later). */
    purgeFinished(before: Ms): number {
      return Number(db.prepare(`DELETE FROM jobs WHERE status IN ('done','dead','cancelled','failed') AND updated_at < ?`).run(before).changes);
    },
  };
}
export type JobsRepo = ReturnType<typeof createJobsRepo>;
