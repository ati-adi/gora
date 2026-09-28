// kernel/clock.ts (WP0) — every timer in src/ goes through a Clock (01 §4.2).
import type { Clock, Ms } from '../contracts/common.ts';
import { AbortedError } from './errors.ts';

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      // Never keep the process alive only for a Gora timer; shutdown is explicit.
      if (typeof h === 'object' && h && 'unref' in h) h.unref();
      return h;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    sleep: (ms, signal) => sleepWith((fn, t) => setTimeout(fn, t), (h) => clearTimeout(h as ReturnType<typeof setTimeout>), ms, signal),
  };
}

/**
 * Lets pending I/O and timers run (a macrotask turn, not a Clock timer: it never waits for a FakeClock advance).
 * For long synchronous loops that must not starve the event loop (e.g. the Mini App ledger verify).
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function sleepWith(set: (fn: () => void, ms: number) => unknown, clear: (h: unknown) => void, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError(String(signal.reason ?? 'aborted')));
    const onAbort = () => {
      clear(h);
      reject(new AbortedError(String(signal?.reason ?? 'aborted')));
    };
    const h = set(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface FakeTimer { id: number; at: Ms; fn: () => void }

/**
 * Deterministic clock for tests. Time only moves through advance()/set(); due timers fire in (at, id) order,
 * and microtasks are flushed between timers so promise chains triggered by one timer settle before the next.
 */
export class FakeClock implements Clock {
  private t: Ms;
  private seq = 0;
  private timers = new Map<number, FakeTimer>();

  constructor(start: Ms = Date.UTC(2026, 8, 28, 9, 0, 0)) {
    this.t = start;
  }
  now(): Ms {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    if (typeof h === 'number') this.timers.delete(h);
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWith((fn, t) => this.setTimeout(fn, t), (h) => this.clearTimeout(h), ms, signal);
  }
  /** Number of pending timers (tests). */
  pending(): number {
    return this.timers.size;
  }
  /** Earliest pending timer instant, or null. */
  nextAt(): Ms | null {
    let best: Ms | null = null;
    for (const x of this.timers.values()) if (best === null || x.at < best) best = x.at;
    return best;
  }
  /** Moves time forward by `ms`, firing every timer that becomes due (including ones scheduled while advancing). */
  async advance(ms: number): Promise<void> {
    const target = this.t + Math.max(0, ms);
    for (;;) {
      await flushMicrotasks();
      const due = [...this.timers.values()].filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers.delete(due.id);
      if (due.at > this.t) this.t = due.at;
      due.fn();
    }
    this.t = target;
    await flushMicrotasks();
  }
  /** Jumps to an absolute instant (never backwards), firing due timers. */
  async set(at: Ms): Promise<void> {
    if (at > this.t) await this.advance(at - this.t);
  }
}

/** Lets pending promise continuations run (several macrotask-free turns). */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
