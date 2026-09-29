// browser/netGuard.ts (s07 BR, spec 07 A4) — the browser's network guard: a NetworkPolicy the capability applies to EVERY
// request of a task's context (Playwright `context.route('**/*')`, FakeBrowser on every navigation and subresource).
// Same rules as SafeFetch (01 §11.5), reusing its validators: http(s) only, ports 80/443, no credentials in URLs, no
// localhost, not Gora's own host, not BLOCKED_DOMAINS, and no private / loopback / link-local / metadata address —
// literal or after DNS resolution. data:, file:, chrome: (and every other scheme) are refused; blob: is refused for
// documents only (a page's own blob: images/workers never leave the process).
//
// DNS rebinding (s07 lead fix): the Playwright capability sends all of Chromium's traffic through a local egress proxy
// (egress.ts) that connects only to the address `connectAddress` resolved and vetted — Chromium never resolves names
// itself, so a rebinding host cannot switch to an internal address between the check and the connection.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { Clock, NetworkPolicy } from '../contracts/index.ts';
import { isBlockedAddress, validateUrl, type LookupFn } from '../capabilities/safeFetch.ts';

export const DNS_MEMO_MS = 60_000;

export interface NetworkPolicyOptions {
  clock: Clock;
  publicUrl?: string;
  blockedDomains?: readonly string[];
  /**
   * DNS resolution (all addresses). `null` skips the DNS step (a scripted FakeBrowser never touches the network; IP
   * literals and host rules still apply). Default: node:dns lookup.
   */
  resolve?: LookupFn | null;
}

export type Verdict = { allow: true } | { allow: false; reason: string };

function resolveAll(resolve: LookupFn, host: string): Promise<LookupAddress[]> {
  return new Promise((ok, fail) => {
    resolve(host, { all: true }, (err, addrs) => (err ? fail(err) : ok(addrs ?? [])));
  });
}

/** One policy per browser task (its DNS memo lives as long as the task's context). */
export function createNetworkPolicy(o: NetworkPolicyOptions): NetworkPolicy & { readonly checks: number; connectAddress: NonNullable<NetworkPolicy['connectAddress']> } {
  const resolve: LookupFn | null = o.resolve === undefined ? (dnsLookup as unknown as LookupFn) : o.resolve;
  const memo = new Map<string, { v: Verdict; until: number }>();
  let checks = 0;

  const dnsVerdict = async (host: string): Promise<Verdict> => {
    if (!resolve || isIP(host)) return { allow: true };
    const now = o.clock.now();
    const hit = memo.get(host);
    if (hit && hit.until > now) return hit.v;
    let v: Verdict;
    try {
      const addrs = await resolveAll(resolve, host);
      if (!addrs.length) v = { allow: false, reason: 'dns: no address' };
      else if (addrs.some((a) => isBlockedAddress(a.address))) v = { allow: false, reason: 'resolves to a private address' };
      else v = { allow: true };
    } catch {
      v = { allow: false, reason: 'dns: lookup failed' };
    }
    memo.set(host, { v, until: now + DNS_MEMO_MS });
    return v;
  };

  const norm = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  return {
    get checks() {
      return checks;
    },
    async connectAddress(rawHost, _port) {
      const host = norm(rawHost);
      const fam = isIP(host);
      if (fam) return isBlockedAddress(host) ? { allow: false, reason: 'private address' } : { allow: true, address: host, family: fam as 4 | 6 };
      if (!resolve) return { allow: false, reason: 'dns: resolution disabled' };
      try {
        const addrs = await resolveAll(resolve, host);
        if (!addrs.length) return { allow: false, reason: 'dns: no address' };
        if (addrs.some((a) => isBlockedAddress(a.address))) return { allow: false, reason: 'resolves to a private address' };
        const a = addrs[0]!;
        return { allow: true, address: a.address, family: (a.family === 6 ? 6 : 4) as 4 | 6 };
      } catch {
        return { allow: false, reason: 'dns: lookup failed' };
      }
    },
    async check(raw, kind) {
      checks++;
      let scheme: string;
      try {
        scheme = new URL(raw).protocol;
      } catch {
        return { allow: false, reason: 'invalid URL' };
      }
      if (scheme === 'blob:') return kind === 'subresource' ? { allow: true } : { allow: false, reason: 'blob: documents are not allowed' };
      if (scheme !== 'http:' && scheme !== 'https:') return { allow: false, reason: `${scheme} is not allowed` };
      let u: URL;
      try {
        u = validateUrl(raw, { ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}), ...(o.blockedDomains ? { blockedDomains: o.blockedDomains } : {}) });
      } catch (e) {
        return { allow: false, reason: e instanceof Error ? e.message : 'blocked' };
      }
      return dnsVerdict(norm(u.hostname));
    },
  };
}
