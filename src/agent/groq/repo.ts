// agent/groq/repo.ts (WP3) — llm_rate_daily (03 R6): per-model, per-UTC-day request/token counters plus the daily limit
// and reset time last observed in the x-ratelimit-* headers. Synchronous (node:sqlite); never called inside a foreign tx.
import type { Db, Ms } from '../../contracts/index.ts';

export interface RateDailyRow { model: string; dayUtc: string; requests: number; tokens: number; rpdLimit: number | null; resetAt: Ms | null; updatedAt: Ms }

export interface RateDailyRepo {
  get(model: string, dayUtc: string): RateDailyRow | null;
  /** Adds to the counters of (model, day), creating the row. */
  add(model: string, dayUtc: string, d: { requests?: number; tokens?: number }, now: Ms): void;
  /** Records the header-observed daily limit / reset time (and lifts `requests` to at least `usedAtLeast`). */
  sync(model: string, dayUtc: string, o: { rpdLimit?: number | null; resetAt?: Ms | null; usedAtLeast?: number | null }, now: Ms): void;
  listDay(dayUtc: string): RateDailyRow[];
  /** Retention: rows older than the given day are dropped (the table is operational, not user data). */
  pruneBefore(dayUtc: string): number;
}

export function utcDay(ms: Ms): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type Raw = { model: string; day_utc: string; requests: number; tokens: number; rpd_limit: number | null; reset_at: number | null; updated_at: number };
const toRow = (r: Raw): RateDailyRow => ({ model: r.model, dayUtc: r.day_utc, requests: r.requests, tokens: r.tokens, rpdLimit: r.rpd_limit, resetAt: r.reset_at, updatedAt: r.updated_at });

export function createRateDailyRepo(db: Db): RateDailyRepo {
  return {
    get(model, dayUtc) {
      const r = db.prepare('SELECT model, day_utc, requests, tokens, rpd_limit, reset_at, updated_at FROM llm_rate_daily WHERE model = ? AND day_utc = ?').get<Raw>(model, dayUtc);
      return r ? toRow(r) : null;
    },
    add(model, dayUtc, d, now) {
      db.prepare(
        'INSERT INTO llm_rate_daily (model, day_utc, requests, tokens, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(model, day_utc) DO UPDATE SET requests = requests + excluded.requests, tokens = tokens + excluded.tokens, updated_at = excluded.updated_at',
      ).run(model, dayUtc, Math.max(0, Math.round(d.requests ?? 0)), Math.max(0, Math.round(d.tokens ?? 0)), now);
    },
    sync(model, dayUtc, o, now) {
      db.prepare(
        'INSERT INTO llm_rate_daily (model, day_utc, requests, tokens, rpd_limit, reset_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?) ' +
          'ON CONFLICT(model, day_utc) DO UPDATE SET requests = MAX(requests, excluded.requests), rpd_limit = COALESCE(excluded.rpd_limit, rpd_limit), ' +
          'reset_at = COALESCE(excluded.reset_at, reset_at), updated_at = excluded.updated_at',
      ).run(model, dayUtc, Math.max(0, Math.round(o.usedAtLeast ?? 0)), o.rpdLimit ?? null, o.resetAt ?? null, now);
    },
    listDay(dayUtc) {
      return db.prepare('SELECT model, day_utc, requests, tokens, rpd_limit, reset_at, updated_at FROM llm_rate_daily WHERE day_utc = ? ORDER BY model').all<Raw>(dayUtc).map(toRow);
    },
    pruneBefore(dayUtc) {
      return Number(db.prepare('DELETE FROM llm_rate_daily WHERE day_utc < ?').run(dayUtc).changes);
    },
  };
}
