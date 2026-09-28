// missions/watcherConditions.ts (WP6b) — pure, deterministic watcher helpers (01 §2 F10 "Watchers", §6 watcher_create):
// page text normalization, the content hash that is compared first, the deterministic conditions evaluated on a change,
// and the static URL rules applied when a page watcher is created (the SafeFetch rules of §11.5 that can be checked
// without DNS; SafeFetch itself re-validates every address on each fetch).
import { createHash } from 'node:crypto';
import type { MailThreadSummary, WatchCondition } from '../contracts/index.ts';

/** Max characters of the last seen text kept (encrypted) per watcher for the before/after comparison. */
export const LAST_VALUE_MAX_CHARS = 20_000;
/** Semantic watchers keep more of the page: the LLM sees the window around the change, wherever it is. */
export const SEMANTIC_VALUE_MAX_CHARS = 400_000;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', copy: '©', reg: '®', trade: '™', times: '×', minus: '−' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → visible text: scripts/styles/comments dropped, block tags become line breaks, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|dd|dt|blockquote|pre)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return normalizeText(decodeEntities(s));
}

/** Collapses runs of spaces per line, drops empty lines, trims. Deterministic input for the hash. */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\s  ]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** The body of a fetched page as normalized visible text (HTML is stripped; text/JSON is kept as text). */
export function pageText(body: Uint8Array, contentType: string): string {
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(body);
  const looksHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html|head|body|div|p)\b/i.test(raw);
  return looksHtml ? htmlToText(raw) : normalizeText(raw);
}

/** Inbox watchers: one line per thread, newest first; the hash covers only thread ids and dates (unread flips don't count). */
export function inboxSnapshot(threads: MailThreadSummary[]): { text: string; hashInput: string; ids: string[] } {
  const sorted = [...threads].sort((a, b) => b.date - a.date || (a.threadId < b.threadId ? -1 : 1));
  const clean = (x: string) => x.replace(/[\t\n\r]+/g, ' ').trim();
  return {
    text: sorted.map((t) => `${t.threadId}\t${t.date}\t${clean(t.from)}\t${clean(t.subject)}\t${clean(t.snippet)}`).join('\n'),
    hashInput: sorted.map((t) => `${t.threadId}|${t.date}`).join('\n'),
    ids: sorted.map((t) => t.threadId),
  };
}

export function inboxIdsOf(text: string | null): string[] {
  if (!text) return [];
  return text.split('\n').map((l) => l.split('\t')[0] ?? '').filter((x) => x.length > 0);
}

const lower = (s: string) => s.toLocaleLowerCase('en');
export function containsText(hay: string | null, needle: string): boolean {
  if (hay === null) return false;
  const n = lower(needle.trim());
  return n.length > 0 && lower(hay).includes(n);
}

/**
 * Parses one number token such as "231", "1,234.50", "1 234,5", "1.234" (thousands) or "12,99" (decimal).
 * Groups of exactly three digits after a separator are thousands; a trailing 1–2 digit group is decimals.
 */
export function parseNumberToken(tok: string): number | null {
  const t = tok.replace(/[  ']/g, ' ').trim();
  if (!/\d/.test(t)) return null;
  const m = /^(\d{1,3}(?:[ ,.]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const intPart = m[1]!.replace(/[ ,.]/g, '');
  const v = Number(m[2] !== undefined ? `${intPart}.${m[2]}` : intPart);
  return Number.isFinite(v) ? v : null;
}

const NUM_RE = /\d{1,3}(?:[   ,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;
/** Window (chars) around each occurrence of `near_text` searched for numbers. */
export const NEAR_WINDOW = 120;

/** The smallest number found within ±NEAR_WINDOW chars of any occurrence of `near` (case-insensitive), or null. */
export function numberNear(text: string | null, near: string): number | null {
  if (!text) return null;
  const hay = lower(text);
  const n = lower(near.trim());
  if (!n) return null;
  let best: number | null = null;
  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    const i = hay.indexOf(n, from);
    if (i < 0) break;
    const win = text.slice(Math.max(0, i - NEAR_WINDOW), Math.min(text.length, i + n.length + NEAR_WINDOW));
    // the near text itself may contain digits (e.g. "ALA→IST 20 Oct"): drop it from the window before scanning
    const cleaned = win.replace(new RegExp(escapeRegExp(text.slice(i, i + n.length)), 'gi'), ' ');
    for (const m of cleaned.matchAll(NUM_RE)) {
      const v = parseNumberToken(m[0]);
      if (v !== null && (best === null || v < best)) best = v;
    }
    from = i + Math.max(1, n.length);
  }
  return best;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type Evaluation =
  | { kind: 'hit'; summary: string }
  | { kind: 'no_hit' }
  /** Semantic conditions need the LLM (only called because the hash changed). */
  | { kind: 'needs_semantic'; description: string };

/**
 * Evaluates a condition after the content hash changed. Deterministic conditions fire on the transition
 * (not met before → met now), so an unchanged situation never repeats a hit; `changed` fires on every change.
 * `before` is null only when no baseline exists (then nothing fires: the first check just records the baseline).
 */
export function evaluateChange(cond: WatchCondition, before: string | null, after: string, o: { kind: 'page' | 'inbox'; newItems?: number }): Evaluation {
  if (before === null) return { kind: 'no_hit' };
  switch (cond.type) {
    case 'changed':
      if (o.kind === 'inbox') return (o.newItems ?? 0) > 0 ? { kind: 'hit', summary: `${o.newItems} new matching email${o.newItems === 1 ? '' : 's'}` } : { kind: 'no_hit' };
      return { kind: 'hit', summary: 'the page changed' };
    case 'contains':
      return !containsText(before, cond.text) && containsText(after, cond.text) ? { kind: 'hit', summary: `now contains “${clip(cond.text, 80)}”` } : { kind: 'no_hit' };
    case 'absent':
      return containsText(before, cond.text) && !containsText(after, cond.text) ? { kind: 'hit', summary: `“${clip(cond.text, 80)}” is gone` } : { kind: 'no_hit' };
    case 'number_below': {
      const prev = numberNear(before, cond.near_text);
      const cur = numberNear(after, cond.near_text);
      const wasMet = prev !== null && prev < cond.threshold;
      const isMet = cur !== null && cur < cond.threshold;
      return isMet && !wasMet ? { kind: 'hit', summary: `${clip(cond.near_text, 40)} ${fmtNum(cur)} < ${fmtNum(cond.threshold)}` } : { kind: 'no_hit' };
    }
    case 'semantic':
      return { kind: 'needs_semantic', description: cond.description };
  }
}

/** Whether the condition already holds on a snapshot (reported once when the watcher is created; never a hit). */
export function currentlyMet(cond: WatchCondition, text: string): boolean | null {
  switch (cond.type) {
    case 'contains':
      return containsText(text, cond.text);
    case 'absent':
      return !containsText(text, cond.text);
    case 'number_below': {
      const v = numberNear(text, cond.near_text);
      return v === null ? false : v < cond.threshold;
    }
    default:
      return null;
  }
}

/**
 * The bounded snapshot stored as the watcher's last value. Conditions are always evaluated on the FULL fetched text;
 * the snapshot only has to reproduce the condition's "before" state on the next change:
 *  - contains / absent / number_below: the (lower-cased) excerpts around every occurrence of the needle, so a match far
 *    down a long page is kept (number_below keeps ±NEAR_WINDOW, exactly what numberNear reads);
 *  - semantic: the head of the text up to SEMANTIC_VALUE_MAX_CHARS (changedWindow diffs it against the new text);
 *  - changed and inbox snapshots: the head up to LAST_VALUE_MAX_CHARS (inbox text is ≤ 20 short lines).
 */
export function snapshotValue(cond: WatchCondition, text: string, kind: 'page' | 'inbox'): string {
  const head = (n: number) => (text.length > n ? text.slice(0, n) : text);
  if (kind === 'inbox') return head(LAST_VALUE_MAX_CHARS);
  switch (cond.type) {
    case 'contains':
    case 'absent':
      return excerpts(text, cond.text, 0) ?? head(LAST_VALUE_MAX_CHARS);
    case 'number_below':
      return excerpts(text, cond.near_text, NEAR_WINDOW) ?? head(LAST_VALUE_MAX_CHARS);
    case 'semantic':
      return head(SEMANTIC_VALUE_MAX_CHARS);
    default:
      return head(LAST_VALUE_MAX_CHARS);
  }
}

/** Lower-cased excerpts (±pad) around each occurrence of `needle`, merged, ≤ LAST_VALUE_MAX_CHARS; null when absent. */
function excerpts(text: string, needle: string, pad: number): string | null {
  const hay = lower(text);
  const n = lower(needle.trim());
  if (!n) return null;
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    const i = hay.indexOf(n, from);
    if (i < 0) break;
    const a = Math.max(0, i - pad);
    const b = Math.min(hay.length, i + n.length + pad);
    const last = ranges[ranges.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
    from = i + Math.max(1, n.length);
  }
  if (ranges.length === 0) return null;
  const out = ranges.map(([a, b]) => hay.slice(a, b)).join('\n…\n');
  return out.length > LAST_VALUE_MAX_CHARS ? out.slice(0, LAST_VALUE_MAX_CHARS) : out;
}

export function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * The part of the texts around the change (for the semantic check): the common prefix and suffix are cut, keeping
 * `context` chars on each side, and each side is capped at `maxChars`.
 */
export function changedWindow(before: string, after: string, maxChars: number, context = 300): { before: string; after: string } {
  let p = 0;
  const lim = Math.min(before.length, after.length);
  while (p < lim && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let sb = before.length;
  let sa = after.length;
  while (sb > p && sa > p && before.charCodeAt(sb - 1) === after.charCodeAt(sa - 1)) {
    sb--;
    sa--;
  }
  const start = Math.max(0, p - context);
  const cut = (s: string, end: number) => {
    const e = Math.min(s.length, end + context);
    const w = s.slice(start, e);
    return w.length <= maxChars ? w : w.slice(0, maxChars);
  };
  return { before: cut(before, sb), after: cut(after, sa) };
}

// ───────────────────────── URL rules (§11.5), checked when a page watcher is created

const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

export function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return false;
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Static SafeFetch rules: http(s) only, ports 80/443, no credentials, never localhost / *.local / *.internal, never the
 * host of PUBLIC_URL, never a private or reserved IP literal (v4, v6, IPv4-mapped), never a BLOCKED_DOMAINS host.
 */
export function checkWatchUrl(raw: string, o: { publicUrl: string; blockedDomains: readonly string[] }): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http and https URLs can be watched' };
  if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, reason: 'only ports 80 and 443 are allowed' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'missing host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    return { ok: false, reason: 'local addresses are not allowed' };
  }
  let pub = '';
  try {
    pub = new URL(o.publicUrl).hostname.toLowerCase();
  } catch {
    /* no public URL configured */
  }
  if (pub && host === pub) return { ok: false, reason: 'this address is not allowed' };
  if (host.startsWith('[') || host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
    if (mapped) return isPrivateV4(mapped[1]!) ? { ok: false, reason: 'private addresses are not allowed' } : { ok: false, reason: 'IP addresses are not allowed' };
    return { ok: false, reason: 'IP addresses are not allowed' };
  }
  if (v4ToInt(host) !== null) return { ok: false, reason: isPrivateV4(host) ? 'private addresses are not allowed' : 'IP addresses are not allowed' };
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return { ok: false, reason: 'IP addresses are not allowed' };
  for (const d of o.blockedDomains) {
    const b = d.toLowerCase();
    if (host === b || host.endsWith(`.${b}`)) return { ok: false, reason: 'this domain is blocked' };
  }
  return { ok: true, url: u };
}
