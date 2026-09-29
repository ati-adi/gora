// browser/snapshot.ts (s07 BR, spec 07 A3) — the compact, budget-capped page representation the model sees.
// Built from the capability's RawPageState (Playwright's AI aria tree + one DOM pass for FieldInfo). Pure and
// deterministic: the same state and cap always give the same text.
//
//   Title: … / URL: …
//   Page: login wall | payment page | captcha          (only when detected)
//   Interactive (viewport):   eN role "name" [value="…"] [options …] [form fN] [submit] [→ host/path]
//   Forms:                    fN: eA "Name", eB "Phone" → submit eC "Book"
//   Headings / Text:          # heading · short excerpts
//   Below the fold: …         (interactive elements under the viewport)
//   (N more not shown …)
//
// Masking (verified gotcha: Playwright shows password values in clear): a value of an input with type=password,
// autocomplete cc-* / current-password / new-password / one-time-code, or a name/label that looks like a card, CVC,
// IBAN or password is rendered as •••. Truncation keeps, in order: the focused element, viewport interactive elements
// (top-to-bottom), form members, headings, below-fold interactive elements, then text excerpts — until the token cap
// (estimateTokens, LIMITS.browserSnapshotMaxTokensSmall on groq-free / …Large elsewhere).
import type { AriaNode, FieldInfo, RawPageState } from '../contracts/index.ts';
import { estimateTokens } from '../kernel/tokens.ts';
import { isCaptchaPage, isLoginWall, isPaymentPage } from './detect.ts';

export const MASK = '•••';
const NAME_MAX = 80;
const VALUE_MAX = 60;
const TEXT_MAX = 200;
const OPTIONS_MAX = 8;

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'option', 'treeitem',
]);
const TEXT_ROLES = new Set(['paragraph', 'text', 'statictext', 'StaticText', 'cell', 'listitem', 'blockquote', 'caption', 'alert', 'status', 'note', 'definition', 'term', 'strong', 'emphasis', 'generic']);
const SECRET_NAME_RE = /(card.?num|cardnumber|cc-?num|credit.?card|\bcvc\b|\bcvv\b|\bcsc\b|cvc2|security.?code|iban|expir|password|passcode|парол|номер карты|код безопасности)/i;

export interface RefInfo {
  ref: string;
  role: string;
  name: string;
  /** The value as the model may see it (masked when secret). */
  value?: string;
  /** The raw value (never rendered when `masked`; used only to build approval cards, which mask too). */
  rawValue?: string;
  masked: boolean;
  /** Secret field (password / payment): never typed into, never shown. */
  secret: boolean;
  payment: boolean;
  password: boolean;
  formId: string | null;
  submit: boolean;
  fieldType?: string;
  autocomplete?: string;
  inputName?: string;
  url?: string;
  hrefHost?: string;
  inViewport: boolean;
  /** Top of the box in page coordinates (viewport y + scroll) for ordering; Infinity when unknown. */
  y: number;
  x: number;
  focused: boolean;
  disabled: boolean;
  options?: string[];
  /** Order of appearance in the tree. */
  order: number;
  /** The ref sits inside a role=search landmark. */
  inSearch: boolean;
}

export interface SnapshotForm { id: string; fields: string[]; submits: string[]; search: boolean }

export interface BrowserSnapshot {
  text: string;
  refs: Map<string, RefInfo>;
  forms: SnapshotForm[];
  flags: { login: boolean; payment: boolean; captcha: boolean };
  tokens: number;
  truncated: boolean;
  url: string;
  host: string;
  title: string;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const quote = (s: string): string => `"${clip(s, NAME_MAX).replace(/"/g, "'")}"`;

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox']);
const PASSWORD_RE = /password|passcode|passwd|парол/i;
const PAYMENT_NAME_RE = /(card.?num|cardnumber|cc-?num|credit.?card|\bcvc\b|\bcvv\b|\bcsc\b|cvc2|security.?code|iban|expir|номер карты|код безопасности)/i;

/** Password / payment field (by DOM type, autocomplete, name attribute or accessible name). Only fields can be secret. */
export function isSecretField(f: FieldInfo | undefined, name: string, role = 'textbox'): { secret: boolean; payment: boolean; password: boolean } {
  if (!FIELD_ROLES.has(role) && f?.tag !== 'input' && f?.tag !== 'textarea') return { secret: false, payment: false, password: false };
  const ac = (f?.autocomplete ?? '').toLowerCase();
  const inputName = f?.inputName ?? '';
  const password = f?.type === 'password' || /(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(ac) || PASSWORD_RE.test(inputName) || PASSWORD_RE.test(name);
  const payment = /(^|\s)cc-/.test(ac) || PAYMENT_NAME_RE.test(`${inputName} ${name}`);
  return { secret: password || payment || SECRET_NAME_RE.test(inputName), payment, password };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function linkTarget(url: string | undefined, pageUrl: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, pageUrl);
    const base = new URL(pageUrl);
    const path = clip(`${u.pathname}${u.search}`, 60);
    return u.host === base.host ? path : `${u.host}${path === '/' ? '' : path}`;
  } catch {
    return undefined;
  }
}

/** Walks the aria tree once: interactive refs, headings and text excerpts, all in document order. */
function collect(raw: RawPageState): { refs: RefInfo[]; headings: Array<{ text: string; level: number; order: number; y: number }>; texts: Array<{ text: string; order: number }> } {
  const refs: RefInfo[] = [];
  const headings: Array<{ text: string; level: number; order: number; y: number }> = [];
  const texts: Array<{ text: string; order: number }> = [];
  let order = 0;
  const vh = raw.viewport.height;
  const sy = raw.scroll.y;
  const walk = (nodes: Array<AriaNode | string>, inSearch: boolean, parentInteractive: boolean) => {
    for (const n of nodes) {
      order++;
      if (typeof n === 'string') {
        if (!parentInteractive && n.trim()) texts.push({ text: clip(n, TEXT_MAX), order });
        continue;
      }
      const role = n.role;
      const search = inSearch || role === 'search';
      const interactive = INTERACTIVE.has(role) && !!n.ref && !(role === 'option' && parentInteractive);
      if (role === 'heading' && (n.name ?? n.text)) {
        headings.push({ text: clip(n.name ?? n.text ?? '', 120), level: n.level ?? 2, order, y: n.box ? n.box.y + sy : Infinity });
      } else if (interactive) {
        const f = n.ref ? raw.fields[n.ref] : undefined;
        const name = n.name ?? '';
        const sec = isSecretField(f, name, role);
        const rawValue = n.value ?? (role === 'link' || role === 'button' ? undefined : n.text);
        const options = role === 'combobox' || role === 'listbox'
          ? (n.children ?? []).filter((c): c is AriaNode => typeof c !== 'string' && c.role === 'option').map((c) => c.name ?? '').filter(Boolean)
          : undefined;
        const selected = options ? (n.children ?? []).find((c): c is AriaNode => typeof c !== 'string' && c.role === 'option' && !!c.selected)?.name : undefined;
        const value = rawValue ?? selected;
        const box = n.box;
        refs.push({
          ref: n.ref!, role, name, ...(value !== undefined && value !== '' ? { value: sec.secret ? MASK : clip(value, VALUE_MAX), rawValue: value } : {}),
          masked: sec.secret && value !== undefined && value !== '', secret: sec.secret, payment: sec.payment, password: sec.password,
          formId: f?.formId ?? null, submit: !!f?.submit, ...(f?.type ? { fieldType: f.type } : {}), ...(f?.autocomplete ? { autocomplete: f.autocomplete } : {}),
          ...(f?.inputName ? { inputName: f.inputName } : {}), ...(n.url ? { url: n.url } : {}), ...(f?.hrefHost ? { hrefHost: f.hrefHost } : n.url ? { hrefHost: hostOf(new URL(n.url, raw.url).href) } : {}),
          inViewport: box ? box.y + box.height > 0 && box.y < vh : true,
          y: box ? box.y + sy : Infinity, x: box ? box.x : 0, focused: !!n.active && role !== 'generic', disabled: !!n.disabled,
          ...(options ? { options } : {}), order, inSearch: search,
        });
      } else if (TEXT_ROLES.has(role) && n.text && !parentInteractive) {
        texts.push({ text: clip(n.text, TEXT_MAX), order });
      }
      if (n.children?.length) walk(n.children, search, parentInteractive || interactive);
    }
  };
  walk(raw.nodes, false, false);
  return { refs, headings, texts };
}

function refLine(r: RefInfo, pageUrl: string): string {
  const parts = [`${r.ref} ${r.role}${r.name ? ` ${quote(r.name)}` : ''}`];
  if (r.value !== undefined) parts.push(`value=${r.masked ? MASK : quote(r.value)}`);
  if (r.options?.length) parts.push(`options: ${r.options.slice(0, OPTIONS_MAX).map((o) => clip(o, 30)).join('|')}${r.options.length > OPTIONS_MAX ? '|…' : ''}`);
  if (r.formId) parts.push(`[form ${r.formId}${r.submit ? ', submit' : ''}]`);
  else if (r.submit) parts.push('[submit]');
  if (r.disabled) parts.push('[disabled]');
  if (r.focused) parts.push('[focused]');
  const t = r.role === 'link' ? linkTarget(r.url, pageUrl) : undefined;
  if (t) parts.push(`→ ${t}`);
  return parts.join(' ');
}

const byPosition = (a: RefInfo, b: RefInfo) => a.y - b.y || a.x - b.x || a.order - b.order;

export interface SnapshotOptions {
  maxTokens: number;
}

/** The compact snapshot (A3). Deterministic for a given state and cap. */
export function buildSnapshot(raw: RawPageState, o: SnapshotOptions): BrowserSnapshot {
  const { refs, headings, texts } = collect(raw);
  const map = new Map(refs.map((r) => [r.ref, r]));
  // forms (FieldInfo.formId), in order of first appearance
  const formOrder: string[] = [];
  for (const r of refs) if (r.formId && !formOrder.includes(r.formId)) formOrder.push(r.formId);
  const forms: SnapshotForm[] = formOrder.map((id) => {
    const members = refs.filter((r) => r.formId === id);
    const fields = members.filter((r) => !r.submit && r.role !== 'button').map((r) => r.ref);
    const submits = members.filter((r) => r.submit).map((r) => r.ref);
    const search = members.every((r) => r.inSearch || r.fieldType === 'search' || r.role === 'searchbox' || r.submit || r.role === 'button');
    return { id, fields, submits, search };
  });
  const flags = { login: isLoginWall(raw), payment: isPaymentPage(raw), captcha: isCaptchaPage(raw) };
  const host = hostOf(raw.url);

  const head = [`Title: ${clip(raw.title || '(untitled)', 120)}`, `URL: ${clip(raw.url, 200)}`];
  const flagWords = [flags.login ? 'login wall (a password field)' : '', flags.payment ? 'payment page' : '', flags.captcha ? 'captcha' : ''].filter(Boolean);
  if (flagWords.length) head.push(`Page: ${flagWords.join(', ')}`);

  // priority queue of optional lines
  type Item = { section: 'vp' | 'forms' | 'heads' | 'below' | 'text'; key: number; line: string };
  const items: Item[] = [];
  const focused = refs.filter((r) => r.focused);
  const viewport = refs.filter((r) => r.inViewport && !r.focused).sort(byPosition);
  const below = refs.filter((r) => !r.inViewport && !r.focused).sort(byPosition);
  const pushRef = (section: Item['section'], r: RefInfo) => items.push({ section, key: r.order, line: `  ${refLine(r, raw.url)}` });
  for (const r of focused) pushRef('vp', r);
  for (const r of viewport) pushRef('vp', r);
  for (const f of forms) {
    const names = (ids: string[]) => ids.map((id) => `${id}${map.get(id)?.name ? ` ${quote(map.get(id)!.name)}` : ''}`).join(', ');
    items.push({ section: 'forms', key: formOrder.indexOf(f.id), line: `  ${f.id}${f.search ? ' (search)' : ''}: ${names(f.fields) || '(no fields)'}${f.submits.length ? ` → submit ${names(f.submits)}` : ''}` });
  }
  for (const h of headings) items.push({ section: 'heads', key: h.order, line: `${'#'.repeat(Math.min(3, Math.max(1, h.level)))} ${h.text}` });
  for (const r of below) pushRef('below', r);
  for (const t of texts) items.push({ section: 'text', key: t.order, line: t.text });

  const SECTION_TITLES: Record<Item['section'], string> = {
    vp: 'Interactive (viewport):', forms: 'Forms:', heads: 'Headings:', below: 'Below the fold (scroll down):', text: 'Text:',
  };
  const RESERVE = estimateTokens('(999 more elements/lines not shown; scroll or take a new snapshot)\n') + 2;
  let used = estimateTokens(head.join('\n')) + 1;
  const chosen: Item[] = [];
  const opened = new Set<Item['section']>();
  let dropped = 0;
  for (const it of items) {
    const cost = estimateTokens(`${it.line}\n`) + (opened.has(it.section) ? 0 : estimateTokens(`${SECTION_TITLES[it.section]}\n`));
    if (used + cost + RESERVE > o.maxTokens) {
      dropped++;
      continue;
    }
    used += cost;
    opened.add(it.section);
    chosen.push(it);
  }
  const out = [...head];
  for (const sec of ['vp', 'forms', 'heads', 'below', 'text'] as const) {
    const lines = chosen.filter((c) => c.section === sec);
    if (!lines.length) continue;
    // viewport/below stay in their priority (position) order; the rest in document order
    const ordered = sec === 'vp' || sec === 'below' ? lines : [...lines].sort((a, b) => a.key - b.key);
    out.push(SECTION_TITLES[sec], ...ordered.map((l) => l.line));
  }
  if (refs.length === 0 && texts.length === 0 && headings.length === 0) out.push('(the page has no readable content yet)');
  if (dropped) out.push(`(${dropped} more elements/lines not shown; scroll or take a new snapshot)`);
  const text = out.join('\n');
  return { text, refs: map, forms, flags, tokens: estimateTokens(text), truncated: dropped > 0, url: raw.url, host, title: raw.title };
}

/** Room for the tool-result head line and the executor's <untrusted …> wrapper. */
export const SNAPSHOT_WRAP_RESERVE = 80;

/**
 * The snapshot cap for the active provider profile (A3): ≤ 1,800 on groq-free, ≤ 6,000 on larger profiles — and, on
 * any Groq profile, inside the engine's tool-result cap (LIMITS.groqToolResultMaxTokens), so the engine never has to
 * cut the snapshot (or its untrusted wrapper) blindly.
 */
export function snapshotCap(
  profile: { id: string; provider: string },
  limits: { browserSnapshotMaxTokensSmall: number; browserSnapshotMaxTokensLarge: number; groqToolResultMaxTokens: number },
): number {
  const base = profile.id === 'groq-free' ? limits.browserSnapshotMaxTokensSmall : limits.browserSnapshotMaxTokensLarge;
  return profile.provider === 'groq' ? Math.min(base, limits.groqToolResultMaxTokens - SNAPSHOT_WRAP_RESERVE) : base;
}
