// telegram/render/escape.ts (WP2) — escaping for code-built Telegram Rich Markdown (cards, footers, status tails).
// Rich Markdown is CommonMark/GFM-compatible, so every ASCII punctuation character may be backslash-escaped. We escape
// exactly the characters that can open or close a construct (emphasis, links, code, HTML, tables, ==mark==, ||spoiler||,
// $latex$, headings, list and quote markers), which makes arbitrary text inert.

const SPECIALS = /[\\`*_[\]()<>#+\-!|~=${}&]/g;

/** Escapes text so that it renders literally inside Rich Markdown (inline context). Newlines are kept. */
export function escapeMd(text: string): string {
  return stripPrivateUse(text).replace(SPECIALS, (c) => `\\${c}`);
}

/** Escapes text for use inside an HTML attribute value or the body of an allowed HTML tag (e.g. <tg-thinking>, <summary>). */
export function escapeHtmlText(text: string): string {
  return stripPrivateUse(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A fence that cannot be closed by the content: one backtick longer than the longest backtick run inside `text`
 * (minimum three). Used for untrusted card bodies (01 §15.2 cards test: "code-block bodies").
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Wraps untrusted text as a literal fenced code block. */
export function codeBlock(text: string, lang = ''): string {
  const body = stripPrivateUse(text).replace(/\r\n?/g, '\n');
  const fence = fenceFor(body);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/**
 * Removes Unicode private-use characters (U+E000–U+F8FF). The sanitizer uses them as internal placeholders, so model or
 * third-party text must never contain them.
 */
export function stripPrivateUse(text: string): string {
  return text.replace(/[-]/g, '');
}
