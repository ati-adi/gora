// Review s07 (skeptic, BR, spec 07 A4 "any action that submits or commits asks"). browser_press is classified from the
// tool's own bookkeeping `focus` (the ref last typed into / clicked), never from the page's real focus, and only for
// Enter (src/browser/classify.ts case 'browser_press'). browser_press Tab is read_public and moves the real focus;
// Space (and Enter) on a focused <button> activates it (standard browser behaviour; playwright.ts does
// page.keyboard.press). So an obedient model (page injection: "press Tab, then Space") commits a booking with no
// approval card: Tab → Tab → Space on «Забронировать» — every step read_public, and the execute-time re-check uses the
// same classifier. The snapshot already knows the real focus (RefInfo.focused from the aria tree's `active`).
import { describe, expect, it } from 'vitest';
import type { RawPageState } from '../../../src/contracts/index.ts';
import { classifyBrowserTool } from '../../../src/browser/classify.ts';
import { buildSnapshot } from '../../../src/browser/snapshot.ts';

// A search form (e1 searchbox + e2 «Найти» submit) followed by a scripted «Забронировать» button that has the focus.
const page: RawPageState = {
  url: 'https://tables.example/results', title: 'Results', viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
  nodes: [{ role: 'main', children: [
    { role: 'search', children: [{ role: 'searchbox', name: 'Search', ref: 'e1', box: { x: 0, y: 10, width: 200, height: 20 } }, { role: 'button', name: 'Найти', ref: 'e2', box: { x: 210, y: 10, width: 60, height: 20 } }] },
    { role: 'button', name: 'Забронировать', ref: 'e3', active: true, box: { x: 0, y: 60, width: 150, height: 30 } },
  ] }],
  fields: {
    e1: { tag: 'input', type: 'search', formId: 'f1', submit: false },
    e2: { tag: 'button', type: 'submit', formId: 'f1', submit: true },
    e3: { tag: 'button', type: 'button', formId: null, submit: false },
  },
  frameHosts: [], at: 0,
};

describe('s07 BR review: key presses on a focused commit button', () => {
  const snap = buildSnapshot(page, { maxTokens: 1_800 });
  it('the snapshot knows «Забронировать» has the focus', () => {
    expect(snap.refs.get('e3')?.focused).toBe(true);
  });
  it('Space on the focused «Забронировать» asks', () => {
    // FAILS today: read_public (only Enter is ever considered)
    expect(classifyBrowserTool('browser_press', { key: 'Space' }, { snap, focus: 'e1', ownerText: '' }).actionClass).toBe('send_external');
  });
  it('Enter while the page focus is on «Забронировать» (the tool last typed into the search box) asks', () => {
    // FAILS today: classified from focus=e1 (a search form) → read_public
    expect(classifyBrowserTool('browser_press', { key: 'Enter' }, { snap, focus: 'e1', ownerText: '' }).actionClass).toBe('send_external');
  });
});
