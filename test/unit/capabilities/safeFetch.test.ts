// WP5 — SafeFetch (01 §11.5): private/reserved address ranges (literal and resolved), redirects re-validated, own host,
// ports, body cap, timeout. The request function and DNS are injected (tests are offline).
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { createSafeFetch, isBlockedAddress, validateUrl, type LookupFn } from '../../../src/capabilities/safeFetch.ts';

type Route = { status: number; headers?: Record<string, string>; body?: Buffer | string; hang?: boolean };

function fakeNet(dns: Record<string, string[]>, routes: Record<string, Route>) {
  const requested: string[] = [];
  const resolve: LookupFn = (host, _o, cb) => {
    const a = dns[host];
    if (!a) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(null, a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  const request = ((url: URL, opts: { lookup: (h: string, o: object, cb: (e: Error | null, a: unknown, f?: number) => void) => void; signal?: AbortSignal }, onRes: (res: EventEmitter & Record<string, unknown>) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      opts.lookup(url.hostname, {}, (err) => {
        if (err) return req.emit('error', err);
        requested.push(url.toString());
        const r = routes[url.toString()];
        if (!r) return req.emit('error', new Error('ECONNREFUSED'));
        if (r.hang) {
          opts.signal?.addEventListener('abort', () => req.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' })));
          return;
        }
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        Object.assign(res, { statusCode: r.status, headers: r.headers ?? {}, resume() {}, destroy() {} });
        onRes(res);
        const body = typeof r.body === 'string' ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
        queueMicrotask(() => {
          for (let i = 0; i < body.length; i += 64 * 1024) res.emit('data', body.subarray(i, i + 64 * 1024));
          res.emit('end');
        });
      });
    };
    return req;
  }) as never;
  return { resolve, request, requested };
}

function sf(net: ReturnType<typeof fakeNet>, clock = new FakeClock()) {
  return createSafeFetch({ clock, log: nullLogger, userAgent: 'GoraTest/1', publicUrl: 'https://gora.test', blockedDomains: ['bit.ly'], resolve: net.resolve, request: net.request, requestHttps: net.request, maxBytes: 1024 * 1024 });
}

describe('SafeFetch', () => {
  it('classifies blocked addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '198.18.0.1', '192.0.0.8', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('rejects bad URLs up front: scheme, port 8080, own host, localhost, literals, blocked domains', () => {
    const o = { publicUrl: 'https://gora.test', blockedDomains: ['bit.ly'] };
    for (const u of ['ftp://example.com/', 'http://example.com:8080/', 'https://gora.test/api', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest', 'https://bit.ly/x', 'https://a:b@example.com/']) {
      expect(() => validateUrl(u, o), u).toThrow();
    }
    expect(validateUrl('https://example.com/x', o).hostname).toBe('example.com');
  });

  it('blocks a public name that resolves to a private address (DNS rebinding)', async () => {
    const net = fakeNet({ 'evil.example': ['93.184.216.34', '10.0.0.5'] }, { 'http://evil.example/': { status: 200, body: 'secret' } });
    await expect(sf(net).get('http://evil.example/')).rejects.toMatchObject({ code: 'blocked_address' });
    expect(net.requested).toEqual([]);
  });

  it('follows ≤ 3 redirects, re-validating each; a redirect to a private address is blocked', async () => {
    const net = fakeNet(
      { 'a.example': ['93.184.216.34'], 'b.example': ['93.184.216.35'] },
      {
        'https://a.example/': { status: 302, headers: { location: 'https://b.example/page' } },
        'https://b.example/page': { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>ok</p>' },
        'https://a.example/meta': { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } },
        'https://a.example/loop': { status: 302, headers: { location: 'https://a.example/loop' } },
        'https://a.example/self': { status: 302, headers: { location: 'https://gora.test/admin' } },
      },
    );
    const f = sf(net);
    const r = await f.get('https://a.example/');
    expect(r).toMatchObject({ status: 200, finalUrl: 'https://b.example/page', contentType: 'text/html' });
    expect(new TextDecoder().decode(r.body)).toBe('<p>ok</p>');
    await expect(f.get('https://a.example/meta')).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(f.get('https://a.example/loop')).rejects.toMatchObject({ code: 'too_many_redirects' });
    await expect(f.get('https://a.example/self')).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('caps the body (declared and streamed) and times out through the Clock', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 97);
    const net = fakeNet({ 'x.example': ['93.184.216.34'] }, {
      'https://x.example/declared': { status: 200, headers: { 'content-length': String(big.length) }, body: big },
      'https://x.example/streamed': { status: 200, body: big },
      'https://x.example/slow': { status: 200, hang: true },
    });
    const clock = new FakeClock();
    const f = sf(net, clock);
    await expect(f.get('https://x.example/declared')).rejects.toMatchObject({ code: 'too_large' });
    await expect(f.get('https://x.example/streamed')).rejects.toMatchObject({ code: 'too_large' });
    const p = f.get('https://x.example/slow', { timeoutMs: 1000 });
    await Promise.resolve();
    clock.advance(1001);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });
});
