// proactive/nudgeGate.ts (WP6b) — the NudgeGate of 01 §8.4, pure. Checked in this order:
//  1. user not paused and not blocked;  2. kind not muted, snooze_until passed;  3. dedupe (same dedupe_key sent in the
//  last 7 days);  4. score × weight ≥ 0.4 (≥ 0.7 when ignored_streak ≥ 3);  5. budget (sent today, local day, with
//  counts_against_budget < nudge_budget);  6. quiet hours: high/normal deferred to nextOutsideQuiet + ≤ 10 min jitter,
//  low dropped.
import type { Ms, NudgeCandidate } from '../contracts/index.ts';
import { sha256Hex } from '../missions/watcherConditions.ts';

export const SCORE_MIN = 0.4;
export const SCORE_MIN_BACKOFF = 0.7;
export const BACKOFF_STREAK = 3;
export const DEDUPE_MS = 7 * 86_400_000;
export const JITTER_MAX_MS = 10 * 60_000;
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 1.5;

export interface NudgePref { muted: boolean; snoozeUntil: Ms | null; weight: number; ignoredStreak: number }
export const DEFAULT_PREF: Readonly<NudgePref> = Object.freeze({ muted: false, snoozeUntil: null, weight: 1, ignoredStreak: 0 });

export interface GateInput {
  now: Ms;
  userActive: boolean; // status 'active' and not bot_blocked
  pref: NudgePref;
  dedupeHit: boolean;
  candidate: Pick<NudgeCandidate, 'score' | 'priority' | 'countsAgainstBudget'>;
  sentToday: number; // sent today (owner-local day) with counts_against_budget
  budget: number; // effective nudge_budget (0..plan max)
  inQuiet: boolean;
}

export type DropReason = 'inactive' | 'proactive_cap' | 'muted' | 'snoozed' | 'dedupe' | 'score' | 'budget' | 'quiet_low';
export type GateResult = { action: 'send' } | { action: 'defer' } | { action: 'drop'; reason: DropReason };

export function gate(i: GateInput): GateResult {
  if (!i.userActive) return { action: 'drop', reason: 'inactive' };
  if (i.pref.muted) return { action: 'drop', reason: 'muted' };
  if (i.pref.snoozeUntil !== null && i.pref.snoozeUntil > i.now) return { action: 'drop', reason: 'snoozed' };
  if (i.dedupeHit) return { action: 'drop', reason: 'dedupe' };
  const min = i.pref.ignoredStreak >= BACKOFF_STREAK ? SCORE_MIN_BACKOFF : SCORE_MIN;
  // round away float noise such as 0.4 × 1.0000000001
  if (Math.round(i.candidate.score * i.pref.weight * 1e9) / 1e9 < min) return { action: 'drop', reason: 'score' };
  if (i.candidate.countsAgainstBudget && i.sentToday >= i.budget) return { action: 'drop', reason: 'budget' };
  if (i.inQuiet) return i.candidate.priority === 'low' ? { action: 'drop', reason: 'quiet_low' } : { action: 'defer' };
  return { action: 'send' };
}

/** Effective budget: the user's setting clamped to 0..plan max. */
export function effectiveBudget(setting: number, planMax: number): number {
  const v = Number.isFinite(setting) ? Math.floor(setting) : 3;
  return Math.max(0, Math.min(v, planMax));
}

/** Deterministic jitter in [0, JITTER_MAX_MS] derived from the nudge id (spreads deferred nudges; reproducible in tests). */
export function jitterFor(id: string): Ms {
  return parseInt(sha256Hex(`jitter:${id}`).slice(0, 8), 16) % (JITTER_MAX_MS + 1);
}

export function clampWeight(w: number): number {
  return Math.round(Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w)) * 100) / 100;
}
