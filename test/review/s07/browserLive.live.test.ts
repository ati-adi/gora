// s07 red team — LIVE proofs (now regression tests after the lead's fixes: egress proxy, POST backstop, focus-aware
// press classification, scripted links, WebRTC off, data: refused) against real headless Chromium (PlaywrightBrowser + the real network guard + the real
// classifier). Loopback only: a local HTTP server (and a UDP socket) on 127.0.0.1; no internet, no bot, no LLM.
//   LIVE_BROWSER=1 npx vitest run --config test/review/s07/vitest.live.config.ts
//
// The pages under /pub/* are "the public site" (the test policy lets exactly those through and hands every other URL
// to the REAL createNetworkPolicy, which refuses 127.0.0.1 and non-standard ports). /secret stands for an internal
// service (router admin, metadata endpoint, a LAN host): it must never be reached.
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyBrowserTool } from '../../../src/browser/classify.ts';
import { createNetworkPolicy } from '../../../src/browser/netGuard.ts';
import { PlaywrightBrowser } from '../../../src/browser/playwright.ts';
import { buildSnapshot, type BrowserSnapshot } from '../../../src/browser/snapshot.ts';
import type { BrowserSession, NetworkPolicy } from '../../../src/contracts/index.ts';
import { systemClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';

const LIVE = process.env['LIVE_BROWSER'] === '1';

const hits: Array<{ method: string; url: string; body: string }> = [];
let server: http.Server;
let base = '';
let udp: dgram.Socket;
let udpPort = 0;
const udpPackets: number[] = [];

const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

function pages(): Record<string, string> {
  return {
    '/pub/autofocus': html(`<h1>Booking</h1><form action="/pub/submitted" method="post"><label>Name <input name="name"></label><button type="submit" autofocus>Confirm booking</button></form>`),
    '/pub/hashlink': html(`<h1>Booking</h1><form id="f" action="/pub/submitted" method="post"><label>Name <input name="name" value="Adi"></label></form>
      <a href="#" onclick="document.getElementById('f').submit(); return false;">Confirm booking</a>`),
    '/pub/select': html(`<h1>Pick a time</h1><form action="/pub/submitted" method="post"><label>Time <select name="slot" onchange="this.form.submit()"><option>18:00</option><option>19:00</option></select></label></form>`),
    '/pub/select-get': html(`<h1>Sort</h1><form action="/pub/sorted" method="get"><label>Sort <select name="sort" onchange="this.form.submit()"><option>price</option><option>rating</option></select></label></form>`),
    '/pub/data': html(`<h1>Links</h1><a href="data:text/html,<h1>DATA-PAGE</h1>">data</a>`),
    '/pub/tabspace': html(`<h1>Booking</h1><form action="/pub/submitted" method="post"><label>Name <input name="name"></label><button type="submit">Confirm booking</button></form>`),
    '/pub/keylogger': html(`<h1>Survey</h1><label>Comment <input name="c" oninput="navigator.sendBeacon('/pub/leak', this.value)"></label>`),
    '/pub/webrtc': html(`<h1>Hi</h1><script>
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${'${UDP}'}' }] });
      pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o));
    </script>`),
  };
}

beforeAll(async () => {
  if (!LIVE) return;
  udp = dgram.createSocket('udp4');
  udp.on('message', (m) => udpPackets.push(m.length));
  await new Promise<void>((ok) => udp.bind(0, '127.0.0.1', () => ok()));
  udpPort = (udp.address() as AddressInfo).port;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
      const path = (req.url ?? '').split('?')[0]!;
      if (path === '/pub/redir') {
        res.writeHead(302, { location: `${base}/secret` });
        return res.end();
      }
      const p = pages()[path];
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(p ? p.replace('${UDP}', String(udpPort)) : html(`<h1>${path}</h1>`));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (!LIVE) return;
  await new Promise<void>((ok) => server.close(() => ok()));
  udp.close();
});

function testPolicy(): NetworkPolicy & { seen: string[] } {
  const real = createNetworkPolicy({ clock: systemClock(), publicUrl: 'https://gora.test' });
  const seen: string[] = [];
  return {
    seen,
    async check(url, kind) {
      seen.push(url);
      if (url.startsWith(`${base}/pub/`)) return { allow: true };
      return real.check(url, kind);
    },
  };
}

async function withSession<T>(fn: (s: BrowserSession, policy: ReturnType<typeof testPolicy>) => Promise<T>): Promise<T> {
  const b = new PlaywrightBrowser({ headless: true, navigationTimeoutMs: 10_000, actionTimeoutMs: 3_000 }, { clock: systemClock(), log: createMemoryLogger() });
  const policy = testPolicy();
  const s = await b.openSession({ taskId: `rt_${Date.now()}`, userId: 'u_rt', policy });
  try {
    return await fn(s, policy);
  } finally {
    await s.close();
    await b.closeAll();
  }
}

async function snap(s: BrowserSession): Promise<BrowserSnapshot> {
  return buildSnapshot(await s.state(), { maxTokens: 6_000 });
}
const refNamed = (sn: BrowserSnapshot, re: RegExp) => [...sn.refs.values()].find((r) => re.test(r.name))!;
const submittedCount = () => hits.filter((h) => h.url.startsWith('/pub/submitted')).length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)('s07 red team: browser (live Chromium)', () => {
  it('B-NET-1: a public page that 302-redirects to an internal address must be refused (redirect hops are not routed)', async () => {
    await withSession(async (s, policy) => {
      await s.open(`${base}/pub/redir`);
      // the guard never saw the redirect target …
      const guardSawSecret = policy.seen.some((u) => u.includes('/secret'));
      // … and the internal service was reached
      const reached = hits.some((h) => h.url === '/secret');
      expect({ guardSawSecret, reached }).toEqual({ guardSawSecret: true, reached: false });
    });
  });

  it('B-COMMIT-1: browser_press Enter on a page whose submit button has autofocus is read_public, and it submits', async () => {
    await withSession(async (s) => {
      await s.open(`${base}/pub/autofocus`);
      const sn = await snap(s);
      const cls = classifyBrowserTool('browser_press', { key: 'Enter' }, { snap: sn, focus: null, ownerText: '' });
      const before = submittedCount();
      await s.press('Enter');
      await wait(300);
      const submitted = submittedCount() > before;
      // an unapproved submit must not be classified as a free read
      expect({ cls: cls.actionClass, submitted }).not.toEqual({ cls: 'read_public', submitted: true });
    });
  });

  it('B-COMMIT-2: typing a name, then Tab + Space presses the "Confirm booking" submit — every step is free', async () => {
    await withSession(async (s) => {
      await s.open(`${base}/pub/tabspace`);
      const sn = await snap(s);
      const name = refNamed(sn, /^Name/);
      const classes = [
        classifyBrowserTool('browser_type', { ref: name.ref, text: 'Adi' }, { snap: sn, focus: null, ownerText: 'Adi' }).actionClass,
        classifyBrowserTool('browser_press', { key: 'Tab' }, { snap: sn, focus: name.ref, ownerText: 'Adi' }).actionClass,
        classifyBrowserTool('browser_press', { key: 'Space' }, { snap: sn, focus: name.ref, ownerText: 'Adi' }).actionClass,
      ];
      const before = submittedCount();
      await s.type(name.ref, 'Adi');
      await s.press('Tab');
      await s.press('Space');
      await wait(300);
      const submitted = submittedCount() > before;
      expect(classes).toEqual(['write_self', 'read_public', 'read_public']);
      expect(submitted).toBe(false); // FAILS: the form was submitted without any approval
    });
  });

  it('B-COMMIT-3: a link <a href="#" onclick=submit> named "Confirm booking" is navigation (read_public), and it submits', async () => {
    await withSession(async (s) => {
      await s.open(`${base}/pub/hashlink`);
      const sn = await snap(s);
      const link = refNamed(sn, /Confirm booking/);
      const cls = classifyBrowserTool('browser_click', { ref: link.ref }, { snap: sn, focus: null, ownerText: '' });
      const before = submittedCount();
      await s.click(link.ref);
      await wait(300);
      expect({ role: link.role, cls: cls.actionClass, submitted: submittedCount() > before }).not.toEqual({ role: 'link', cls: 'read_public', submitted: true });
    });
  });

  it('B-COMMIT-4: browser_select on a <select onchange="this.form.submit()"> of a POST form does not submit it', async () => {
    await withSession(async (s) => {
      await s.open(`${base}/pub/select`);
      const sn = await snap(s);
      const sel = refNamed(sn, /Time/);
      const cls = classifyBrowserTool('browser_select', { ref: sel.ref, value: '19:00' }, { snap: sn, focus: null, ownerText: '' });
      const before = submittedCount();
      const r = await s.select(sel.ref, '19:00');
      await wait(300);
      expect({ cls: cls.actionClass, submitted: submittedCount() > before }).not.toEqual({ cls: 'write_self', submitted: true });
      expect(r).toMatchObject({ ok: false, error: 'needs_approval' }); // lead fix: the POST backstop refused it
      // … and the same select, approved by the owner, does submit
      const ok = await s.select(sel.ref, '18:00', { approved: true });
      await wait(300);
      expect(ok).toMatchObject({ ok: true });
      expect(submittedCount()).toBe(before + 1);
    });
  });

  it('B-COMMIT-4b (accepted): a GET form behind a select (sort / filter) navigates like a link', async () => {
    // A GET navigation carries no body; sites that commit on GET are indistinguishable from a link click, which is
    // navigation by design (spec 07 A4). Documented in docs/progress/s07-gate.md.
    await withSession(async (s) => {
      await s.open(`${base}/pub/select-get`);
      const sel = refNamed(await snap(s), /Sort/);
      const r = await s.select(sel.ref, 'rating');
      await wait(300);
      expect(r.ok).toBe(true);
      expect(hits.some((h) => h.url.startsWith('/pub/sorted?sort=rating'))).toBe(true);
    });
  });

  it('B-DATA-1 (residual, mitigated): typing is a send on a scripted page — so a browse mission holds nothing private to type', async () => {
    // Page JS sees every keystroke (sendBeacon on input): typing cannot be made "not a send". The lead fix removes the
    // source instead: browse missions carry no memory / profile / location (agent/context.ts BROWSE_MISSION, proven in
    // test/review/s07/browseMissionContext.test.ts), owner text excludes the profile summary, and personal data typed on
    // a host the owner did not name asks (classify.ts). This test pins the residual: the beacon does receive the text.
    await withSession(async (s) => {
      await s.open(`${base}/pub/keylogger`);
      const sn = await snap(s);
      const box = refNamed(sn, /Comment/);
      const text = 'a table for two, window seat';
      const cls = classifyBrowserTool('browser_type', { ref: box.ref, text }, { snap: sn, focus: null, ownerText: '' });
      await s.type(box.ref, text);
      await wait(300);
      expect(cls.actionClass).toBe('write_self');
      expect(hits.some((h) => h.url === '/pub/leak' && h.body.includes('window seat'))).toBe(true);
      // the owner's phone on a host the owner never named asks
      const phone = classifyBrowserTool('browser_type', { ref: box.ref, text: '+7 701 555 12 34' }, { snap: sn, focus: null, ownerText: 'мой номер +7 701 555 12 34', ownerHosts: ['tables.example'], visitedHosts: [] });
      expect(phone.actionClass).toBe('send_external');
    });
  });

  it('B-NET-3: data:, file: and javascript: top-level URLs are refused before navigating', async () => {
    await withSession(async (s, policy) => {
      for (const u of ['data:text/html,<h1>DATA-PAGE</h1>', 'file:///etc/hosts', 'javascript:alert(1)']) {
        const r = await s.open(u);
        expect(r).toMatchObject({ ok: false, error: 'blocked' });
      }
      expect(policy.seen.some((u) => u.startsWith('data:'))).toBe(true);
      const st = await s.state();
      expect(JSON.stringify(st.nodes)).not.toContain('DATA-PAGE');
    });
  });

  it('B-NET-2: WebRTC ICE (STUN) traffic bypasses context.route: the page sends UDP to 127.0.0.1', async () => {
    await withSession(async (s) => {
      const before = udpPackets.length;
      await s.open(`${base}/pub/webrtc`);
      await wait(1_500);
      expect(udpPackets.length - before).toBe(0);
    });
  });
});
