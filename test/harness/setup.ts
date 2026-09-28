// test/harness/setup.ts (WP0) — vitest setupFiles: everything runs offline (01 §15).
// 1. Global fetch throws NetworkDisabledError; adapters must receive a fake fetchImpl by injection.
// 2. Socket-level guard: every TCP connect to a non-loopback host throws NetworkDisabledError. This also covers clients
//    that never touch globalThis.fetch — grammY's default node-fetch shim, node:http/https (SafeFetch), undici, tls.
//    Loopback hosts and local (IPC / unix-socket) paths stay allowed, so in-process servers and the vitest pool work.
import net from 'node:net';
import { NetworkDisabledError } from '../../src/kernel/errors.ts';

const disabledFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new NetworkDisabledError(url);
}) as typeof fetch;

globalThis.fetch = disabledFetch;
process.env['NODE_ENV'] = 'test';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** The connect target from any Socket#connect call shape: (options[, cb]), (port[, host][, cb]), (path[, cb]) or Node's internal normalized [options, cb] array. */
export function connectTarget(args: unknown[]): { host: string | null; port: unknown; path: string | null } {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { host: null, port: null, path: first };
  if (typeof first === 'number' || typeof first === 'string') return { host: typeof args[1] === 'string' ? args[1] : null, port: first, path: null };
  if (first && typeof first === 'object') {
    const o = first as { host?: unknown; port?: unknown; path?: unknown };
    return { host: typeof o.host === 'string' ? o.host : null, port: o.port ?? null, path: typeof o.path === 'string' ? o.path : null };
  }
  return { host: null, port: null, path: null };
}

const GUARD = Symbol.for('gora.test.netGuard');
const proto = net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown; [GUARD]?: true };
if (!proto[GUARD]) {
  const orig = proto.connect;
  proto.connect = function (this: net.Socket, ...a: unknown[]) {
    const t = connectTarget(a);
    const host = t.host ?? 'localhost';
    if (t.path || LOOPBACK.has(host)) return orig.apply(this, a);
    throw new NetworkDisabledError(`tcp://${host.includes(':') ? `[${host}]` : host}:${String(t.port ?? '')}`);
  };
  proto[GUARD] = true;
}
