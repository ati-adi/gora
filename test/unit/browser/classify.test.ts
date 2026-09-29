// s07 BR — spec 07 A4 Sentinel classes: the owner's own data typed → write_self; page-derived personal data → asks;
// a submit → send_external (never grantable); pay → spend (refused in v1); secrets are never shown on a card.
import { describe, expect, it } from 'vitest';
import type { RawPageState } from '../../../src/contracts/index.ts';
import { classifyBrowserTool, isPersonalData, ownerProvided } from '../../../src/browser/classify.ts';
import { buildSnapshot, type BrowserSnapshot } from '../../../src/browser/snapshot.ts';
import { evaluateRules } from '../../../src/trust/rules.ts';
import { FakeBrowser, bookingSite, BOOKING_ORIGIN } from '../../harness/fakeBrowser.ts';
import { extraSite, EXTRA_ORIGIN } from '../../harness/s07-br.ts';

const allow = { check: async () => ({ allow: true as const }) };
async function snapOf(url: string): Promise<BrowserSnapshot> {
  const b = new FakeBrowser([bookingSite(), extraSite()]);
  const s = await b.openSession({ taskId: 't', userId: 'u', policy: allow });
  await s.open(url);
  const raw: RawPageState = await s.state();
  return buildSnapshot(raw, { maxTokens: 1_800 });
}
const OWNER = 'Забронировать столик в Café Alma сегодня на 19:00 на имя Adi, 2 гостя\nтелефон +7 701 234 56 78\nAdi';

describe('classifyBrowserTool (A4)', () => {
  it('reading and navigation are read_public', async () => {
    const snap = await snapOf(`${BOOKING_ORIGIN}/`);
    for (const t of ['browser_open', 'browser_snapshot', 'browser_scroll', 'browser_back']) expect(classifyBrowserTool(t, {}, { snap, focus: null, ownerText: OWNER })).toMatchObject({ actionClass: 'read_public', risk: 0 });
    expect(classifyBrowserTool('browser_click', { ref: 'e7' }, { snap, focus: null, ownerText: OWNER }).actionClass).toBe('read_public'); // a link
    expect(classifyBrowserTool('browser_click', { ref: 'e6' }, { snap, focus: null, ownerText: OWNER }).actionClass).toBe('read_public'); // «Найти»
    expect(classifyBrowserTool('browser_type', { ref: 'e5', text: 'Café Alma', submit: true }, { snap, focus: null, ownerText: OWNER }).actionClass).toBe('write_self');
  });

  it("the owner's own name or phone → write_self; a page-derived email / name → send_external (asks)", async () => {
    const book = await snapOf(`${BOOKING_ORIGIN}/book?r=alma`);
    const env = { snap: book, focus: null, ownerText: OWNER };
    expect(classifyBrowserTool('browser_type', { ref: 'e3', text: 'Adi' }, env)).toMatchObject({ actionClass: 'write_self' });
    expect(classifyBrowserTool('browser_type', { ref: 'e4', text: '+7 (701) 234-56-78' }, env)).toMatchObject({ actionClass: 'write_self' });
    expect(classifyBrowserTool('browser_type', { ref: 'e3', text: 'Hacker' }, env)).toMatchObject({ actionClass: 'send_external', risk: 3, grantable: false });
    expect(classifyBrowserTool('browser_type', { ref: 'e4', text: '+1 555 000 1234' }, env)).toMatchObject({ actionClass: 'send_external' });
    const apply = await snapOf(`${EXTRA_ORIGIN}/apply`);
    expect(classifyBrowserTool('browser_type', { ref: 'e4', text: 'x@evil.com' }, { snap: apply, focus: null, ownerText: OWNER })).toMatchObject({ actionClass: 'send_external' });
    expect(classifyBrowserTool('browser_select', { ref: 'e5', value: '2' }, env).actionClass).toBe('write_self');
  });

  it('a submit is send_external and never grantable; pay is spend (S05 refuses it)', async () => {
    const book = await snapOf(`${BOOKING_ORIGIN}/book?r=alma`);
    const c = classifyBrowserTool('browser_click', { ref: 'e6' }, { snap: book, focus: null, ownerText: OWNER });
    expect(c).toMatchObject({ actionClass: 'send_external', risk: 3, grantable: false });
    expect(classifyBrowserTool('browser_press', { key: 'Enter' }, { snap: book, focus: 'e3', ownerText: OWNER }).actionClass).toBe('send_external');
    expect(classifyBrowserTool('browser_press', { key: 'Tab' }, { snap: book, focus: 'e3', ownerText: OWNER }).actionClass).toBe('read_public');
    expect(classifyBrowserTool('browser_type', { ref: 'e3', text: 'Adi', submit: true }, { snap: book, focus: null, ownerText: OWNER }).actionClass).toBe('send_external');
    const pay = await snapOf(`${BOOKING_ORIGIN}/pay`);
    const p = classifyBrowserTool('browser_click', { ref: 'e4' }, { snap: pay, focus: null, ownerText: OWNER });
    expect(p).toMatchObject({ actionClass: 'spend', risk: 4, grantable: false });
    // Sentinel: the submit asks and is not grantable even in a clean run; spend is refused outright
    const snapshot = {
      userStatus: 'active' as const, memoryConsent: true, incognito: false, tzConfirmed: true, permissions: { gmail: 'none' as const, gcal: 'none' as const },
      connected: { gmail: false, gcal: false }, grants: [], trustedTargetHmacs: new Set<string>(), taint: new Set<never>(), quotaOk: () => true, business: null, now: 0,
    };
    const ask = evaluateRules({ toolName: 'browser_click', toolUseId: 'x', cls: c, targets: [], surface: 'mission', phase: 'propose' }, snapshot);
    expect(ask).toMatchObject({ kind: 'ask', grantable: false });
    const web = evaluateRules({ toolName: 'browser_click', toolUseId: 'x', cls: c, targets: [], surface: 'mission', phase: 'propose' }, { ...snapshot, taint: new Set(['web' as const]) });
    expect(web).toMatchObject({ kind: 'ask', ruleId: 'S14', grantable: false });
    expect(evaluateRules({ toolName: 'browser_click', toolUseId: 'x', cls: p, targets: [], surface: 'mission', phase: 'propose' }, snapshot)).toMatchObject({ kind: 'deny', ruleId: 'S05' });
  });

  it('password / card fields: classified write_self so no card ever shows a secret (the tool refuses to type)', async () => {
    const login = await snapOf(`${BOOKING_ORIGIN}/login`);
    expect(classifyBrowserTool('browser_type', { ref: 'e3', text: 'hunter2' }, { snap: login, focus: null, ownerText: '' }).actionClass).toBe('write_self');
    const pay = await snapOf(`${BOOKING_ORIGIN}/pay`);
    expect(classifyBrowserTool('browser_type', { ref: 'e2', text: '4242 4242 4242 4242' }, { snap: pay, focus: null, ownerText: '' }).actionClass).toBe('write_self');
  });

  it('helpers: ownerProvided (case, quotes, phone digits) and isPersonalData', () => {
    expect(ownerProvided('adi', OWNER)).toBe(true);
    expect(ownerProvided('«Café Alma»', OWNER)).toBe(true);
    expect(ownerProvided('87012345678', 'call me at 8 701 234 56 78')).toBe(true);
    expect(ownerProvided('Hacker', OWNER)).toBe(false);
    expect(isPersonalData('a@b.co', undefined)).toBe(true);
    expect(isPersonalData('+7 701 234 56 78', undefined)).toBe(true);
    expect(isPersonalData('pizza', undefined)).toBe(false);
  });
});
