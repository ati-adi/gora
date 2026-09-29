// browser/detect.ts (s07 BR, spec 07 A4) — pure detectors: submit/commit actions, payment pages, login walls, captchas.
// Inputs are the capability's RawPageState and the snapshot's RefInfo (untrusted page data: the detectors only ever make
// an action MORE guarded, never less — a page cannot talk its way out of an approval).
import type { AriaNode, RawPageState } from '../contracts/index.ts';
import type { BrowserSnapshot, RefInfo } from './snapshot.ts';

/**
 * A4 commit verbs (EN + RU, with inflections): a click on a button whose accessible name matches, a submit of a
 * non-search form, `browser_type {submit:true}` or Enter in such a form is a commit and always asks.
 */
export const COMMIT_RE = new RegExp(
  [
    String.raw`\b(book|booking|reserve|reservation|confirm|send|submit|order|place order|buy|pay|purchase|check ?out|sign ?up|sign me up|register|registration|enrol|enroll|enrolment|enrollment|subscribe|delete|remove|complete (?:booking|order|purchase|registration)|book now|make (?:a |an )?(?:appointment|reservation|booking))\b`,
    // RU (stems cover the inflections): «Записаться», «Запишите меня», «Запись на приём», «Зарегистрироваться», …
    'бронир', 'бронь', 'подтверд', 'отправ', 'заказ', 'купи', 'покуп', 'оплат', 'зарегистр', 'регистрац', 'подпис', 'удал', 'оформ', 'записа', 'запиш', 'запись', 'записыва',
  ].join('|'),
  'i',
);
/** Payment wording (a commit that spends money → Sentinel class `spend`, which v1 never allows: the owner pays). */
export const PAY_RE = /\b(pay|payment|buy|purchase|check ?out)\b|оплат|купи|покуп/i;
/** Search / navigation-only submit buttons (not commits). */
export const SEARCH_RE = /\b(search|find|go|filter|show|look ?up|next page|more)\b|найти|поиск|искать|показать|фильтр|подобрать|дальше/i;

/** Payment providers whose frames or pages mean "the payment step" (suffix match). */
export const PAYMENT_HOSTS: readonly string[] = [
  'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'yookassa.ru', 'yoomoney.ru', 'cloudpayments.ru', 'cloudpayments.kz', 'pay.kaspi.kz',
  'checkout.com', 'adyen.com', 'braintreegateway.com', 'squareup.com', 'epay.kz', 'epayment.kz', 'tinkoff.ru', 'payze.io', 'ecommpay.com', 'paybox.money',
  'freedompay.money', '2checkout.com', 'klarna.com', 'robokassa.ru', 'payanyway.ru', 'unitpay.ru',
];
const CAPTCHA_HOSTS: readonly string[] = ['recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com', 'arkoselabs.com', 'funcaptcha.com', 'geetest.com', 'smartcaptcha.yandexcloud.net'];
const CAPTCHA_TEXT_RE = /captcha|i['’]?m not a robot|verify (?:that )?you are (?:a )?human|я не робот|подтвердите,? что вы не робот/i;

const hostMatches = (host: string, list: readonly string[]) => {
  const h = host.toLowerCase();
  return list.some((d) => h === d || h.endsWith(`.${d}`));
};
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

function anyNode(nodes: Array<AriaNode | string>, pred: (n: AriaNode | string) => boolean): boolean {
  for (const n of nodes) {
    if (pred(n)) return true;
    if (typeof n !== 'string' && n.children && anyNode(n.children, pred)) return true;
  }
  return false;
}

/** A payment page: card fields (autocomplete cc-*, card/CVC names), a payment-provider frame, or a payment host. */
export function isPaymentPage(raw: RawPageState): boolean {
  for (const f of Object.values(raw.fields)) {
    if (/(^|\s)cc-/.test((f.autocomplete ?? '').toLowerCase())) return true;
    if (/(card.?num|cardnumber|cc-?num|credit.?card|\bcvc\b|\bcvv\b|\bcsc\b|cvc2)/i.test(f.inputName ?? '')) return true;
  }
  if (raw.frameHosts.some((h) => hostMatches(h, PAYMENT_HOSTS))) return true;
  const host = hostOf(raw.url);
  if (host && (hostMatches(host, PAYMENT_HOSTS) || /^(checkout|pay|payment|payments)\./i.test(host))) return true;
  return anyNode(raw.nodes, (n) => typeof n !== 'string' && (n.role === 'textbox' || n.role === 'spinbutton') && /card number|номер карты|\bcvc\b|\bcvv\b/i.test(n.name ?? ''));
}

/** A login wall: any password field on the page (A4: no credential entry in v1). */
export function isLoginWall(raw: RawPageState): boolean {
  for (const f of Object.values(raw.fields)) {
    if (f.type === 'password') return true;
    if (/(^|\s)current-password(\s|$)/.test((f.autocomplete ?? '').toLowerCase())) return true;
  }
  return anyNode(raw.nodes, (n) => typeof n !== 'string' && n.role === 'textbox' && /^(password|пароль)\b/i.test((n.name ?? '').trim()));
}

/** A captcha: a captcha provider frame, or captcha wording in the page. */
export function isCaptchaPage(raw: RawPageState): boolean {
  if (raw.frameHosts.some((h) => hostMatches(h, CAPTCHA_HOSTS))) return true;
  return anyNode(raw.nodes, (n) => (typeof n === 'string' ? CAPTCHA_TEXT_RE.test(n) : CAPTCHA_TEXT_RE.test(`${n.name ?? ''} ${n.text ?? ''}`)));
}

/** The form a ref belongs to and whether it is search-only (a searchbox/role=search form whose button is not a commit). */
export function formOf(snap: BrowserSnapshot, ref: RefInfo): { id: string; search: boolean } | null {
  if (!ref.formId) return null;
  const f = snap.forms.find((x) => x.id === ref.formId);
  return f ? { id: f.id, search: f.search } : null;
}

const CLICKABLE_COMMIT_ROLES = new Set(['button', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'link', 'option', 'tab', 'switch', 'checkbox', 'radio']);

const PERSONAL_FIELD_RE = /(^|\b)(name|first.?name|last.?name|full.?name|surname|email|e-mail|phone|tel|mobile|address|street|city|zip|postal|passport|birth|имя|фамили|отчеств|почт|телефон|адрес|улиц|город|индекс|паспорт|рожден)/i;
const PERSONAL_AUTOCOMPLETE_RE = /(^|\s)(name|given-name|family-name|additional-name|email|tel|tel-national|street-address|address-line\d|address-level\d|postal-code|country|bday|organization)(\s|$)/i;

/** A field that holds personal data (A4): by type, autocomplete, name attribute or label. */
export function isPersonalField(ref: RefInfo | undefined): boolean {
  if (!ref) return false;
  if (ref.fieldType === 'email' || ref.fieldType === 'tel') return true;
  if (ref.autocomplete && PERSONAL_AUTOCOMPLETE_RE.test(ref.autocomplete)) return true;
  return PERSONAL_FIELD_RE.test(`${ref.inputName ?? ''} ${ref.name}`);
}

const STRONG_LABEL_RE = /(full.?name|first.?name|last.?name|given.?name|family.?name|your name|surname|e-?mail|phone|mobile|telephone|passport|date of birth|birth.?date|имя и фамилия|ваше имя|фамили|отчеств|почт|телефон|паспорт|дата рождения)/i;
const EXACT_NAME_RE = /^\s*(name|имя|your name|ваше имя)\s*\*?:?\s*$/i;
const STRONG_INPUT_NAME_RE = /^(name|full_?name|first_?name|last_?name|firstname|lastname|surname|e-?mail|phone|tel|mobile)$/i;
const STRONG_AUTOCOMPLETE_RE = /(^|\s)(name|given-name|family-name|email|tel|tel-national|street-address|bday)(\s|$)/i;

/** A field that identifies a person (a search form's "city" or "date" field is not one). */
function isStrongPersonalField(ref: RefInfo): boolean {
  if (ref.fieldType === 'email' || ref.fieldType === 'tel') return true;
  if (ref.autocomplete && STRONG_AUTOCOMPLETE_RE.test(ref.autocomplete)) return true;
  if (ref.inputName && STRONG_INPUT_NAME_RE.test(ref.inputName)) return true;
  return STRONG_LABEL_RE.test(ref.name) || EXACT_NAME_RE.test(ref.name);
}

/** The form holds a field that identifies a person (then a "search-verb" button name can never make its submit harmless). */
export function formHasPersonalFields(snap: BrowserSnapshot, formId: string | null): boolean {
  if (!formId) return false;
  for (const r of snap.refs.values()) if (r.formId === formId && !r.submit && r.role !== 'button' && isStrongPersonalField(r)) return true;
  return false;
}

/**
 * A link whose href does not navigate anywhere by itself — '#…' on the same page or 'javascript:' — is a scripted
 * action (it behaves like a button: `<a href="#" onclick="form.submit()">Confirm</a>`).
 */
export function isScriptedLink(ref: RefInfo, pageUrl: string | undefined): boolean {
  if (ref.role !== 'link') return false;
  if (!ref.url) return true;
  if (/^\s*javascript:/i.test(ref.url)) return true;
  if (/^\s*#/.test(ref.url)) return true;
  if (!pageUrl) return false; // a relative URL without the page's URL: navigation
  try {
    const u = new URL(ref.url, pageUrl);
    const p = pageUrl ? new URL(pageUrl) : null;
    return !!p && u.origin === p.origin && u.pathname === p.pathname && u.search === p.search; // only the hash differs
  } catch {
    return true;
  }
}

/**
 * A4 submit/commit: a button (or a scripted link: no URL, '#', 'javascript:') whose name matches a commit verb, or a
 * form submit button — unless the form is search-only: a role=search / searchbox form, or a "search verb" button
 * (Find, Show, Next page, Показать…) of a form WITHOUT personal-data fields. A plain link to another page is navigation.
 */
export function isSubmitAction(ref: RefInfo, snap?: BrowserSnapshot): boolean {
  if (!CLICKABLE_COMMIT_ROLES.has(ref.role) && !ref.submit) return false;
  const isNavLink = ref.role === 'link' && !isScriptedLink(ref, snap?.url);
  if (!isNavLink && COMMIT_RE.test(ref.name)) return true;
  if (ref.submit) {
    const personal = snap ? formHasPersonalFields(snap, ref.formId) : false;
    if (personal) return true;
    if (SEARCH_RE.test(ref.name)) return false;
    const f = snap ? formOf(snap, ref) : null;
    if (f?.search) return false;
    if (ref.inSearch) return false;
    return true;
  }
  return false;
}

/** Enter / type-submit inside a field: a commit when the field's form is a commit form (not search-only). */
export function submitsForm(snap: BrowserSnapshot, ref: RefInfo): boolean {
  if (!ref.formId) return false;
  const f = snap.forms.find((x) => x.id === ref.formId);
  if (!f) return false;
  if (formHasPersonalFields(snap, f.id)) return true;
  if (f.search) return false;
  const submits = f.submits.map((id) => snap.refs.get(id)).filter((r): r is RefInfo => !!r);
  if (submits.length && submits.every((r) => SEARCH_RE.test(r.name) && !COMMIT_RE.test(r.name))) return false;
  return true;
}

/** Any control on the page that would commit (the fallback when the focused element is unknown). */
export function pageHasCommit(snap: BrowserSnapshot): boolean {
  for (const r of snap.refs.values()) {
    if (isSubmitAction(r, snap)) return true;
    if (r.formId && !r.submit && submitsForm(snap, r)) return true;
  }
  return false;
}

/** A commit that spends money: payment wording on the control, or the page is a payment page. */
export function isPaymentAction(ref: RefInfo, snap: BrowserSnapshot): boolean {
  return PAY_RE.test(ref.name) || snap.flags.payment;
}
