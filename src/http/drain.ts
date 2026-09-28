// http/drain.ts — graceful shutdown for the HTTP surface (01 §4.5 step 10).
// app.stop() calls drainHttp() FIRST: new /api/* and /oauth/* requests get 503 {error:'shutting_down'}, and stop waits
// (bounded) for the requests already in flight, so none of them runs against a stopped runner or a closed database.
import type { MiddlewareHandler } from 'hono';
import type { Services } from '../contracts/index.ts';

interface Gate { draining: boolean; inflight: number; idle: Array<() => void> }
const gates = new WeakMap<object, Gate>();

function gateOf(s: Services): Gate {
  let g = gates.get(s);
  if (!g) {
    g = { draining: false, inflight: 0, idle: [] };
    gates.set(s, g);
  }
  return g;
}

/** Counts in-flight requests and refuses new ones (503) once draining started. */
export function drainMiddleware(s: Services): MiddlewareHandler {
  const g = gateOf(s);
  return async (c, next) => {
    if (g.draining) return c.json({ error: 'shutting_down' }, 503, { 'Retry-After': '5', 'Cache-Control': 'no-store' });
    g.inflight++;
    try {
      await next();
    } finally {
      g.inflight--;
      if (g.inflight === 0) for (const f of g.idle.splice(0)) f();
    }
  };
}

/**
 * Stops accepting gated requests and resolves when those in flight have finished, or after `timeoutMs` (the returned
 * number is how many were still running then).
 */
export function drainHttp(s: Services, timeoutMs: number): Promise<number> {
  const g = gateOf(s);
  g.draining = true;
  if (g.inflight === 0) return Promise.resolve(0);
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.clock.clearTimeout(h);
      resolve(g.inflight);
    };
    const h = s.clock.setTimeout(finish, timeoutMs);
    g.idle.push(finish);
  });
}

/** True once drainHttp() was called for these services. */
export function isHttpDraining(s: Services): boolean {
  return gateOf(s).draining;
}
