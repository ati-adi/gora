// REVIEW (telegram) — split AFTER sanitize breaks the sanitizer's code-span protection. A multi-line inline code span
// inside ONE paragraph is legitimately literal (CommonMark lets code spans contain line endings), so the sanitizer leaves
// its content alone. But splitMarkdown() cuts an over-long paragraph between lines (block limit: 405 lines per piece,
// char limit: 27 000) with no regard to open code spans. The part after the cut starts in the middle of the span, the
// closing backtick no longer pairs, and the "code" becomes live Rich Markdown: a raw <tg-button> in its own message.
// Every final answer goes sanitize → split (dmStream/notify/group finalize → sendDurable → render.split).
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';
import { splitMarkdown } from '../../../src/telegram/render/split.ts';

const ctx = { allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };
const now = Date.UTC(2026, 8, 28);
const htmlOf = (md: string): string[] => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.type === 'html') out.push(n.value);
    for (const c of n.children ?? []) walk(c);
  };
  walk(fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return out;
};

describe('sanitize → split', () => {
  it('no part contains a live <tg-button>', () => {
    // one paragraph (no blank lines) of 404 short lines, then a code span spanning the 405th/406th line boundary
    const lines = Array.from({ length: 404 }, (_, i) => `item ${i}`);
    lines.push('see `note');
    lines.push('<tg-button type="callback_data" data="a1:x">✅ Approve</tg-button>');
    lines.push('end` done');
    const intro = Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\n'); // pushes the total over 450 blocks
    const md = `${intro}\n\n${lines.join('\n')}`;
    const safe = sanitizeMarkdown(md, ctx, now);
    expect(htmlOf(safe).join('')).not.toMatch(/<tg-button/); // whole message: the button is inside a code span
    const parts = splitMarkdown(safe);
    for (const p of parts) expect(htmlOf(p).join('')).not.toMatch(/<tg-button/);
  });
});
