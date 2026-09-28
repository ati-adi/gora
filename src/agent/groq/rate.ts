// agent/groq/rate.ts (WP3) — 03 R6 RateGovernor: per-model TPM/RPM sliding windows synchronised from x-ratelimit-*
// headers, daily (RPD) counters in llm_rate_daily, priorities, the per-role fallback chain and the busy wait.
//
// acquire(role, model, estTokens, priority):
//   1. the call fits the model's buckets → go now;
//   2. interactive and the wait ≤ 4 s → wait, then go;
//   3. a model of the role's fallback chain fits now → go with it (main 120b → qwen → 20b; fast 20b → 120b);
//   4. interactive → onBusy(seconds) ("⏳ Busy — retrying in Ns") and wait up to 45 s for the first model that frees up;
//   5. else TransientLlmError('rate_limit') (the scheduler / engine re-queue with backoff).
// Lower priorities keep a reserve of each bucket free for interactive calls (priority deferral).
import type { Clock, GroqRole, Logger, Ms, Priority, RateGovernor } from '../../contracts/index.ts';
import { AbortedError, TransientLlmError } from '../../kernel/errors.ts';
import type { RateDailyRepo } from './repo.ts';
import { utcDay } from './repo.ts';

export interface ModelLimits { tpm: number; rpm: number; rpd: number }

const WINDOW_MS = 60_000;

/** Free-tier defaults (02 §B, 03 R6); whisper 20 RPM / 2 000 RPD, prompt guard 30 RPM / 14 400 RPD. */
export function defaultLimits(tier: 'free' | 'dev', role: GroqRole | null): ModelLimits {
  if (tier === 'dev') {
    if (role === 'stt') return { tpm: Number.POSITIVE_INFINITY, rpm: 300, rpd: 200_000 };
    if (role === 'tts') return { tpm: 50_000, rpm: 250, rpd: 100_000 };
    return { tpm: 250_000, rpm: 1_000, rpd: 500_000 };
  }
  if (role === 'stt') return { tpm: Number.POSITIVE_INFINITY, rpm: 20, rpd: 2_000 };
  if (role === 'guard') return { tpm: 15_000, rpm: 30, rpd: 14_400 };
  if (role === 'tts') return { tpm: 1_200, rpm: 10, rpd: 100 };
  return { tpm: 8_000, rpm: 30, rpd: 1_000 };
}

/** Share of each bucket a priority must leave free (interactive and approval may use everything). */
export const PRIORITY_RESERVE: Readonly<Record<Priority, number>> = Object.freeze({ interactive: 0, approval: 0, reminder: 0.1, background: 0.25, proactive: 0.4 });

/**
 * Parses Groq reset durations: '2.085s', '1m26.4s', '7h12m0s', '450ms', '0s' (also a bare number of seconds).
 * Returns milliseconds, or null when unparseable.
 */
export function parseResetDuration(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/gy;
  let ms = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    ms += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
    pos = re.lastIndex;
  }
  if (pos !== s.length || pos === 0) return null;
  return Math.round(ms);
}

function header(h: Headers | Record<string, string | undefined> | null | undefined, name: string): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const rec = h as Record<string, string | undefined>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name);
  return k ? (rec[k] ?? null) : null;
}

const num = (v: string | null): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A header snapshot of a replenishing bucket: `remaining` at `obsAt`, full (`limit`) again at `resetAt`. */
interface HeaderBucket { limit: number; remaining: number; obsAt: Ms; resetAt: Ms }

interface Reservation { at: Ms; tokens: number; settled: boolean }

interface ModelState {
  model: string;
  role: GroqRole | null;
  limits: ModelLimits;
  events: Reservation[];
  tok: HeaderBucket | null;
  req: HeaderBucket | null; // Groq's x-ratelimit-*-requests is the DAILY bucket
  penaltyUntil: Ms;
  day: string;
  dayRequests: number;
  dayTokens: number;
  dayLimit: number | null;
}

export interface RateGovernorImpl extends RateGovernor {
  /** Fraction of the model's daily request budget in use (0..1+). */
  dailyUse(model: string): number;
  snapshot(): Record<string, { rpdUsed: number; rpdLimit: number; tpmRemaining: number }>;
  /** Seconds until `estTokens` fits `model` (0 = now; Infinity = not today). Tests and diagnostics. */
  waitMs(model: string, estTokens: number, priority: Priority): number;
  /** The fallback chain tried for a role, starting with `model`. */
  chain(role: GroqRole, model: string): string[];
}

export interface RateGovernorOpts {
  clock: Clock;
  log: Logger;
  repo: RateDailyRepo | null;
  tier: 'free' | 'dev';
  models: { main: string; fast: string; vision: string; sentinel: string; guard: string; stt: string; tts: string };
  interactiveWaitMs: number; // 4 000
  busyWaitMaxMs: number; // 45 000
  limits?: Partial<Record<string, Partial<ModelLimits>>>;
}

export function createRateGovernor(o: RateGovernorOpts): RateGovernorImpl {
  const states = new Map<string, ModelState>();
  const roleOf = (model: string): GroqRole | null => {
    for (const r of ['main', 'fast', 'vision', 'sentinel', 'guard', 'stt', 'tts'] as const) if (o.models[r] === model) return r;
    return null;
  };

  function state(model: string, role?: GroqRole | null): ModelState {
    let st = states.get(model);
    const now = o.clock.now();
    const day = utcDay(now);
    if (!st) {
      const r = role ?? roleOf(model);
      const limits = { ...defaultLimits(o.tier, r), ...(o.limits?.[model] ?? {}) };
      st = { model, role: r, limits, events: [], tok: null, req: null, penaltyUntil: 0, day, dayRequests: 0, dayTokens: 0, dayLimit: null };
      loadDay(st, day);
      states.set(model, st);
    } else if (st.day !== day) {
      st.day = day;
      st.dayRequests = 0;
      st.dayTokens = 0;
      loadDay(st, day);
    }
    return st;
  }

  function loadDay(st: ModelState, day: string) {
    try {
      const row = o.repo?.get(st.model, day);
      if (row) {
        st.dayRequests = row.requests;
        st.dayTokens = row.tokens;
        st.dayLimit = row.rpdLimit;
      }
    } catch (e) {
      o.log.warn({ err: e, model: st.model }, 'llm_rate_daily read failed');
    }
  }

  function persist(fn: (r: RateDailyRepo) => void) {
    if (!o.repo) return;
    try {
      fn(o.repo);
    } catch (e) {
      o.log.warn({ err: e }, 'llm_rate_daily write failed');
    }
  }

  const prune = (st: ModelState, now: Ms) => {
    while (st.events.length && st.events[0]!.at <= now - WINDOW_MS) st.events.shift();
  };

  /** Header bucket value at time t, replenishing linearly towards `limit` until `resetAt`. */
  const hdrAt = (b: HeaderBucket, t: Ms): number => {
    if (t >= b.resetAt) return b.limit;
    const span = b.resetAt - b.obsAt;
    if (span <= 0) return b.limit;
    return b.remaining + (b.limit - b.remaining) * Math.max(0, (t - b.obsAt) / span);
  };
  const reservedSince = (st: ModelState, since: Ms, what: 'tokens' | 'requests') => st.events.filter((e) => e.at > since).reduce((a, e) => a + (what === 'tokens' ? e.tokens : 1), 0);

  function rpdLimit(st: ModelState): number {
    return st.req?.limit ?? st.dayLimit ?? st.limits.rpd;
  }
  function rpdUsed(st: ModelState, now: Ms): number {
    if (st.req && now < st.req.resetAt) return Math.max(0, Math.round(st.req.limit - hdrAt(st.req, now)) + reservedSince(st, st.req.obsAt, 'requests'));
    if (st.req && now >= st.req.resetAt) return reservedSince(st, st.req.resetAt, 'requests');
    return st.dayRequests;
  }
  function tpmRemaining(st: ModelState, t: Ms): number {
    const inWindow = st.events.filter((e) => e.at > t - WINDOW_MS).reduce((a, e) => a + e.tokens, 0);
    let rem = st.limits.tpm - inWindow;
    if (st.tok) rem = Math.min(rem, hdrAt(st.tok, t) - reservedSince(st, st.tok.obsAt, 'tokens'));
    return rem;
  }
  function rpmRemaining(st: ModelState, t: Ms): number {
    return st.limits.rpm - st.events.filter((e) => e.at > t - WINDOW_MS).length;
  }

  function fitsAt(st: ModelState, t: Ms, est: number, p: Priority): boolean {
    if (t < st.penaltyUntil) return false;
    const reserve = PRIORITY_RESERVE[p];
    const limit = rpdLimit(st);
    if (rpdUsed(st, t) + 1 > limit * (1 - reserve)) return false;
    const tpm = st.limits.tpm;
    // a request larger than the whole TPM can never fit: let it go on an empty bucket (the API answers 413; R2 shrinks)
    const need = Math.min(est, tpm * (1 - reserve));
    if (Number.isFinite(tpm) && tpmRemaining(st, t) - need < tpm * reserve) return false;
    if (rpmRemaining(st, t) - 1 < st.limits.rpm * reserve) return false;
    return true;
  }

  function waitMs(model: string, estTokens: number, p: Priority): number {
    const st = state(model);
    const now = o.clock.now();
    prune(st, now);
    if (fitsAt(st, now, estTokens, p)) return 0;
    const cands = new Set<number>();
    if (st.penaltyUntil > now) cands.add(st.penaltyUntil);
    for (const e of st.events) cands.add(e.at + WINDOW_MS + 1);
    for (const b of [st.tok, st.req]) {
      if (!b) continue;
      cands.add(b.resetAt);
      const span = b.resetAt - b.obsAt;
      if (span > 0 && b.limit > b.remaining) for (const f of [0.1, 0.25, 0.5, 0.75]) cands.add(Math.ceil(b.obsAt + span * f));
    }
    const sorted = [...cands].filter((t) => t > now).sort((a, b) => a - b);
    for (const t of sorted) if (fitsAt(st, t, estTokens, p)) return t - now;
    return Number.POSITIVE_INFINITY;
  }

  function reserve(model: string, est: number) {
    const st = state(model);
    const now = o.clock.now();
    st.events.push({ at: now, tokens: Math.max(0, Math.round(est)), settled: false });
    st.dayRequests += 1;
    persist((r) => r.add(model, st.day, { requests: 1 }, now));
  }

  function chain(role: GroqRole, model: string): string[] {
    const m = o.models;
    const base = role === 'main' ? [m.main, m.vision, m.fast] : role === 'fast' ? [m.fast, m.main] : [model];
    const out = [model, ...base.filter((x) => x !== model)];
    return [...new Set(out)];
  }

  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
  };

  return {
    chain,
    waitMs,
    async acquire(q) {
      throwIfAborted(q.signal);
      state(q.model, q.role);
      const models = chain(q.role, q.model);
      const interactive = q.priority === 'interactive';
      // 1. fits now
      const w0 = waitMs(q.model, q.estTokens, q.priority);
      if (w0 === 0) {
        reserve(q.model, q.estTokens);
        return { model: q.model };
      }
      // 2. interactive short wait
      if (interactive && w0 <= o.interactiveWaitMs) {
        await o.clock.sleep(w0, q.signal);
        if (waitMs(q.model, q.estTokens, q.priority) === 0) {
          reserve(q.model, q.estTokens);
          return { model: q.model };
        }
      }
      // 3. fallback chain
      for (const fb of models.slice(1)) {
        state(fb, q.role === 'main' || q.role === 'fast' ? roleOf(fb) : q.role);
        if (waitMs(fb, q.estTokens, q.priority) === 0) {
          reserve(fb, q.estTokens);
          o.log.info({ from: q.model, to: fb, priority: q.priority }, 'rate governor fallback');
          return { model: fb };
        }
      }
      // 4. interactive busy wait (≤ 45 s)
      if (interactive) {
        const deadline = o.clock.now() + o.busyWaitMaxMs;
        let announced = -1;
        for (;;) {
          throwIfAborted(q.signal);
          let best: { model: string; wait: number } | null = null;
          for (const m of models) {
            const w = waitMs(m, q.estTokens, q.priority);
            if (!best || w < best.wait) best = { model: m, wait: w };
          }
          if (best && best.wait === 0) {
            reserve(best.model, q.estTokens);
            return { model: best.model };
          }
          const remaining = deadline - o.clock.now();
          if (!best || !Number.isFinite(best.wait) || best.wait > remaining) {
            throw new TransientLlmError('rate_limit', `rate limited on ${q.model}`, { retryAfterMs: best && Number.isFinite(best.wait) ? best.wait : null });
          }
          const sec = Math.max(1, Math.ceil(best.wait / 1000));
          if (sec !== announced) {
            announced = sec;
            q.onBusy?.(sec);
          }
          await o.clock.sleep(Math.max(1, best.wait), q.signal);
        }
      }
      // 5. deferred
      let min = Number.POSITIVE_INFINITY;
      for (const m of models) min = Math.min(min, waitMs(m, q.estTokens, q.priority));
      throw new TransientLlmError('rate_limit', `rate limited on ${q.model} (${q.priority})`, { retryAfterMs: Number.isFinite(min) ? min : null });
    },

    observe(model, ob) {
      const st = state(model);
      const now = o.clock.now();
      const h = ob.headers ?? null;
      const limTok = num(header(h, 'x-ratelimit-limit-tokens'));
      const remTok = num(header(h, 'x-ratelimit-remaining-tokens'));
      const rstTok = parseResetDuration(header(h, 'x-ratelimit-reset-tokens'));
      const limReq = num(header(h, 'x-ratelimit-limit-requests'));
      const remReq = num(header(h, 'x-ratelimit-remaining-requests'));
      const rstReq = parseResetDuration(header(h, 'x-ratelimit-reset-requests'));
      if (limTok != null && limTok > 0) st.limits.tpm = limTok;
      if (remTok != null) st.tok = { limit: st.limits.tpm, remaining: Math.max(0, remTok), obsAt: now, resetAt: now + (rstTok ?? WINDOW_MS) };
      if (limReq != null && limReq > 0) st.dayLimit = limReq;
      if (remReq != null) {
        const limit = limReq ?? st.dayLimit ?? st.limits.rpd;
        st.req = { limit, remaining: Math.max(0, remReq), obsAt: now, resetAt: now + (rstReq ?? 86_400_000) };
        persist((r) => r.sync(model, st.day, { rpdLimit: limit, resetAt: st.req!.resetAt, usedAtLeast: Math.max(0, limit - remReq) }, now));
        st.dayRequests = Math.max(st.dayRequests, limit - remReq);
      }
      // (the header snapshot already accounts for every earlier request: reservedSince() only counts later ones)
      if (ob.status === 429) {
        const ra = parseResetDuration(header(h, 'retry-after'));
        st.penaltyUntil = Math.max(st.penaltyUntil, now + (ra ?? 2_000));
      }
      if (ob.usage) {
        const actual = Math.max(0, ob.usage.promptTokens + ob.usage.completionTokens);
        const ev = st.events.find((e) => !e.settled);
        if (ev) {
          ev.tokens = actual;
          ev.settled = true;
        } else st.events.push({ at: now, tokens: actual, settled: true });
        st.dayTokens += actual;
        persist((r) => r.add(model, st.day, { tokens: actual }, now));
      } else if (ob.status && ob.status >= 400) {
        // a rejected request consumed no tokens (413 / 429 / 4xx): release the newest unsettled reservation's tokens
        const ev = [...st.events].reverse().find((e) => !e.settled);
        if (ev) {
          ev.tokens = 0;
          ev.settled = true;
        }
      }
    },

    dailyUse(model) {
      const st = state(model);
      const lim = rpdLimit(st);
      return lim > 0 ? rpdUsed(st, o.clock.now()) / lim : 0;
    },

    snapshot() {
      const now = o.clock.now();
      const out: Record<string, { rpdUsed: number; rpdLimit: number; tpmRemaining: number }> = {};
      for (const m of new Set([o.models.main, o.models.fast, ...states.keys()])) {
        const st = state(m);
        prune(st, now);
        const tpm = tpmRemaining(st, now);
        out[m] = { rpdUsed: rpdUsed(st, now), rpdLimit: rpdLimit(st), tpmRemaining: Number.isFinite(tpm) ? Math.max(0, Math.round(tpm)) : -1 };
      }
      return out;
    },
  };
}

/** Anthropic / demo: no provider-side buckets to manage. */
export function passThroughGovernor(): RateGovernor {
  return {
    async acquire(q) {
      if (q.signal?.aborted) throw new AbortedError(String(q.signal.reason ?? 'aborted'));
      return { model: q.model };
    },
    observe() {},
  };
}
