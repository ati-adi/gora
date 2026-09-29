// s07 BR — spec 07 A4 network guard (SafeFetch rules, 01 §11.5) as the browser's NetworkPolicy.
import { describe, expect, it } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { createNetworkPolicy, DNS_MEMO_MS } from '../../../src/browser/netGuard.ts';
import { BLOCKED_DOMAINS } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import type { LookupFn } from '../../../src/capabilities/safeFetch.ts';

function resolver(table: Record<string, string[]>): LookupFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((host: string, _o: { all: true }, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => {
    calls.push(host);
    const ips = table[host];
    if (!ips) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(null, ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  }) as LookupFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('browser network guard (A4)', () => {
  const clock = new FakeClock();
  const dns = resolver({ 'tables.example': ['93.184.216.34'], 'evil.example': ['10.1.2.3'], 'mixed.example': ['93.184.216.34', '169.254.169.254'], 'v6.example': ['::1'] });
  const policy = createNetworkPolicy({ clock, publicUrl: 'https://gora.test', blockedDomains: BLOCKED_DOMAINS, resolve: dns });

  it.each([
    'http://10.0.0.5/admin', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'https://app.localhost/',
    'https://gora.test/app/', 'https://tables.example:8080/', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'chrome://settings', 'javascript:alert(1)',
    'ftp://tables.example/', 'https://user:pw@tables.example/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://[fe80::1]/',
  ])('blocks %s', async (url) => {
    const v = await policy.check(url, 'document');
    expect(v.allow).toBe(false);
  });

  it('blocks a hostname that resolves to a private address (any of its addresses), and v6 loopback', async () => {
    expect(await policy.check('https://evil.example/', 'document')).toMatchObject({ allow: false, reason: 'resolves to a private address' });
    expect((await policy.check('https://mixed.example/x.js', 'subresource')).allow).toBe(false);
    expect((await policy.check('https://v6.example/', 'document')).allow).toBe(false);
    expect((await policy.check('https://nowhere.example/', 'document')).allow).toBe(false); // DNS failure → refused
  });

  it('allows https://tables.example (documents and subresources), memoizing DNS per task for 60 s', async () => {
    const p = createNetworkPolicy({ clock, publicUrl: 'https://gora.test', resolve: dns });
    const before = dns.calls.length;
    expect(await p.check('https://tables.example/', 'document')).toEqual({ allow: true });
    expect(await p.check('https://tables.example/app.js', 'subresource')).toEqual({ allow: true });
    expect(await p.check('http://tables.example/', 'document')).toEqual({ allow: true });
    expect(dns.calls.length - before).toBe(1);
    await clock.advance(DNS_MEMO_MS + 1);
    await p.check('https://tables.example/', 'document');
    expect(dns.calls.length - before).toBe(2);
  });

  it('blob: is allowed for subresources only; BLOCKED_DOMAINS are refused', async () => {
    expect((await policy.check('blob:https://tables.example/1234', 'subresource')).allow).toBe(true);
    expect((await policy.check('blob:https://tables.example/1234', 'document')).allow).toBe(false);
    const blocked = BLOCKED_DOMAINS[0];
    if (blocked) expect((await policy.check(`https://${blocked}/`, 'document')).allow).toBe(false);
  });

  it('without a resolver (FakeBrowser: no network) IP literals and hosts are still checked', async () => {
    const p = createNetworkPolicy({ clock, publicUrl: 'https://gora.test', resolve: null });
    expect((await p.check('https://tables.example/', 'document')).allow).toBe(true);
    expect((await p.check('http://10.0.0.5/', 'document')).allow).toBe(false);
    expect((await p.check('https://gora.test/', 'document')).allow).toBe(false);
  });
});
