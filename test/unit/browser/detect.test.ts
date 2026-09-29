// s07 BR — spec 07 A4 detectors: submit verbs EN/RU (a search "Найти" is not a commit), payment pages (autocomplete,
// stripe frame, card names), login walls, captchas.
import { describe, expect, it } from 'vitest';
import type { RawPageState } from '../../../src/contracts/index.ts';
import { COMMIT_RE, isCaptchaPage, isLoginWall, isPaymentPage, isSubmitAction, submitsForm } from '../../../src/browser/detect.ts';
import { buildSnapshot, type RefInfo } from '../../../src/browser/snapshot.ts';
import { FakeBrowser, bookingSite, BOOKING_ORIGIN } from '../../harness/fakeBrowser.ts';
import { extraSite, EXTRA_ORIGIN } from '../../harness/s07-br.ts';

const allow = { check: async () => ({ allow: true as const }) };
async function stateOf(url: string): Promise<RawPageState> {
  const b = new FakeBrowser([bookingSite(), extraSite()]);
  const s = await b.openSession({ taskId: 't', userId: 'u', policy: allow });
  await s.open(url);
  return s.state();
}
const ref = (o: Partial<RefInfo> & { role: string; name: string }): RefInfo => ({
  ref: 'e1', masked: false, secret: false, payment: false, password: false, formId: null, submit: false, inViewport: true, y: 0, x: 0, focused: false, disabled: false, order: 1, inSearch: false, ...o,
});

describe('detectors (A4)', () => {
  it.each([
    'Book', 'Book now', 'Reserve a table', 'Confirm', 'Send', 'Submit', 'Place order', 'Order', 'Buy', 'Pay', 'Sign up', 'Register', 'Subscribe', 'Delete account',
    'Забронировать', 'Подтвердить', 'Отправить', 'Заказать', 'Купить', 'Оплатить', 'Зарегистрироваться', 'Подписаться', 'Удалить', 'Оформить заказ', 'Бронирую',
  ])('commit verb: %s', (name) => {
    expect(COMMIT_RE.test(name)).toBe(true);
    expect(isSubmitAction(ref({ role: 'button', name }))).toBe(true);
  });

  it('search / navigation buttons are not commits; a link with a URL is navigation', async () => {
    const home = buildSnapshot(await stateOf(`${BOOKING_ORIGIN}/`), { maxTokens: 1_800 });
    expect(isSubmitAction(home.refs.get('e6')!, home)).toBe(false); // «Найти», a submit of the search form
    expect(submitsForm(home, home.refs.get('e5')!)).toBe(false); // Enter in the search box
    for (const name of ['Search', 'Find', 'Show more', 'Next page', 'Поиск', 'Показать']) expect(isSubmitAction(ref({ role: 'button', name, submit: true }))).toBe(false);
    expect(isSubmitAction(ref({ role: 'link', name: 'Pay deposit online', url: '/pay' }))).toBe(false);
    expect(isSubmitAction(ref({ role: 'link', name: 'Delete' }))).toBe(true); // a scripted link (no URL) acts like a button
    expect(isSubmitAction(ref({ role: 'button', name: 'Open map' }))).toBe(false);
    expect(isSubmitAction(ref({ role: 'textbox', name: 'Book title' }))).toBe(false);
  });

  it('the booking form: «Забронировать» and Enter in its fields are commits', async () => {
    const book = buildSnapshot(await stateOf(`${BOOKING_ORIGIN}/book?r=alma`), { maxTokens: 1_800 });
    expect(isSubmitAction(book.refs.get('e6')!, book)).toBe(true);
    expect(submitsForm(book, book.refs.get('e3')!)).toBe(true);
    // a generic submit ("Continue") of a data form is a commit too
    expect(isSubmitAction(ref({ role: 'button', name: 'Continue', submit: true, formId: 'f2' }), book)).toBe(true);
  });

  it('payment page: autocomplete cc-*, a stripe frame, a payment host, card names', async () => {
    const pay = await stateOf(`${BOOKING_ORIGIN}/pay`);
    expect(isPaymentPage(pay)).toBe(true);
    expect(isPaymentPage({ ...pay, fields: {} })).toBe(true); // the js.stripe.com frame alone
    expect(isPaymentPage({ ...pay, fields: {}, frameHosts: [] })).toBe(true); // «Card number» textbox alone
    const plain = await stateOf(`${BOOKING_ORIGIN}/book?r=alma`);
    expect(isPaymentPage(plain)).toBe(false);
    expect(isPaymentPage({ ...plain, url: 'https://checkout.stripe.com/c/pay/cs_1' })).toBe(true);
    expect(isPaymentPage({ ...plain, url: 'https://pay.example.com/x' })).toBe(true);
  });

  it('login wall (a password field) and captcha', async () => {
    expect(isLoginWall(await stateOf(`${BOOKING_ORIGIN}/login`))).toBe(true);
    expect(isLoginWall(await stateOf(`${BOOKING_ORIGIN}/book?r=alma`))).toBe(false);
    expect(isCaptchaPage(await stateOf(`${EXTRA_ORIGIN}/captcha`))).toBe(true);
    expect(isCaptchaPage(await stateOf(`${BOOKING_ORIGIN}/`))).toBe(false);
  });
});
