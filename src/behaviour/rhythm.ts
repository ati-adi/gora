// behaviour/rhythm.ts (friend set B, spec 05 C2) — the per-user 7×24 activity model, pure functions (no SQL, no LLM).
//
// A user's inbound messages are counted per hour-of-week bin (weekday × 24 + local hour) with exponential decay
// (half-life LIMITS.rhythmHalfLifeDays, applied lazily by elapsed time). The estimate is Gamma–Poisson per bin:
//
//   λ_b = (h_b + K·p0_b) / (W + K / R0)          messages expected in bin b per week
//
// where h_b is the decayed count, W the user's effective observation window in weeks (the decayed length of time since
// their first message), p0 the pooled population histogram (normalized; a gentle default day shape counts as one extra
// "user" so a cold start is sane), R0 the population's weekly message rate and K = LIMITS.rhythmPriorWeight pseudo-
// messages. λ is then smoothed with a circular hour ±1 kernel (¼, ½, ¼) and P(active | weekday, hour) = 1 − e^(−λ_b).
import type { Ms } from '../contracts/index.ts';
import { wallTimeOf } from '../kernel/timeMath.ts';
import { HIST_BINS } from './repo.ts';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const DEFAULT_WEEKLY_RATE = 20;

/** Hour weights of the cold-start day shape (people rarely chat at 3 am). */
const DAY_SHAPE = [0.15, 0.1, 0.08, 0.06, 0.06, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 1, 1, 0.95, 0.9, 0.9, 0.9, 0.95, 1, 1, 1, 0.9, 0.7, 0.35];

export function binOf(at: Ms, tz: string): { bin: number; weekday: number; hour: number } {
  const w = wallTimeOf(at, tz);
  return { bin: w.weekday * 24 + w.hour, weekday: w.weekday, hour: w.hour };
}

/** Hours to add to a UTC hour-of-week bin to get the bin in `tz` at `at` (−84 … 84). */
export function localShift(tz: string, at: Ms): number {
  let d = (binOf(at, tz).bin - binOf(at, 'UTC').bin + HIST_BINS) % HIST_BINS;
  if (d > HIST_BINS / 2) d -= HIST_BINS;
  return d;
}

/** The histogram rotated by `d` bins (UTC → local with localShift, local → UTC with −localShift). */
export function shiftHist(h: Float64Array, d: number): Float64Array {
  const out = new Float64Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) out[(((i + d) % HIST_BINS) + HIST_BINS) % HIST_BINS] = h[i] ?? 0;
  return out;
}

export function decayFactor(elapsedMs: number, halfLifeMs: number): number {
  return elapsedMs <= 0 ? 1 : 0.5 ** (elapsedMs / halfLifeMs);
}

/** Adds one message at `at` to a histogram last updated at `updatedAt` (decays the old mass first). */
export function addMessage(hist: Float64Array | null, updatedAt: Ms | null, at: Ms, tz: string, halfLifeMs: number): { hist: Float64Array; updatedAt: Ms } {
  const h = new Float64Array(HIST_BINS);
  const { bin } = binOf(at, tz);
  if (hist && updatedAt !== null) {
    if (at >= updatedAt) {
      const f = decayFactor(at - updatedAt, halfLifeMs);
      for (let i = 0; i < HIST_BINS; i++) h[i] = (hist[i] ?? 0) * f;
      h[bin] = (h[bin] ?? 0) + 1;
      return { hist: h, updatedAt: at };
    }
    // out of order (an older message arrives late): weigh it by its age instead of decaying the rest
    for (let i = 0; i < HIST_BINS; i++) h[i] = hist[i] ?? 0;
    h[bin] = (h[bin] ?? 0) + decayFactor(updatedAt - at, halfLifeMs);
    return { hist: h, updatedAt };
  }
  h[bin] = 1;
  return { hist: h, updatedAt: at };
}

/** The histogram as it stands at `now` (decayed since its last update). */
export function decayedTo(hist: Float64Array, updatedAt: Ms, now: Ms, halfLifeMs: number): Float64Array {
  const f = decayFactor(now - updatedAt, halfLifeMs);
  const h = new Float64Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) h[i] = (hist[i] ?? 0) * f;
  return h;
}

/** The decayed length of the observation window, in weeks: ∫ 0.5^(t/HL) dt over the time since the first message. */
export function effectiveWeeks(since: Ms | null, now: Ms, halfLifeMs: number): number {
  const age = since === null ? 4 * halfLifeMs : Math.max(0, now - since);
  return ((halfLifeMs / Math.LN2) * (1 - decayFactor(age, halfLifeMs))) / WEEK;
}

export function defaultShape(): Float64Array {
  const p = new Float64Array(HIST_BINS);
  for (let d = 0; d < 7; d++) for (let hr = 0; hr < 24; hr++) p[d * 24 + hr] = DAY_SHAPE[hr]!;
  return normalize(p);
}

function normalize(h: Float64Array): Float64Array {
  let sum = 0;
  for (let i = 0; i < HIST_BINS; i++) sum += h[i] ?? 0;
  const out = new Float64Array(HIST_BINS);
  if (sum <= 0) return out.fill(1 / HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) out[i] = (h[i] ?? 0) / sum;
  return out;
}

export interface PopulationPrior { p0: Float64Array; weeklyRate: number }

/** Pools every user's normalized histogram plus the default day shape (one pseudo-user) and their mean weekly rate. */
export function populationPrior(users: Array<{ hist: Float64Array; updatedAt: Ms; since: Ms | null }>, now: Ms, halfLifeMs: number): PopulationPrior {
  const pool = defaultShape();
  const rates: number[] = [];
  for (const u of users) {
    const h = decayedTo(u.hist, u.updatedAt, now, halfLifeMs);
    let mass = 0;
    for (let i = 0; i < HIST_BINS; i++) mass += h[i] ?? 0;
    if (mass < 1e-6) continue;
    const n = normalize(h);
    for (let i = 0; i < HIST_BINS; i++) pool[i] = (pool[i] ?? 0) + (n[i] ?? 0);
    const wk = effectiveWeeks(u.since, now, halfLifeMs);
    if (wk > 0.25) rates.push(mass / wk); // a few days of data is too little to estimate a rate
  }
  const weeklyRate = rates.length ? Math.min(300, Math.max(1, rates.reduce((a, b) => a + b, 0) / rates.length)) : DEFAULT_WEEKLY_RATE;
  return { p0: normalize(pool), weeklyRate };
}

/**
 * Share of a bin's rate that is weekday-specific; the rest is the hour's average over the week. People keep their hours
 * across weekdays far more than their weekdays: a few messages on Monday at 10:00 say more about Friday at 10:00 than
 * the population prior does (without the pooling, a new owner's "active hours" would exist only on the weekdays they
 * happened to write on).
 */
export const WEEKDAY_WEIGHT = 0.5;

/** Smoothed λ per bin (messages per week in that hour-of-week). `hist` must already be decayed to `now`. */
export function rates(hist: Float64Array | null, since: Ms | null, now: Ms, prior: PopulationPrior, k: number, halfLifeMs: number): Float64Array {
  const w = hist ? effectiveWeeks(since, now, halfLifeMs) : 0;
  const denom = w + k / prior.weeklyRate;
  const bin = new Float64Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) bin[i] = ((hist?.[i] ?? 0) + k * (prior.p0[i] ?? 0)) / denom;
  const hourAvg = new Float64Array(24);
  for (let i = 0; i < HIST_BINS; i++) hourAvg[i % 24] = (hourAvg[i % 24] ?? 0) + bin[i]! / 7;
  const raw = new Float64Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) raw[i] = WEEKDAY_WEIGHT * bin[i]! + (1 - WEEKDAY_WEIGHT) * hourAvg[i % 24]!;
  const out = new Float64Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) {
    const prev = raw[(i + HIST_BINS - 1) % HIST_BINS]!;
    const next = raw[(i + 1) % HIST_BINS]!;
    out[i] = 0.25 * prev + 0.5 * raw[i]! + 0.25 * next;
  }
  return out;
}

export function pActiveOf(lambda: Float64Array, bin: number): number {
  return 1 - Math.exp(-(lambda[bin] ?? 0));
}

/**
 * The bins where proactive messages may go: in the top `fraction` of the week by λ AND at or above the weekly mean
 * (so the hours a user with a clear peak never uses are not "learned" active hours just because the prior ranks them).
 */
export function topBins(lambda: Float64Array, fraction: number): Set<number> {
  const idx = Array.from({ length: HIST_BINS }, (_, i) => i).sort((a, b) => lambda[b]! - lambda[a]! || a - b);
  const n = Math.max(1, Math.ceil(HIST_BINS * fraction));
  let mean = 0;
  for (let i = 0; i < HIST_BINS; i++) mean += lambda[i]!;
  mean /= HIST_BINS;
  const out = new Set<number>();
  for (const i of idx.slice(0, n)) if (lambda[i]! >= mean * (1 - 1e-9)) out.add(i);
  return out;
}
