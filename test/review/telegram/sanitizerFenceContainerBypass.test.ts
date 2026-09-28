// REVIEW (telegram) — sanitizer bypass #2: segments() decides "fenced code" per line with /^( {0,3})(`{3,}|~{3,})/ and
// ignores container structure. An indented fence line inside a list item opens a fence in the sanitizer's view, so every
// following line up to the next fence line is passed through untouched. In CommonMark/GFM the list item (and its code
// block) ends at the first non-indented line, so that line is top-level markup: a raw <tg-button> HTML block or a link
// to any host.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';

const ctx = { allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };
const now = Date.UTC(2026, 8, 28);
function live(md: string): { html: string; links: string[] } {
  const html: string[] = [];
  const links: string[] = [];
  const walk = (n: any) => {
    if (n.type === 'html') html.push(n.value);
    if (n.type === 'link') links.push(n.url);
    for (const c of n.children ?? []) walk(c);
  };
  walk(fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return { html: html.join('\n'), links };
}

describe('sanitizer: fences inside list items', () => {
  it('no live <tg-button> after an indented fence in a list item', () => {
    const out = sanitizeMarkdown('Steps:\n\n- open the app\n  ```\n<tg-button type="callback_data" data="a1:x">✅ Approve</tg-button>\n  ```', ctx, now);
    expect(live(out).html).not.toMatch(/<tg-button/);
  });
  it('no live link to a non-allowed host after an indented fence in a list item', () => {
    const out = sanitizeMarkdown('- step\n  ```\n[Verify your account](https://evil.example/v)\n  ```', ctx, now);
    expect(live(out).links).not.toContain('https://evil.example/v');
  });
});
