// db/repos/usage.ts (WP1) — usage_daily counters per (user, owner-local day). Used by billing/quotas.ts.
import type { UserId } from '../../contracts/common.ts';
import type { Db } from '../../contracts/storage.ts';
import { num } from './common.ts';

export type UsageColumn =
  | 'turns' | 'web_searches' | 'stt_seconds' | 'files' | 'guest_answers' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cost_micros' | 'nudges_sent' | 'refusals'
  | 'browser_tasks'; // s07 (004)
export const USAGE_COLUMNS: readonly UsageColumn[] = Object.freeze([
  'turns', 'web_searches', 'stt_seconds', 'files', 'guest_answers', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cost_micros', 'nudges_sent', 'refusals', 'browser_tasks',
]);
export type UsageDay = Record<UsageColumn, number>;
const ZERO: Readonly<UsageDay> = Object.freeze(Object.fromEntries(USAGE_COLUMNS.map((c) => [c, 0])) as UsageDay);

export interface UsageRepo {
  get(userId: UserId, day: string): UsageDay;
  /** Adds the given amounts (integers; negatives are ignored) in one upsert and returns the new row. */
  add(userId: UserId, day: string, delta: Partial<UsageDay>): UsageDay;
}

export function createUsageRepo(db: Db): UsageRepo {
  const get = (userId: UserId, day: string): UsageDay => {
    const r = db.prepare('SELECT * FROM usage_daily WHERE user_id = ? AND day = ?').get<Record<string, number>>(userId, day);
    if (!r) return { ...ZERO };
    return Object.fromEntries(USAGE_COLUMNS.map((c) => [c, num(r[c] ?? 0)])) as UsageDay;
  };
  return {
    get,
    add(userId, day, delta) {
      const cols = USAGE_COLUMNS.filter((c) => typeof delta[c] === 'number' && Number.isFinite(delta[c]) && delta[c]! > 0);
      if (cols.length) {
        const vals = cols.map((c) => Math.round(delta[c]!));
        db.prepare(
          `INSERT INTO usage_daily(user_id, day, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
           ON CONFLICT(user_id, day) DO UPDATE SET ${cols.map((c) => `${c} = ${c} + excluded.${c}`).join(', ')}`,
        ).run(userId, day, ...vals);
      }
      return get(userId, day);
    },
  };
}
