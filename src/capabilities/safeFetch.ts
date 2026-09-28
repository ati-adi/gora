// capabilities/safeFetch.ts (WP5) — the SSRF guard (01 §11.5). node:http/https request() with a custom `lookup` that
// resolves every address (dns.lookup all:true) and rejects private/reserved ranges; because the same lookup is used for
// connecting, DNS rebinding is prevented. http(s) on ports 80/443 only, never PUBLIC_URL's host or localhost; ≤ 3
// redirects (each re-validated), 10 s timeout, 2 MB body cap, GET only. Logs carry the host only.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Clock, Logger, SafeFetch } from '../contracts/index.ts';
import { AbortedError, GoraError } from '../kernel/errors.ts';

export class SafeFetchError extends GoraError {
  readonly code: 'bad_url' | 'blocked_host' | 'blocked_address' | 'too_many_redirects' | 'timeout' | 'too_large' | 'network';
  constructor(code: SafeFetchError['code'], message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

// ── address classification
function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V4_RANGES = V4_BLOCKS.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});
function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.net);
}
/** Expands an IPv6 literal into 8 16-bit groups (handles '::' and a dotted IPv4 tail). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const n = v4ToInt(dotted[1]!);
    s = `${s.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const h = parts[0] ? parts[0].split(':') : [];
  const r = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - h.length - r.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...h, ...Array<string>(parts.length === 2 ? fill : 0).fill('0'), ...r].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}
function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64-translated forms of a blocked v4 address.
  const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedV4(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(v4);
  return false;
}
/** True when an IP literal is in a range SafeFetch never connects to (01 §11.5). */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip.replace(/^\[|\]$/g, ''));
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip.replace(/^\[|\]$/g, ''));
  return true;
}

// ── URL validation (used before every request and every redirect; also by watcher_create through `validateUrl`)
export function validateUrl(raw: string, o: { publicUrl?: string; blockedDomains?: readonly string[] }): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError('bad_url', 'invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchError('bad_url', 'only http and https are allowed');
  if (u.username || u.password) throw new SafeFetchError('bad_url', 'credentials in URLs are not allowed');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) throw new SafeFetchError('bad_url', 'only ports 80 and 443 are allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new SafeFetchError('blocked_host', 'localhost is not allowed');
  if (o.publicUrl) {
    try {
      if (new URL(o.publicUrl).hostname.toLowerCase() === host) throw new SafeFetchError('blocked_host', 'the bot host is not allowed');
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
    }
  }
  if (o.blockedDomains?.some((d) => host === d || host.endsWith(`.${d}`))) throw new SafeFetchError('blocked_host', 'this domain is blocked');
  if (isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('blocked_address', 'this address is not allowed');
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export type LookupFn = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A `lookup` for http.request that resolves all addresses and refuses the request if any of them is blocked. */
export function guardedLookup(resolve: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb): void => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, [], 0);
      const list = addresses ?? [];
      if (!list.length) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException, [], 0);
      if (list.some((a) => isBlockedAddress(a.address))) return cb(Object.assign(new Error('resolved to a blocked address'), { code: 'EBLOCKED' }) as NodeJS.ErrnoException, [], 0);
      const all = typeof options === 'object' && options.all;
      if (all) return cb(null, list);
      const first = list[0]!;
      return cb(null, first.address, first.family);
    });
  };
}

export interface SafeFetchOptions {
  clock: Clock;
  log: Logger;
  userAgent: string;
  publicUrl?: string;
  blockedDomains?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Tests: DNS resolution and the request function. */
  resolve?: LookupFn;
  request?: typeof http.request;
  requestHttps?: typeof https.request;
}

export function createSafeFetch(o: SafeFetchOptions): SafeFetch {
  const lookup = guardedLookup(o.resolve);
  const maxRedirects = o.maxRedirects ?? 3;

  function once(u: URL, accept: string, maxBytes: number, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Uint8Array }> {
    return new Promise((resolve, reject) => {
      const req = (u.protocol === 'https:' ? (o.requestHttps ?? https.request) : (o.request ?? http.request))(
        u,
        { method: 'GET', lookup: lookup as never, headers: { 'user-agent': o.userAgent, accept, 'accept-encoding': 'identity' }, signal },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return resolve({ status, headers: res.headers, body: new Uint8Array() });
          }
          const declared = Number(res.headers['content-length'] ?? NaN);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            return reject(new SafeFetchError('too_large', 'response body too large'));
          }
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              reject(new SafeFetchError('too_large', 'response body too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status, headers: res.headers, body: new Uint8Array(Buffer.concat(chunks)) }));
          res.on('error', (e) => reject(e));
        },
      );
      req.on('error', (e) => reject(e));
      req.end();
    });
  }

  return {
    async get(url, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? o.timeoutMs ?? 10_000;
      const maxBytes = opts.maxBytes ?? o.maxBytes ?? 2 * 1024 * 1024;
      const accept = opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8';
      const ac = new AbortController();
      let timedOut = false;
      const timer = o.clock.setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      const onAbort = () => ac.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      let u = validateUrl(url, o);
      try {
        for (let hop = 0; ; hop++) {
          o.log.debug({ host: u.hostname, hop }, 'safeFetch');
          let r;
          try {
            r = await once(u, accept, maxBytes, ac.signal);
          } catch (e) {
            if (timedOut) throw new SafeFetchError('timeout', 'request timed out');
            if (opts.signal?.aborted) throw new AbortedError();
            if ((e as { code?: string }).code === 'EBLOCKED') throw new SafeFetchError('blocked_address', 'resolved to a blocked address');
            if (e instanceof SafeFetchError) throw e;
            throw new SafeFetchError('network', 'network error');
          }
          if (r.status >= 300 && r.status < 400 && r.headers.location) {
            if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'too many redirects');
            u = validateUrl(new URL(String(r.headers.location), u).toString(), o);
            continue;
          }
          return { status: r.status, finalUrl: u.toString(), contentType: String(r.headers['content-type'] ?? ''), body: r.body };
        }
      } finally {
        o.clock.clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
