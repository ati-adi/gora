// behaviour/bandit.ts (friend set B, spec 05 C4) — Thompson sampling over Beta posteriors, pure functions.
//
// Arms: one per (user, content type) 'type:<t>' and one per (user, gap bucket) 'gap:<b>'. proactive_arms stores the
// user's EVIDENCE only (alpha = replies, beta = misses + stop penalties). The prior is computed at decision time:
// a conservative base mean per arm (strength 5 pseudo-counts, "send probability starts low") updated by the pooled
// evidence of the OTHER users (hierarchical prior), with the prior strength capped at LIMITS.proactivePriorCap.
// Randomness only through the injected Random (kernel/random.ts sampleBeta), so a seeded run is reproducible.
import type { GapBucket, ProactiveContentType, Random } from '../contracts/index.ts';
import { sampleBeta } from '../kernel/random.ts';

const DAY = 86_400_000;

export function gapBucketOf(gapMs: number): GapBucket {
  const d = gapMs / DAY;
  if (d < 1) return '<1d';
  if (d < 3) return '1-2d';
  if (d < 6) return '3-5d';
  if (d < 11) return '6-10d';
  if (d < 21) return '11-20d';
  if (d < 46) return '21-45d';
  return '>45d';
}

export const typeArm = (t: ProactiveContentType) => `type:${t}`;
export const gapArm = (b: GapBucket) => `gap:${b}`;
/** proactive_log.arm / user_signals.arm. */
export const armLabel = (t: ProactiveContentType, b: GapBucket) => `${t}|${b}`;

/**
 * Base prior means before any evidence. Conservative (a friend rarely writes first) and shaped by common sense only:
 * following up on something the owner told us beats a bare check-in; right after a conversation (<1 day) is too soon.
 * The learning moves every one of these per user and across the population.
 */
export const BASE_PRIOR_MEAN: Readonly<Record<string, number>> = Object.freeze({
  'type:follow_up': 0.5, 'type:useful': 0.4, 'type:checkin': 0.3, 'type:first_hint': 0.35,
  'gap:<1d': 0.12, 'gap:1-2d': 0.3, 'gap:3-5d': 0.5, 'gap:6-10d': 0.5, 'gap:11-20d': 0.45, 'gap:21-45d': 0.3, 'gap:>45d': 0.2,
});
export const BASE_PRIOR_STRENGTH = 5;

export interface Evidence { alpha: number; beta: number }

/** The hierarchical prior of one arm: base mean updated by the other users' pooled evidence, strength ≤ cap. */
export function priorOf(arm: string, others: Evidence | undefined, cap: number): { a: number; b: number } {
  const m0 = BASE_PRIOR_MEAN[arm] ?? 0.2;
  const n0 = BASE_PRIOR_STRENGTH;
  const s = Math.max(0, others?.alpha ?? 0);
  const f = Math.max(0, others?.beta ?? 0);
  const mean = (m0 * n0 + s) / (n0 + s + f);
  const n = Math.min(cap, n0 + s + f);
  return { a: mean * n, b: (1 - mean) * n };
}

export function posteriorOf(arm: string, own: Evidence | undefined, others: Evidence | undefined, cap: number): { a: number; b: number } {
  const p = priorOf(arm, others, cap);
  return { a: p.a + Math.max(0, own?.alpha ?? 0), b: p.b + Math.max(0, own?.beta ?? 0) };
}

export const posteriorMean = (p: { a: number; b: number }) => p.a / (p.a + p.b);

export interface BanditInput {
  available: readonly ProactiveContentType[];
  gap: GapBucket;
  /** The user's evidence per arm key. */
  own: ReadonlyMap<string, Evidence>;
  /** The other users' pooled evidence per arm key. */
  others: ReadonlyMap<string, Evidence>;
  unanswered: number;
  annoyancePerUnanswered: number;
  priorCap: number;
  /** τ already scaled by the user's level. */
  threshold: number;
}
export interface BanditChoice { contentType: ProactiveContentType; score: number; thetaType: number; thetaGap: number; send: boolean }

/**
 * One Thompson decision: draw θ_type for every available content type (the largest wins) and θ_gap for the current gap
 * bucket; score = θ_gap · θ_type · (1 − annoyance), annoyance = perUnanswered × unanswered. Send iff score > threshold.
 * Draw order is fixed (content types in the given order, then the gap) so a seeded Random is reproducible.
 */
export function thompson(r: Random, i: BanditInput): BanditChoice | null {
  if (!i.available.length) return null;
  let best: { t: ProactiveContentType; theta: number } | null = null;
  for (const t of i.available) {
    const k = typeArm(t);
    const p = posteriorOf(k, i.own.get(k), i.others.get(k), i.priorCap);
    const theta = sampleBeta(r, p.a, p.b);
    if (!best || theta > best.theta) best = { t, theta };
  }
  const gk = gapArm(i.gap);
  const gp = posteriorOf(gk, i.own.get(gk), i.others.get(gk), i.priorCap);
  const thetaGap = sampleBeta(r, gp.a, gp.b);
  const annoyance = Math.min(1, Math.max(0, i.annoyancePerUnanswered * i.unanswered));
  const score = thetaGap * best!.theta * (1 - annoyance);
  return { contentType: best!.t, score, thetaType: best!.theta, thetaGap, send: score > i.threshold };
}

/** others = pooled − own (the hierarchical prior must not count the user's own evidence twice). */
export function othersOf(pooled: ReadonlyMap<string, Evidence>, own: ReadonlyMap<string, Evidence>): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  for (const [k, v] of pooled) {
    const o = own.get(k);
    out.set(k, { alpha: Math.max(0, v.alpha - (o?.alpha ?? 0)), beta: Math.max(0, v.beta - (o?.beta ?? 0)) });
  }
  return out;
}
