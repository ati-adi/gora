// Review s07 (skeptic, BR, spec 07 A4 network guard) — opt-in (real Chromium): LIVE_BROWSER=1 only, skipped in npm test.
//   LIVE_BROWSER=1 npx vitest run --project unit test/review/s07/netGuardRedirect.live.test.ts
// PlaywrightBrowser enforces the NetworkPolicy with context.route('**/*'). Playwright calls a route handler only for the
// FIRST url of a redirect chain (types.d.ts page.route: "The handler will only be called for the first url if the
// response is a redirect"; verified for context.route with Chromium 153 on this machine). So an allowed public URL that
// answers 302 → http://169.254.169.254/… or http://192.168.1.1/ (documents AND subresources) is followed with no policy
// check: the private page is loaded, snapshotted for the model and screenshotted for the owner.
// Here a local server stands in for "public" (/start, /img allowed) and "private" (/secret*, refused by the policy).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { NetworkPolicy } from '../../../src/contracts/index.ts';
import { PlaywrightBrowser } from '../../../src/browser/playwright.ts';
import { systemClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';

const LIVE = process.env['LIVE_BROWSER'] === '1';

describe.skipIf(!LIVE)('s07 BR review: network guard vs redirects (live Chromium)', () => {
  it('a redirect from an allowed URL to a refused one is refused', async () => {
    const hits: string[] = [];
    const srv = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/start') return res.writeHead(302, { location: '/secret' }).end();
      if (req.url === '/img') return res.writeHead(302, { location: '/secret-img' }).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/secret' ? '<h1>PRIVATE ADMIN</h1><img src="/img">' : 'ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const checked: string[] = [];
    const policy: NetworkPolicy = {
      async check(url) {
        checked.push(new URL(url).pathname);
        return /\/(start|img)$/.test(url) ? { allow: true } : { allow: false, reason: 'private' };
      },
    };
    const b = new PlaywrightBrowser({ headless: true, navigationTimeoutMs: 10_000, actionTimeoutMs: 5_000 }, { clock: systemClock(), log: createMemoryLogger() });
    const s = await b.openSession({ taskId: 'redir', userId: 'u', policy });
    try {
      const r = await s.open(`http://127.0.0.1:${port}/start`);
      await new Promise((ok) => setTimeout(ok, 500));
      // FAILS today: r.ok, the private page was loaded; the policy saw only /start and /img
      expect(hits).not.toContain('/secret');
      expect(hits).not.toContain('/secret-img');
      expect(r.ok).toBe(false);
      expect(checked).toContain('/secret');
    } finally {
      await b.closeAll();
      srv.close();
    }
  });
});
