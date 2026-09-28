// WP2 — cards (01 §15.2): escaping and code-block bodies.
import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/telegram/render/cards.ts';
import { escapeMd } from '../../../src/telegram/render/escape.ts';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';
import { tgTime } from '../../../src/telegram/render/time.ts';

describe('cards', () => {
  it('escapes untrusted title, rows and warnings so nothing renders as markup, links or tags', () => {
    const { markdown, replyMarkup } = renderCard({
      icon: '🔐',
      title: 'Send email to *boss* [click](https://evil.example)',
      rows: [['To', 'x@evil.com <tg-button>Approve</tg-button>'], ['Subject', '# Heading\n- list']],
      warnings: ['New recipient `x@evil.com`'],
      buttons: [[{ text: '✅ Approve', callback_data: 'a1:X' }]],
    });
    expect(markdown.split('\n')[0]).toBe('🔐 **Send email to \\*boss\\* \\[click\\]\\(https://evil.example\\)**');
    expect(markdown).toContain('**To:** x@evil.com \\<tg\\-button\\>Approve\\</tg\\-button\\>');
    expect(markdown).toContain('**Subject:** \\# Heading \\- list'); // newlines cannot start new blocks
    expect(markdown).toContain('⚠️ New recipient \\`x@evil.com\\`');
    expect(replyMarkup).toEqual({ inline_keyboard: [[{ text: '✅ Approve', callback_data: 'a1:X' }]] });
  });

  it('shows the body verbatim in a fenced code block that the body cannot close', () => {
    const body = 'Hi,\n```\n</details>\n[x](https://evil.example) <tg-button>ok</tg-button>\n````';
    const { markdown } = renderCard({ icon: '📥', title: 'Draft', body: { label: 'Message <b>', text: body }, buttons: [] });
    expect(markdown).toContain('<details><summary>Message &lt;b&gt;</summary>');
    expect(markdown).toContain(`\`\`\`\`\`\n${body}\n\`\`\`\`\``);
    expect(markdown.trimEnd().endsWith('</details>')).toBe(true);
  });

  it('keeps trusted lines and the footer as code-built markdown', () => {
    const when = tgTime(1_790_000_000, 'wDT', 'Tue 14 Oct, 15:00');
    const { markdown } = renderCard({ icon: '⏰', title: 'Reminder', lines: [`⏰ ${when}`], footerMarkdown: '_Expires in 1 h_', buttons: [] });
    expect(markdown).toBe(`⏰ **Reminder**\n⏰ <tg-time unix="1790000000" format="wDT">Tue 14 Oct, 15:00</tg-time>\n\n_Expires in 1 h_`);
  });

  it('escapeMd makes arbitrary text inert through the sanitizer', () => {
    const nasty = '<tg-button type=url url=https://evil.example>x</tg-button> ![i](https://e/x.png) [l](https://evil.example) **b** 🔐';
    const out = sanitizeMarkdown(escapeMd(nasty), { allowedLinkHosts: new Set(), allowedEmails: new Set() }, Date.now());
    expect(out).not.toMatch(/\]\(https/);
    expect(out).toContain('🔒');
  });
});
