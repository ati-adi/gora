// s07 BR — spec 07 A3: the compact snapshot. Caps (groq-free ≤ 1,800 / large ≤ 6,000), deterministic truncation with the
// focused and viewport elements first, password / card values masked, forms grouped.
import { describe, expect, it } from 'vitest';
import type { RawPageState } from '../../../src/contracts/index.ts';
import { buildSnapshot, snapshotCap, MASK } from '../../../src/browser/snapshot.ts';
import { LIMITS, PROVIDER_PROFILES } from '../../../src/config.ts';
import { estimateTokens } from '../../../src/kernel/tokens.ts';
import { FakeBrowser, bookingSite, longPageSite, BOOKING_ORIGIN } from '../../harness/fakeBrowser.ts';
import { extraSite, EXTRA_ORIGIN } from '../../harness/s07-br.ts';

const allow = { check: async () => ({ allow: true as const }) };

async function stateOf(url: string, prep?: (s: import('../../harness/fakeBrowser.ts').FakeBrowserSession) => Promise<void>): Promise<RawPageState> {
  const b = new FakeBrowser([bookingSite(), longPageSite(), extraSite()]);
  const s = (await b.openSession({ taskId: 't', userId: 'u', policy: allow })) as import('../../harness/fakeBrowser.ts').FakeBrowserSession;
  await s.open(url);
  if (prep) await prep(s);
  return s.state();
}

describe('buildSnapshot (A3)', () => {
  it('caps: the groq-free cap (≤ 1,800, and inside the Groq tool-result cap) and the large cap (≤ 6,000)', async () => {
    const raw = await stateOf('https://long.example/');
    const small = snapshotCap(PROVIDER_PROFILES['groq-free']!, LIMITS);
    const large = snapshotCap(PROVIDER_PROFILES.anthropic!, LIMITS);
    expect(small).toBeLessThanOrEqual(1_800);
    expect(small).toBeLessThanOrEqual(LIMITS.groqToolResultMaxTokens);
    expect(large).toBe(6_000);
    for (const cap of [small, 1_800, large]) {
      const snap = buildSnapshot(raw, { maxTokens: cap });
      expect(snap.tokens).toBeLessThanOrEqual(cap);
      expect(estimateTokens(snap.text)).toBeLessThanOrEqual(cap);
      expect(snap.truncated).toBe(true);
      expect(snap.text).toMatch(/more elements\/lines not shown/);
    }
    // the large cap shows more than the small one
    expect(buildSnapshot(raw, { maxTokens: large }).text.length).toBeGreaterThan(buildSnapshot(raw, { maxTokens: small }).text.length);
  });

  it('is deterministic, and keeps the focused element and viewport elements first', async () => {
    const raw = await stateOf('https://long.example/');
    const a = buildSnapshot(raw, { maxTokens: 600 });
    const b = buildSnapshot(structuredClone(raw), { maxTokens: 600 });
    expect(a.text).toBe(b.text);
    // the search box (y=30) and the first links (viewport) are in; far-below links are not
    expect(a.text).toContain('textbox "Search this page"');
    expect(a.text).toContain('Item number 0 ');
    expect(a.text).not.toContain('Item number 300 ');
    const vp = a.text.split('\n').filter((l) => /^ {2}e\d+ link/.test(l)).map((l) => Number(/Item number (\d+)/.exec(l)![1]));
    expect(vp).toEqual([...vp].sort((x, y) => x - y)); // top-to-bottom
    // a focused element (aria `active`) wins over everything else
    const focused = structuredClone(raw);
    const far = focused.nodes.find((n) => n.name === 'Item number 350 with a fairly descriptive title')!;
    far.active = true;
    const f = buildSnapshot(focused, { maxTokens: 300 });
    expect(f.text.split('\n')[3]).toContain('Item number 350');
    expect(f.text).toContain('[focused]');
  });

  it('masks password and card values (Playwright shows them in clear), keeps ordinary values', async () => {
    const login = await stateOf(`${BOOKING_ORIGIN}/login`, async (s) => {
      await s.type('e2', 'me@example.com');
      await s.type('e3', 'hunter2');
    });
    expect(JSON.stringify(login.nodes)).toContain('hunter2'); // the raw aria tree carries it…
    const ls = buildSnapshot(login, { maxTokens: 1_800 });
    expect(ls.text).not.toContain('hunter2'); // …the snapshot never does
    expect(ls.text).toContain(`e3 textbox "Password" value=${MASK}`);
    expect(ls.text).toContain('value="me@example.com"');
    expect(ls.flags.login).toBe(true);
    expect(ls.refs.get('e3')).toMatchObject({ password: true, secret: true, masked: true });

    const pay = await stateOf(`${BOOKING_ORIGIN}/pay`, async (s) => {
      await s.type('e2', '4242 4242 4242 4242');
      await s.type('e3', '123');
    });
    const ps = buildSnapshot(pay, { maxTokens: 1_800 });
    expect(ps.text).not.toContain('4242');
    expect(ps.text).not.toContain('"123"');
    expect(ps.flags.payment).toBe(true);
    expect(ps.refs.get('e2')).toMatchObject({ payment: true, secret: true });
  });

  it('groups forms: fields, the submit button and a search form marked as such', async () => {
    const home = buildSnapshot(await stateOf(`${BOOKING_ORIGIN}/`), { maxTokens: 1_800 });
    expect(home.forms).toEqual([{ id: 'f1', fields: ['e5'], submits: ['e6'], search: true }]);
    expect(home.text).toContain('Forms:');
    expect(home.text).toMatch(/f1 \(search\): e5 "Search restaurants" → submit e6 "Найти"/);
    const book = buildSnapshot(await stateOf(`${BOOKING_ORIGIN}/book?r=alma`), { maxTokens: 1_800 });
    expect(book.forms).toEqual([{ id: 'f2', fields: ['e3', 'e4', 'e5'], submits: ['e6'], search: false }]);
    expect(book.text).toContain('e6 button "Забронировать" [form f2, submit]');
    expect(book.text).toMatch(/e5 combobox "Guests" value="1" options: 1\|2\|4 \[form f2\]/);
    expect(book.text).toContain('e7 link "Pay deposit online" → /pay');
    expect(book.text).toContain('# Book Café Alma');
  });

  it('a very long form stays under the cap and says what was left out', async () => {
    const raw = await stateOf(`${EXTRA_ORIGIN}/long-form`);
    const s = buildSnapshot(raw, { maxTokens: 500 });
    expect(s.tokens).toBeLessThanOrEqual(500);
    expect(s.text).toContain('Field number 0 ');
    expect(s.text).toMatch(/not shown/);
  });

  it('an empty page says so', () => {
    const s = buildSnapshot({ url: 'about:blank', title: '', viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, nodes: [], fields: {}, frameHosts: [], at: 0 }, { maxTokens: 1_800 });
    expect(s.text).toContain('no readable content');
  });
});
