// telegram/render/sanitize.ts (WP2) — the output sanitizer of 01 §11.4, applied to ALL model text before any send.
//
// What is code (literal) and what is live markup is decided by a real CommonMark/GFM parse (micromark → mdast), never by
// per-line regexes: a code span cannot cross a blank line, and a fence inside a list item or blockquote ends with its
// container (review F7, F13). Only FENCED code blocks and inline code spans are protected; indented code is sanitized
// like text (Rich Markdown does not list indented code, so it may render as live markup there).
//
// Pipeline:
//   0. never throws; strip private-use chars (our placeholders), normalize newlines; tables wider than 20 columns become
//      code blocks
//   1. protect fenced code and inline code (by parse positions); remove every link reference definition the parser sees
//      (any container, destination on the next line — review F9)
//   2. decode character references outside code (so "&#128272;" / "&#65;pprove:" meet steps 5 — review F8); references
//      to ASCII punctuation, whitespace, controls and private-use chars stay encoded (they cannot form markup)
//   3. remove <tg-button…>, <tg-button-row…>, <tg-collage>, <tg-slideshow>, <tg-map…/>, <img>, <video>, <audio>,
//      <iframe>, <script>, <tg-thinking>, <aside> together with their content
//   4. keep only <details>/<summary> (≤ 16 levels) and valid <tg-time>; every other tag gets its `<` escaped as &lt;
//   5. images → alt text; reference-style images and link definitions removed; reference links → their text; a bare
//      `[label]` gets its bracket escaped (it can never resolve); links kept only for https/http hosts in the allowed set
//      (mailto:/tel: only for trusted targets), otherwise "text (link removed)"
//   6. 🔐 → 🔒 (everywhere, code included); lines (and table cells) whose visible text starts "Approve:" / "✅ Approve" —
//      after quote / list / heading / emphasis markers — get a "↳ " prefix; blockquote depth capped at 16
//   7. VERIFY the result with the parser: no HTML other than details/summary/tg-time, no link to a disallowed target, no
//      image, no resolvable reference, no 🔐, no visible "Approve" line start. On failure the text is sanitized again
//      with every backtick and tilde neutralized (no code at all), and if that still fails it is sent as one literal
//      code block.
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { codeBlock, stripPrivateUse } from './escape.ts';
import { isValidTgTime } from './time.ts';

export interface SanitizeCtx { allowedLinkHosts: ReadonlySet<string>; allowedEmails: ReadonlySet<string>; /** draft rendering: disallowed links keep their text without the marker */ draft?: boolean }

/** Static link hosts that are always allowed (01 §11.4 step 4). */
export const STATIC_LINK_HOSTS: readonly string[] = Object.freeze(['t.me', 'telegram.org']);
export const MAX_TABLE_COLUMNS = 20;
export const MAX_NESTING = 16;

const REMOVE_WITH_CONTENT = ['tg-button-row', 'tg-button', 'tg-collage', 'tg-slideshow', 'tg-map', 'img', 'video', 'audio', 'iframe', 'script', 'tg-thinking', 'aside'];
const NAME_ALT = REMOVE_WITH_CONTENT.map((n) => n.replace(/-/g, '\\-')).join('|');
const PAIRED = new RegExp(`<(${NAME_ALT})(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const LEFTOVER = new RegExp(`<\\/?(?:${NAME_ALT})(?=[\\s/>])[^>]*>`, 'gi');

const P_CODE = '';
const P_TAG = '';
const P_END = '';
const P_DROP = '';
const P_BLOCK = '';

/** The sanitizer. `nowMs` validates <tg-time> (±5 years). Never throws. */
export function sanitizeMarkdown(md: string, ctx: SanitizeCtx, nowMs: number): string {
  return sanitizeWith(md, ctx, nowMs);
}

/**
 * Re-sanitizes one part of an already-sanitized message after a split (review F12): a cut can turn text that was code in
 * the whole message into live markup in a part. Links survive when their target was a live link of `whole` (it passed
 * the sanitizer there); <tg-time> tags are kept when well-formed (they were validated on the whole message).
 */
export function resanitizePart(part: string, whole: string): string {
  return sanitizeWith(part, liveLinkCtx(whole), null);
}

function sanitizeWith(md: string, ctx: SanitizeCtx, nowMs: number | null): string {
  const text = stripPrivateUse(String(md ?? '')).replace(/\r\n?/g, '\n');
  try {
    const first = sanitizePass(text, ctx, nowMs);
    if (isSafe(first, ctx)) return first;
    // something the passes did not neutralize (adversarial input): no code constructs at all this time
    const strict = sanitizePass(text.replace(/`/g, '&#96;').replace(/~/g, '&#126;'), ctx, nowMs);
    if (isSafe(strict, ctx)) return strict;
  } catch {
    /* fall through to the literal rendering */
  }
  return literalFallback(text);
}

/** Last resort: the whole text as one literal code block (🔐 and Approve lines neutralized anyway). */
function literalFallback(text: string): string {
  const body = text
    .replace(/🔐/g, '🔒')
    .split('\n')
    .map((l) => (APPROVE.test(leadText(l, [], [])) ? `↳ ${l}` : l))
    .join('\n');
  return body.trim() ? codeBlock(body) : '';
}

function sanitizePass(input: string, ctx: SanitizeCtx, nowMs: number | null): string {
  let text = input;
  let tree = parse(text);
  const widened = convertWideTables(text, tree);
  if (widened !== text) {
    text = widened;
    tree = parse(text);
  }
  const codes: string[] = [];
  const inline: boolean[] = [];
  const tags: string[] = [];
  let s = protect(text, tree, codes, inline);
  s = decodeCharRefs(s);
  s = removeDangerous(s);
  s = keepAllowedTags(s, tags, nowMs);
  s = removeReferenceDefinitions(s);
  s = rewriteLinksAndImages(s, ctx);
  s = lineRules(s, codes, inline);
  s = restore(s, P_TAG, tags);
  s = restore(s, P_CODE, codes);
  s = restore(s, P_BLOCK, codes);
  return s.replace(/[-]/g, '').replace(/🔐/g, '🔒');
}

// ───────────────────────── parsing

/**
 * CommonMark + GFM parse. <details>/<summary> tags are blanked first (same length, so offsets hold): Rich Markdown parses
 * Markdown inside <details>, while CommonMark would treat the lines after the tag as one raw HTML block.
 */
function parse(md: string): Root {
  const masked = md.replace(/<\/?(?:details|summary)(?=[\s/>])[^>\n]*>/gi, (m) => ' '.repeat(m.length));
  return fromMarkdown(masked, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function visit(n: Nodes, f: (n: Nodes) => boolean | void): void {
  if (f(n) === false) return;
  if ('children' in n) for (const c of n.children as Nodes[]) visit(c, f);
}

function isFenced(src: string, n: Nodes): boolean {
  const o = n.position?.start.offset;
  return o !== undefined && (src[o] === '`' || src[o] === '~');
}

// ───────────────────────── wide tables

/** GFM tables wider than 20 columns (§11.4 step 6) become code blocks. Lines inside fenced code are never touched. */
function convertWideTables(text: string, tree: Root): string {
  const lines = text.split('\n');
  const inFence = new Set<number>();
  visit(tree, (n) => {
    if (n.type === 'code' && isFenced(text, n) && n.position) for (let l = n.position.start.line; l <= n.position.end.line; l++) inFence.add(l - 1);
  });
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (!inFence.has(i) && !inFence.has(i + 1) && line.includes('|') && next !== undefined && isDelimiterRow(next) && countColumns(next) > MAX_TABLE_COLUMNS) {
      const rows = [line, next];
      let j = i + 2;
      for (; j < lines.length && !inFence.has(j) && lines[j]!.trim() !== '' && lines[j]!.includes('|'); j++) rows.push(lines[j]!);
      out.push(codeBlock(rows.join('\n')));
      changed = true;
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return changed ? out.join('\n') : text;
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}
function countColumns(delim: string): number {
  const t = delim.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').length;
}

// ───────────────────────── protection (code) and definition removal, by parse positions

/** Fenced code blocks and inline code spans become placeholders; link reference definitions are removed. */
function protect(text: string, tree: Root, codes: string[], inline: boolean[]): string {
  const ranges: Array<{ start: number; end: number; kind: 'inline' | 'block' | 'drop' }> = [];
  visit(tree, (n) => {
    const p = n.position;
    if (!p || p.start.offset === undefined || p.end.offset === undefined) return;
    if (n.type === 'inlineCode') ranges.push({ start: p.start.offset, end: p.end.offset, kind: 'inline' });
    else if (n.type === 'code' && isFenced(text, n)) ranges.push({ start: p.start.offset, end: p.end.offset, kind: 'block' });
    else if (n.type === 'definition') ranges.push({ start: p.start.offset, end: p.end.offset, kind: 'drop' });
    else return;
    return false;
  });
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const r of ranges) {
    if (r.start < at) continue;
    out += text.slice(at, r.start);
    if (r.kind === 'drop') out += P_DROP;
    else {
      codes.push(text.slice(r.start, r.end));
      inline.push(r.kind === 'inline');
      out += `${r.kind === 'inline' ? P_CODE : P_BLOCK}${codes.length - 1}${P_END}`;
    }
    at = r.end;
  }
  out += text.slice(at);
  if (!out.includes(P_DROP)) return out;
  // a definition that filled its lines removes those lines; one inside a container leaves the container marker
  return out
    .split('\n')
    .filter((l) => !new RegExp(`^\\s*${P_DROP}\\s*$`).test(l))
    .join('\n')
    .replace(new RegExp(P_DROP, 'g'), '');
}

function restore(s: string, marker: string, store: string[]): string {
  const re = new RegExp(`${marker}(\\d+)${P_END}`, 'g');
  return s.replace(re, (_m, i: string) => store[Number(i)] ?? '');
}

// ───────────────────────── character references

/**
 * Decodes numeric and named character references that are not backslash-escaped. References to ASCII characters other
 * than letters and digits, to whitespace / control / private-use characters, and invalid ones stay as written: they
 * render as one inert character and cannot form markup.
 */
function decodeCharRefs(s: string): string {
  return s.replace(/(\\*)&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/g, (m, slashes: string, ref: string) => {
    if (slashes.length % 2 === 1) return m;
    let v: string | false;
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      v = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : false;
    } else v = decodeNamedCharacterReference(ref);
    if (!v) return m;
    for (const ch of v) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80 && !/[A-Za-z0-9]/.test(ch)) return m;
      if ((cp >= 0x80 && cp <= 0x9f) || (cp >= 0xe000 && cp <= 0xf8ff) || /\s/.test(ch)) return m;
    }
    return slashes + v;
  });
}

// ───────────────────────── tags

function removeDangerous(s: string): string {
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(PAIRED, '');
  } while (cur !== prev);
  return cur.replace(LEFTOVER, '');
}

/**
 * <details>/<summary> (nesting ≤ 16) and valid <tg-time> become placeholders; every other tag-like `<` is escaped.
 * `nowMs` null (re-sanitizing a split part): a well-formed tg-time is kept whatever its date.
 */
function keepAllowedTags(s: string, store: string[], nowMs: number | null): string {
  const ph = (tag: string) => {
    store.push(tag);
    return `${P_TAG}${store.length - 1}${P_END}`;
  };
  // tg-time: paired only; invalid → just the inner text.
  let out = s.replace(/<tg-time(?=[\s/>])([^>]*)>([\s\S]*?)<\/tg-time\s*>/gi, (_m, attrs: string, inner: string) => {
    const unix = attr(attrs, 'unix');
    const format = attr(attrs, 'format');
    if (!isValidTgTime(unix, format, nowMs ?? Number(unix) * 1000)) return inner;
    return `${ph(`<tg-time unix="${Number(unix)}"${format !== undefined ? ` format="${format}"` : ''}>`)}${inner}${ph('</tg-time>')}`;
  });
  out = out.replace(/<\/?tg-time(?=[\s/>])[^>]*>/gi, '');
  // details / summary with a depth cap; stray closers are dropped.
  const stack: boolean[] = [];
  out = out.replace(/<(\/?)(details|summary)(?=[\s/>])([^>]*)>/gi, (_m, slash: string, name: string, attrs: string) => {
    if (name.toLowerCase() === 'details') {
      if (!slash) {
        const emit = stack.length < MAX_NESTING;
        stack.push(emit);
        return emit ? ph(/\bopen\b/i.test(attrs) ? '<details open>' : '<details>') : '';
      }
      if (!stack.length) return '';
      return stack.pop() ? ph('</details>') : '';
    }
    return ph(slash ? '</summary>' : '<summary>');
  });
  let closers = '';
  while (stack.length) if (stack.pop()) closers += ph('</details>');
  out += closers ? `\n${closers}` : '';
  // everything else that looks like a tag, comment, declaration or autolink
  return out.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

// ───────────────────────── links and images

/** Link reference definitions (`[x]: https://…`) at a line start are removed too; footnote definitions (`[^1]: …`) are kept. */
function removeReferenceDefinitions(s: string): string {
  return s
    .split('\n')
    .filter((l) => !/^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:\s*\S/.test(l))
    .join('\n');
}

/** Scans for images and links (inline and reference style) and applies §11.4 steps 3–4. */
function rewriteLinksAndImages(s: string, ctx: SanitizeCtx): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    const isImage = c === '!' && s[i + 1] === '[';
    if (c !== '[' && !isImage) {
      out += c;
      i++;
      continue;
    }
    const open = isImage ? i + 1 : i;
    if (!isImage && s[open + 1] === '^') {
      out += c;
      i++;
      continue;
    }
    const close = matchBracket(s, open);
    if (close < 0) {
      out += c;
      i++;
      continue;
    }
    const label = s.slice(open + 1, close);
    const after = s[close + 1];
    if (after === '(') {
      const dest = parseDestination(s, close + 1);
      if (dest) {
        const text = rewriteLinksAndImages(label, ctx);
        if (isImage) out += text;
        else out += linkOrRemoved(text, dest.url, ctx);
        i = dest.end;
        continue;
      }
      // `[text](…` that is not a valid CommonMark link: escape the bracket so no lenient parser can make it one
      out += isImage ? '!\\[' : '\\[';
      i = open + 1;
      continue;
    }
    if (after === '[') {
      const refClose = matchBracket(s, close + 1);
      if (refClose >= 0) {
        // reference-style: images are removed, links keep only their text (the definitions were removed)
        if (!isImage) out += rewriteLinksAndImages(label, ctx);
        i = refClose + 1;
        continue;
      }
    }
    if (isImage) {
      // `![alt]` shortcut reference image: removed
      i = close + 1;
      continue;
    }
    // A shortcut `[label]`: a task-list marker stays; anything else has its bracket escaped, so it can never resolve to
    // a definition that a parser sees and we did not (review F9). It renders the same.
    if (/^[ xX]$/.test(label) && /(?:^|\n)(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+$/.test(out)) out += c;
    else out += '\\[';
    i++;
  }
  return out;
}

function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return k;
    } else if (ch === '\n' && s[k + 1] === '\n') return -1; // links never span paragraphs
  }
  return -1;
}

/** Parses `(dest "title")` starting at the '(' index; returns the raw destination and the index after ')'. */
function parseDestination(s: string, paren: number): { url: string; end: number } | null {
  let k = paren + 1;
  while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
  let url = '';
  if (s[k] === '<') {
    const e = s.indexOf('>', k + 1);
    if (e < 0) return null;
    url = s.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    const start = k;
    for (; k < s.length; k++) {
      const ch = s[k]!;
      if (ch === '\\') {
        k++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    url = s.slice(start, k);
  }
  while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
  const q = s[k];
  if (q === '"' || q === "'" || q === '(') {
    const closeQ = q === '(' ? ')' : q;
    const e = s.indexOf(closeQ, k + 1);
    if (e < 0) return null;
    k = e + 1;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
  }
  if (s[k] !== ')') return null;
  return { url: url.replace(/\\(.)/g, '$1'), end: k + 1 };
}

function linkOrRemoved(text: string, rawUrl: string, ctx: SanitizeCtx): string {
  const href = allowedHref(rawUrl.trim(), ctx);
  if (href) return `[${text}](${href})`;
  // drafts (ctx.draft) show only the text: the run's cited hosts are not known until finalize
  if (ctx.draft) return text;
  return text.trim() ? `${text} (link removed)` : '(link removed)';
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // malformed percent-encoding (review F10): never a trusted target
  }
}

/** The normalized href when the link may survive, else null. Never throws. */
export function allowedHref(raw: string, ctx: SanitizeCtx): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme === 'https:' || scheme === 'http:') {
    if (u.username || u.password) return null;
    if (!hostAllowed(u.hostname, ctx.allowedLinkHosts)) return null;
    return u.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
  }
  if (scheme === 'mailto:') {
    const addr = safeDecode(u.pathname)?.trim().toLowerCase();
    if (addr && !addr.includes(',') && ctx.allowedEmails.has(addr)) return `mailto:${addr}`;
    return null;
  }
  if (scheme === 'tel:') {
    const num = safeDecode(u.pathname)?.replace(/[^\d+]/g, '');
    if (num && (ctx.allowedEmails.has(num) || ctx.allowedEmails.has(`tel:${num}`))) return `tel:${num}`;
    return null;
  }
  return null;
}

export function hostAllowed(hostname: string, allowed: ReadonlySet<string>): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  const bare = h.startsWith('www.') ? h.slice(4) : h;
  if (allowed.has(h) || allowed.has(bare) || allowed.has(`www.${bare}`)) return true;
  for (const st of STATIC_LINK_HOSTS) if (bare === st || bare.endsWith(`.${st}`)) return true;
  return false;
}

// ───────────────────────── line rules

const APPROVE = /^(?:approve\s*:|✅️?\s*approve)/i;
/** Leading constructs that do not show as text: whitespace, quote / list / heading / task markers, emphasis-like markers. */
const LEAD = new RegExp(
  `^(?:\\s+|>|[-*+](?=\\s)|\\d{1,9}[.)](?=\\s)|#{1,6}(?=\\s|$)|\\[[ xX]\\](?=\\s)|[*_~=|\\\\\\[]+|&#(?:32|x20|X20|9|x9|X9|160|xa0|xA0|XA0);|&(?:nbsp|Tab|ensp|emsp|thinsp|NewLine);|[\\u200B-\\u200D\\u2060\\uFEFF\\u00A0]|${P_TAG}\\d+${P_END})`,
);

/** The visible start of a line, for the Approve rule. Leading inline-code placeholders are expanded to their text. */
function leadText(line: string, codes: string[], inline: boolean[]): string {
  let t = line;
  for (let guard = 0; guard < 200; guard++) {
    const m = LEAD.exec(t);
    if (m && m[0].length) {
      t = t.slice(m[0].length);
      continue;
    }
    const c = new RegExp(`^${P_CODE}(\\d+)${P_END}`).exec(t);
    if (c && inline[Number(c[1])]) {
      t = (codes[Number(c[1])] ?? '').replace(/`/g, '') + t.slice(c[0].length);
      continue;
    }
    break;
  }
  return t.slice(0, 64).replace(/[*_~=|\\`[\]​-‍⁠﻿]/g, '');
}

/** 🔐 → 🔒; "Approve:" / "✅ Approve" lines and table cells get "↳ "; blockquote depth ≤ 16. */
function lineRules(s: string, codes: string[], inline: boolean[]): string {
  return s
    .replace(/🔐/g, '🔒')
    .split('\n')
    .map((line) => {
      let l = line;
      const q = /^((?:\s{0,3}>\s?)+)/.exec(l);
      if (q) {
        const depth = (q[1]!.match(/>/g) ?? []).length;
        if (depth > MAX_NESTING) l = `${'> '.repeat(MAX_NESTING)}${l.slice(q[1]!.length)}`;
      }
      if (/(?<!\\)\|/.test(l)) {
        // table cells (and ||spoiler|| runs): each cell whose text starts with Approve gets its own prefix
        l = l
          .split(/(?<!\\)\|/)
          .map((cell, i) => (i > 0 && APPROVE.test(leadText(cell, codes, inline)) ? cell.replace(/^(\s*)/, '$1↳ ') : cell))
          .join('|');
      }
      if (APPROVE.test(leadText(l, codes, inline))) l = `↳ ${l}`;
      return l;
    })
    .join('\n');
}

// ───────────────────────── verification (step 7)

const ALLOWED_HTML = /^<\/?(?:details|summary|tg-time)(?=[\s/>])/i;

/** True when a CommonMark/GFM reading of `out` shows nothing the sanitizer must remove. */
function isSafe(out: string, ctx: SanitizeCtx): boolean {
  if (out.includes('🔐')) return false;
  const tree = parse(out);
  let ok = true;
  visit(tree, (n) => {
    if (!ok) return false;
    switch (n.type) {
      case 'code':
      case 'inlineCode':
        return false;
      case 'html':
        for (const m of n.value.matchAll(/<(?=[A-Za-z/!?])/g)) if (!ALLOWED_HTML.test(n.value.slice(m.index))) ok = false;
        return;
      case 'link': {
        const o = n.position?.start.offset;
        if (o !== undefined && out[o] === '[' && allowedHref(n.url, ctx) === null) ok = false;
        return;
      }
      case 'image':
      case 'imageReference':
      case 'linkReference':
      case 'definition':
        ok = false;
        return false;
      case 'paragraph':
      case 'heading':
      case 'tableCell':
        for (const line of visibleText(n).split('\n')) if (APPROVE.test(line.replace(/^[\s​-‍⁠﻿]+/, ''))) ok = false;
        return;
      default:
        return;
    }
  });
  return ok;
}

/** Rendered text of an inline container (HTML tags contribute nothing, breaks are newlines). */
function visibleText(n: Nodes): string {
  if (n.type === 'text' || n.type === 'inlineCode') return n.value;
  if (n.type === 'break') return '\n';
  if (n.type === 'html') return '';
  if ('children' in n) return (n.children as Nodes[]).map(visibleText).join('');
  return '';
}

/** The sanitizer context under which every live link of `md` survives (for re-sanitizing split parts). */
function liveLinkCtx(md: string): SanitizeCtx {
  const hosts = new Set<string>();
  const emails = new Set<string>();
  try {
    visit(parse(md), (n) => {
      if (n.type === 'code' || n.type === 'inlineCode') return false;
      if (n.type !== 'link' || md[n.position?.start.offset ?? -1] !== '[') return;
      try {
        const u = new URL(n.url);
        if (u.protocol === 'https:' || u.protocol === 'http:') hosts.add(u.hostname.toLowerCase());
        else if (u.protocol === 'mailto:') {
          const a = safeDecode(u.pathname)?.trim().toLowerCase();
          if (a) emails.add(a);
        } else if (u.protocol === 'tel:') {
          const t = safeDecode(u.pathname)?.replace(/[^\d+]/g, '');
          if (t) emails.add(t);
        }
      } catch {
        /* not a URL: not kept */
      }
      return;
    });
  } catch {
    /* no links kept */
  }
  return { allowedLinkHosts: hosts, allowedEmails: emails };
}
