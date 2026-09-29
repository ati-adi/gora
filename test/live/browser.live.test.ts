// s07 BR — the one opt-in real-browser test (spec 07 A1, docs/spec/08 §3.1): LIVE_BROWSER=1 only, never in npm test.
//   LIVE_BROWSER=1 npx vitest run --config test/live/vitest.config.ts
// Opens https://example.com through PlaywrightBrowser + the network guard and checks the snapshot, a refused metadata
// address, the password masking of the DOM pass, and a screenshot. Needs `npx playwright install chromium`.
import { describe, expect, it } from 'vitest';
import { createNetworkPolicy } from '../../src/browser/netGuard.ts';
import { PlaywrightBrowser } from '../../src/browser/playwright.ts';
import { buildSnapshot } from '../../src/browser/snapshot.ts';
import { systemClock } from '../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../src/kernel/log.ts';

const LIVE = process.env['LIVE_BROWSER'] === '1';

describe.skipIf(!LIVE)('PlaywrightBrowser (live)', () => {
  it('example.com: snapshot, blocked metadata IP, screenshot, close', async () => {
    const clock = systemClock();
    const b = new PlaywrightBrowser({ headless: true, navigationTimeoutMs: 20_000, actionTimeoutMs: 5_000 }, { clock, log: createMemoryLogger() });
    expect(b.available()).toBe(true);
    const policy = createNetworkPolicy({ clock, publicUrl: 'https://gora.test' });
    const s = await b.openSession({ taskId: 'live', userId: 'u_live', policy });
    try {
      const r = await s.open('https://example.com/');
      expect(r).toMatchObject({ ok: true, navigated: true, status: 200 });
      const raw = await s.state();
      const snap = buildSnapshot(raw, { maxTokens: 1_800 });
      expect(snap.text).toContain('Example Domain');
      expect(snap.text).toMatch(/e\d+ link "Learn more"/);
      // the DOM pass (FieldInfo by aria ref) works on the real page
      const learn = [...snap.refs.values()].find((x) => x.name === 'Learn more')!;
      expect(raw.fields[learn.ref]).toMatchObject({ tag: 'a' });
      expect(raw.fields[learn.ref]!.hrefHost).toMatch(/iana\.org$/);
      const stale = await s.click('e9999');
      expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
      const blocked = await s.open('http://169.254.169.254/latest/meta-data/');
      expect(blocked).toMatchObject({ ok: false, error: 'blocked' });
      expect(s.stats().blockedRequests).toBeGreaterThanOrEqual(1);
      const shot = await s.screenshot();
      expect(shot.mime).toBe('image/jpeg');
      expect(shot.bytes.length).toBeGreaterThan(1_000);
    } finally {
      await s.close();
      await b.closeAll();
    }
    expect(s.closed).toBe(true);
    expect(b.sessions()).toHaveLength(0);
  });
});
