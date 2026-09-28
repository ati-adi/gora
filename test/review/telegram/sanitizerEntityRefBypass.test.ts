// REVIEW (telegram) — §11.4 step 5 / §11.3.6 approval spoofing: the 🔐 → 🔒 rewrite and the "Approve:" / "✅ Approve"
// line prefix are plain string checks on the source, but Markdown decodes character references. "&#128272;" renders as
// 🔐 and "&#65;pprove:" as "Approve:" — in CommonMark/GFM (micromark) and in the entities rung (telegram-md-entities) alike.
// The sanitizer itself relies on reference decoding (it escapes "<" as "&lt;"), so Rich Markdown decodes them too.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { describe, expect, it } from 'vitest';
import { toEntities } from '../../../src/telegram/render/fallback.ts';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';

const ctx = { allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };
const now = Date.UTC(2026, 8, 28);
const model = '&#128272; **Approval needed: transfer $900**\n\n&#65;pprove: tap below\n\n&#x2705; Approve';

describe('sanitizer: character references', () => {
  it('rendered text (CommonMark) has no 🔐 and no unprefixed Approve line', () => {
    const rendered = toString(fromMarkdown(sanitizeMarkdown(model, ctx, now)));
    expect(rendered).not.toContain('🔐');
    expect(rendered).not.toMatch(/(^|\n)(Approve:|✅\s*Approve)/);
  });
  it('entities rung text has no 🔐 and no unprefixed Approve line', () => {
    const text = toEntities(sanitizeMarkdown(model, ctx, now)).map((c) => c.text).join('\n');
    expect(text).not.toContain('🔐');
    expect(text).not.toMatch(/(^|\n)(Approve:|✅\s*Approve)/);
  });
  it('formatting variants (heading / bold) of an Approve line are prefixed too', () => {
    for (const md of ['# ✅ Approve', '**Approve:** send $900', '## Approve: wire']) {
      const rendered = toString(fromMarkdown(sanitizeMarkdown(md, ctx, now)));
      expect(rendered).not.toMatch(/^(Approve:|✅\s*Approve)/);
    }
  });
});
