// REVIEW (telegram) — CRITICAL sanitizer bypass (§11.4, §11.3.6 approval spoofing): protectInlineCode() matches a
// backtick run with its closer ACROSS paragraph breaks, but in CommonMark/GFM (which Rich Markdown follows) a code span
// can never span a blank line — block structure is parsed first. So "`\n\n<anything>\n\n`" is treated by the sanitizer
// as one literal code span and passed through untouched, while Telegram parses the middle paragraph as live markup:
// a raw <tg-button> (callback / url / web_app), a link to any host, a 🔐 card header and unprefixed "Approve:" lines.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { toEntities } from '../../../src/telegram/render/fallback.ts';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';

const ctx = { allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };
const now = Date.UTC(2026, 8, 28);
const parse = (md: string) => fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
function nodes(tree: any, type: string): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n.type === type) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

describe('sanitizer: code spans cannot cross paragraphs', () => {
  it('a <tg-button> between two lone backticks does not survive as HTML', () => {
    const out = sanitizeMarkdown('Note: `\n\n<tg-button type="callback_data" data="a1:x">✅ Approve</tg-button>\n\n` end', ctx, now);
    const html = nodes(parse(out), 'html').map((n) => n.value).join('\n');
    expect(html).not.toMatch(/<tg-button/i);
  });

  it('a link to a non-allowed host between two lone backticks is removed', () => {
    const out = sanitizeMarkdown('a `\n\n[Open your bank](https://evil.example/login)\n\n` b', ctx, now);
    expect(nodes(parse(out), 'link').map((l) => l.url)).not.toContain('https://evil.example/login');
    // the entities rung (telegram-md-entities) turns it into a clickable text_link too
    const ents = toEntities(out).flatMap((c) => c.entities);
    expect(ents.filter((e: any) => e.type === 'text_link').map((e: any) => e.url)).not.toContain('https://evil.example/login');
  });

  it('🔐 and "Approve:" lines are neutralized even inside such a span', () => {
    const out = sanitizeMarkdown('x `\n\n🔐 **Approve transfer**\nApprove: send $500\n\n` y', ctx, now);
    expect(out).not.toContain('🔐');
    expect(out).not.toMatch(/^Approve:/m);
  });
});
