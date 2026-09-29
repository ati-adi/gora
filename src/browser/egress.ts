// browser/egress.ts (s07 lead fix; red-team B-NET-1/B-NET-2, skeptic "redirects bypass the guard", DNS rebinding) —
// a local HTTP/CONNECT egress proxy per browser context. Chromium is pointed at it with `bypass: '<-loopback>'` (so even
// loopback goes through it) and WebRTC limited to proxied TCP, so EVERY connection the page makes is decided here:
//  - plain http (absolute-form requests): the full URL goes through NetworkPolicy.check — every redirect hop is a new
//    request, so a public page cannot 302 the browser to 169.254.169.254, a LAN host or Gora's own port;
//  - https / wss (CONNECT host:port): the policy decides on `https://host:port/` (host, port and address rules);
//  - the upstream socket connects ONLY to the address `policy.connectAddress` resolved and vetted (never a second DNS
//    lookup), which closes DNS rebinding.
// Playwright's `context.route` (see playwright.ts) still checks each chain's first URL with its full path and scheme and
// enforces the POST backstop; this proxy is the connection-level boundary underneath it.
// The proxy listens on 127.0.0.1 only and requires a per-context random credential (Proxy-Authorization: Basic), so
// another local process cannot borrow it.
import http from 'node:http';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import type { NetworkPolicy } from '../contracts/index.ts';
import { randomToken } from '../kernel/ids.ts';

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` for Playwright's context `proxy.server`. */
  readonly server: string;
  readonly username: string;
  readonly password: string;
  close(): Promise<void>;
}

export interface EgressOptions {
  /** Called for every refused connection (the session counts it; a refused document maps to {error:'blocked'}). */
  onBlocked?(url: string, reason: string): void;
  /** Upstream idle timeout (ms). */
  idleMs?: number;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'upgrade']);
const BLOCK_PAGE = '<!doctype html><title>Blocked</title><p>This address is not allowed for the browser task.</p>';

type Target = { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: string };

async function target(policy: NetworkPolicy, host: string, port: number): Promise<Target> {
  if (policy.connectAddress) {
    const v = await policy.connectAddress(host, port);
    return v.allow ? { ok: true, address: v.address, family: v.family } : { ok: false, reason: v.reason };
  }
  // A policy without address vetting (tests with scripted policies): resolve once here and connect to that address.
  const bare = host.replace(/^\[|\]$/g, '');
  const fam = net.isIP(bare);
  if (fam) return { ok: true, address: bare, family: fam as 4 | 6 };
  return new Promise((ok) => {
    dnsLookup(bare, (err, address, family) => ok(err ? { ok: false, reason: 'dns: lookup failed' } : { ok: true, address, family: (family === 6 ? 6 : 4) as 4 | 6 }));
  });
}

function splitHostPort(authority: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65_536 ? { host: m[1]!, port } : null;
}

export async function startEgressProxy(policy: NetworkPolicy, o: EgressOptions = {}): Promise<EgressProxy> {
  const username = 'gora';
  const password = randomToken(18);
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const idleMs = o.idleMs ?? 60_000;
  const sockets = new Set<net.Socket>();
  const authorized = (h: http.IncomingHttpHeaders) => h['proxy-authorization'] === expected;
  const blocked = (url: string, reason: string) => {
    try {
      o.onBlocked?.(url, reason);
    } catch {
      /* counting only */
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!authorized(req.headers)) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="gora"', 'content-length': '0' }).end();
        return;
      }
      let u: URL;
      try {
        u = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (u.protocol !== 'http:') {
        res.writeHead(400).end();
        return;
      }
      let verdict: { allow: true } | { allow: false; reason: string };
      try {
        verdict = await policy.check(u.href, 'subresource');
      } catch {
        verdict = { allow: false, reason: 'policy error' };
      }
      const port = Number(u.port || 80);
      const t: Target = verdict.allow ? await target(policy, u.hostname, port).catch(() => ({ ok: false as const, reason: 'dns: lookup failed' })) : { ok: false, reason: verdict.reason };
      if (!t.ok) {
        blocked(u.href, t.reason);
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'x-gora-blocked': '1', 'cache-control': 'no-store' }).end(BLOCK_PAGE);
        return;
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
      const up = http.request(
        {
          host: t.address, family: t.family, port, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false,
          // the Host header keeps the name (virtual hosts); the socket goes to the vetted address only
        },
        (ur) => {
          const out: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(ur.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
          res.writeHead(ur.statusCode ?? 502, out);
          ur.pipe(res);
        },
      );
      up.setTimeout(idleMs, () => up.destroy());
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-length': '0' }).end();
        else res.destroy();
      });
      req.pipe(up);
    })();
  });

  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    void (async () => {
      if (!authorized(req.headers)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="gora"\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const hp = splitHostPort(req.url ?? '');
      if (!hp) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const url = `${hp.port === 443 ? 'https' : 'http'}://${hp.host}:${hp.port}/`;
      let verdict: { allow: true } | { allow: false; reason: string };
      try {
        verdict = await policy.check(url, 'subresource');
      } catch {
        verdict = { allow: false, reason: 'policy error' };
      }
      const t: Target = verdict.allow ? await target(policy, hp.host, hp.port).catch(() => ({ ok: false as const, reason: 'dns: lookup failed' })) : { ok: false, reason: verdict.reason };
      if (!t.ok) {
        blocked(url, t.reason);
        client.end('HTTP/1.1 403 Forbidden\r\nX-Gora-Blocked: 1\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const up = net.connect({ host: t.address, port: hp.port, family: t.family });
      sockets.add(up);
      up.on('close', () => sockets.delete(up));
      up.setTimeout(idleMs * 2, () => up.destroy());
      up.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on('error', () => {
        if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        client.destroy();
      });
      client.on('close', () => up.destroy());
    })();
  });
  // WebSockets travel inside CONNECT tunnels; a plain-proxy upgrade is never used by Chromium → refuse.
  server.on('upgrade', (_req: http.IncomingMessage, sock: net.Socket) => sock.destroy());
  server.on('connection', (sock: net.Socket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const port = (server.address() as net.AddressInfo).port;
  let closed = false;
  return {
    server: `http://127.0.0.1:${port}`,
    username,
    password,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
