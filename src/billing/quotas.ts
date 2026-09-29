// billing/quotas.ts (WP1) — daily quotas, the daily cost cap, rate buckets and the refusal cooldown (01 §11.8, §13).
//
// Semantics:
//  - The quota day is the OWNER-LOCAL calendar day (users.tz, 'UTC' when unknown/invalid); usage_daily.day holds it and
//    `resetsAt` is the next local midnight (DST-aware through kernel/timeMath).
//  - check(u, k, amount = 1) → ok when used + amount ≤ limit. consume() adds `amount` to today's row. 'mission' and
//    'watcher' are live counts owned by WP6 (registerCounter); consume() is a no-op for them.
//  - 'cost_micros' is fed by recordUsage() (WP3) and capped by PlanLimits.dailyCostCapMicros; callers check it before
//    any LLM call (§11.8) and answer with the no-LLM quota template when it is exceeded.
//  - rate(key, limit, windowMs): windows shorter than 10 min are in-memory token buckets (capacity = limit, refill
//    limit/windowMs; state is lost on restart, which §11.8 accepts); longer windows are fixed windows persisted in
//    rate_buckets so an hourly guest limit survives a restart.
//  - recordRefusal(): usage_daily.refusals += 1; more than LIMITS.refusalsPerDayBeforeCooldown today starts a 1 h
//    cooldown kept in kv 'cooldown:<userId>' (removed by PrivacyService.deleteUser).
import type { Clock, Logger, Ms, PlanId, UserId } from '../contracts/common.ts';
import type { PlanLimits, QuotaKind, QuotaService } from '../contracts/billing.ts';
import type { Db } from '../contracts/storage.ts';
import { LIMITS, PLANS } from '../config.ts';
import { addDaysToDate, isValidTz, localDay, wallTimeOf, zonedToInstant } from '../kernel/timeMath.ts';
import { createUsageRepo, type UsageColumn } from '../db/repos/usage.ts';

export const QUOTA_KINDS: readonly QuotaKind[] = Object.freeze(['turn', 'web_search', 'stt_seconds', 'file', 'guest_answer', 'mission', 'watcher', 'cost_micros', 'browser']);

/** usage_daily column per daily kind (mission/watcher are counts, not daily). */
const COLUMN: Readonly<Partial<Record<QuotaKind, UsageColumn>>> = Object.freeze({
  turn: 'turns', web_search: 'web_searches', stt_seconds: 'stt_seconds', file: 'files', guest_answer: 'guest_answers', cost_micros: 'cost_micros', browser: 'browser_tasks',
});

export function planLimit(p: PlanLimits, k: QuotaKind): number {
  switch (k) {
    case 'turn': return p.turnsPerDay;
    case 'web_search': return p.webSearchesPerDay;
    case 'stt_seconds': return p.sttSecondsPerDay;
    case 'file': return p.filesPerDay;
    case 'guest_answer': return p.guestAnswersPerDay;
    case 'mission': return p.activeMissions;
    case 'watcher': return p.watchers;
    case 'cost_micros': return p.dailyCostCapMicros;
    case 'browser': return p.browserTasksPerDay;
  }
}

/** The next local midnight after `now` in tz (a DST gap at midnight shifts it forward, never backward). */
export function nextLocalMidnight(now: Ms, tz: string): Ms {
  const w = wallTimeOf(now, tz);
  const d = addDaysToDate(w.year, w.month, w.day, 1);
  return zonedToInstant({ ...d, hour: 0, minute: 0 }, tz).instant;
}

export const COOLDOWN_MS = 3_600_000;
/** Windows at or above this length are persisted in rate_buckets; shorter ones are in-memory token buckets. */
export const PERSISTED_WINDOW_MS = 10 * 60_000;
const MAX_MEMORY_BUCKETS = 50_000;
const cooldownKey = (userId: UserId) => `cooldown:${userId}`;

export interface QuotaDeps { db: () => Db; clock: () => Clock; log?: () => Logger }

export function createQuotas(d: QuotaDeps): QuotaService & { /** tests/admin */ day(userId: UserId): string; pruneRateBuckets(olderThan: Ms): number } {
  const counters = new Map<'mission' | 'watcher', (userId: UserId) => number>();
  const buckets = new Map<string, { tokens: number; at: Ms; cap: number; rate: number }>();
  const usage = () => createUsageRepo(d.db());

  const userInfo = (userId: UserId): { exists: boolean; tz: string; plan: PlanId } => {
    const r = d.db().prepare('SELECT tz, plan FROM users WHERE id = ?').get<{ tz: string; plan: string }>(userId);
    if (!r) return { exists: false, tz: 'UTC', plan: 'free' };
    const plan = (r.plan in PLANS ? r.plan : 'free') as PlanId;
    return { exists: true, tz: isValidTz(r.tz) ? r.tz : 'UTC', plan };
  };

  const countOf = (k: 'mission' | 'watcher', userId: UserId): number => {
    const fn = counters.get(k);
    if (!fn) return 0;
    try {
      const n = fn(userId);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      d.log?.().warn({ err: String(e), kind: k }, 'quota counter failed');
      return 0;
    }
  };

  const usedOf = (userId: UserId, k: QuotaKind, day: string): number => {
    if (k === 'mission' || k === 'watcher') return countOf(k, userId);
    return usage().get(userId, day)[COLUMN[k]!];
  };

  const svc = {
    day(userId: UserId): string {
      return localDay(d.clock().now(), userInfo(userId).tz);
    },

    check(userId: UserId, k: QuotaKind, amount = 1) {
      const now = d.clock().now();
      const u = userInfo(userId);
      const used = usedOf(userId, k, localDay(now, u.tz));
      const limit = planLimit(PLANS[u.plan], k);
      const amt = Number.isFinite(amount) && amount > 0 ? amount : 0;
      return { ok: used + amt <= limit, used, limit, resetsAt: nextLocalMidnight(now, u.tz) };
    },

    consume(userId: UserId, k: QuotaKind, amount = 1) {
      if (k === 'mission' || k === 'watcher') return; // live counts (WP6)
      if (!(Number.isFinite(amount) && amount > 0)) return;
      const u = userInfo(userId);
      if (!u.exists) return; // usage_daily has an FK to users; a deleted/unknown user has nothing to count
      usage().add(userId, localDay(d.clock().now(), u.tz), { [COLUMN[k]!]: amount });
    },

    view(userId: UserId) {
      const u = userInfo(userId);
      const day = localDay(d.clock().now(), u.tz);
      const row = usage().get(userId, day);
      const out = {} as Record<QuotaKind, { used: number; limit: number }>;
      for (const k of QUOTA_KINDS) {
        const used = k === 'mission' || k === 'watcher' ? countOf(k, userId) : row[COLUMN[k]!];
        out[k] = { used, limit: planLimit(PLANS[u.plan], k) };
      }
      return out;
    },

    rate(key: string, limit: number, windowMs: number): boolean {
      if (!(limit > 0) || !(windowMs > 0)) return false;
      const now = d.clock().now();
      if (windowMs < PERSISTED_WINDOW_MS) {
        const rate = limit / windowMs;
        const b = buckets.get(key);
        const tokens = b ? Math.min(limit, b.tokens + (now - b.at) * rate) : limit;
        if (buckets.size >= MAX_MEMORY_BUCKETS && !b) {
          // Drop buckets that have refilled completely: forgetting them is lossless.
          for (const [k2, v] of buckets) if (v.tokens + (now - v.at) * v.rate >= v.cap) buckets.delete(k2);
        }
        if (tokens < 1) {
          buckets.set(key, { tokens, at: now, cap: limit, rate });
          return false;
        }
        buckets.set(key, { tokens: tokens - 1, at: now, cap: limit, rate });
        return true;
      }
      const db = d.db();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      return db.tx(() => {
        const r = db.prepare('SELECT window_start, count FROM rate_buckets WHERE key = ?').get<{ window_start: number; count: number }>(key);
        if (!r || Number(r.window_start) !== windowStart) {
          db.prepare('INSERT INTO rate_buckets(key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1').run(key, windowStart);
          return true;
        }
        if (Number(r.count) >= limit) return false;
        db.prepare('UPDATE rate_buckets SET count = count + 1 WHERE key = ?').run(key);
        return true;
      });
    },

    recordUsage(userId: UserId, x: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicros: number }) {
      const u = userInfo(userId);
      if (!u.exists) return;
      usage().add(userId, localDay(d.clock().now(), u.tz), {
        input_tokens: x.inputTokens, output_tokens: x.outputTokens, cache_read_tokens: x.cacheReadTokens, cost_micros: x.costMicros,
      });
    },

    recordRefusal(userId: UserId) {
      const now = d.clock().now();
      const u = userInfo(userId);
      if (!u.exists) return { today: 0, cooldownUntil: null };
      const db = d.db();
      return db.tx(() => {
        const today = usage().add(userId, localDay(now, u.tz), { refusals: 1 }).refusals;
        let until = svc.cooldownUntil(userId);
        if (today > LIMITS.refusalsPerDayBeforeCooldown && until === null) {
          until = now + COOLDOWN_MS;
          db.prepare('INSERT INTO kv(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run(
            cooldownKey(userId), JSON.stringify(until), now,
          );
        }
        return { today, cooldownUntil: until };
      });
    },

    cooldownUntil(userId: UserId): Ms | null {
      const r = d.db().prepare('SELECT value_json FROM kv WHERE key = ?').get<{ value_json: string }>(cooldownKey(userId));
      if (!r) return null;
      const until = Number(r.value_json);
      return Number.isFinite(until) && until > d.clock().now() ? until : null;
    },

    registerCounter(k: 'mission' | 'watcher', fn: (userId: UserId) => number) {
      // Keep the first registration (only WP6b registers in production; a test may pre-register its own).
      if (counters.has(k)) {
        d.log?.().warn({ kind: k }, 'quota counter already registered; keeping the first one');
        return;
      }
      counters.set(k, fn);
    },

    pruneRateBuckets(olderThan: Ms): number {
      return Number(d.db().prepare('DELETE FROM rate_buckets WHERE window_start < ?').run(olderThan).changes);
    },
  };
  return svc;
}

/** The kv key of a user's refusal cooldown (deleted with the user). */
export { cooldownKey };
