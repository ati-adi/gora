// WP2 — the §11.4 output sanitizer (01 §15.2): strips buttons, media, login_url, img; link host allowlist; 🔐 → 🔒;
// tg-time validated; details kept; table column cap. Plus hygiene and split.
import { describe, expect, it } from 'vitest';
import { hygiene } from '../../../src/telegram/render/hygiene.ts';
import { sanitizeMarkdown, type SanitizeCtx } from '../../../src/telegram/render/sanitize.ts';
import { countBlocks, splitMarkdown } from '../../../src/telegram/render/split.ts';

const NOW = Date.UTC(2026, 8, 28, 9, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const ctx = (hosts: string[] = [], emails: string[] = []): SanitizeCtx => ({ allowedLinkHosts: new Set(hosts), allowedEmails: new Set(emails) });
const san = (md: string, c: SanitizeCtx = ctx()) => sanitizeMarkdown(md, c, NOW);

describe('sanitize: removed elements (step 1)', () => {
  it('strips model-emitted buttons and button rows with their content, including login_url buttons', () => {
    const out = san('Pick one:\n<tg-button-row align="center"><tg-button type="callback_data" data="a1:X">✅ Approve</tg-button></tg-button-row>\n<tg-button type=login_url url="https://evil.example/login">Log in</tg-button>\nend');
    expect(out).not.toMatch(/tg-button/i);
    expect(out).not.toContain('Approve');
    expect(out).not.toContain('Log in');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('Pick one:');
    expect(out).toContain('end');
  });
  it('strips media and embeds: img, video, audio, iframe, script, collage, slideshow, map', () => {
    const out = san('a <img src="https://x/y.png"> b <video src=x></video> c <audio>t</audio> d <iframe src="https://e"></iframe> e <script>alert(1)</script> f <tg-collage>![](https://x/1.png)</tg-collage> g <tg-slideshow>s</tg-slideshow> h <tg-map lat="1" long="2" zoom="3"/> i');
    expect(out).toBe('a  b  c  d  e  f  g  h  i');
  });
  it('removes <tg-thinking> and <aside> from final messages', () => {
    expect(san('<tg-thinking>secret plan</tg-thinking>Answer <aside>note</aside>')).toBe('Answer ');
  });
  it('removes nested and case-varied tags', () => {
    expect(san('<TG-BUTTON type=url url=x>A<tg-button>B</tg-button></TG-BUTTON>C')).not.toMatch(/button|A|B/i);
  });
});

describe('sanitize: allowed tags (step 2)', () => {
  it('keeps <details>/<summary> and escapes every other tag', () => {
    const out = san('<details open><summary>More</summary>\n\nBody <b>bold</b> <a href="https://evil.example">x</a>\n</details>');
    expect(out).toContain('<details open><summary>More</summary>');
    expect(out).toContain('</details>');
    expect(out).toContain('&lt;b>bold&lt;/b>');
    expect(out).toContain('&lt;a href=');
  });
  it('closes unclosed <details> and caps nesting at 16', () => {
    expect(san('<details><summary>x</summary>body')).toMatch(/<\/details>$/);
    const deep = '<details>'.repeat(20) + 'x' + '</details>'.repeat(20);
    const out = san(deep);
    expect((out.match(/<details>/g) ?? []).length).toBe(16);
    expect((out.match(/<\/details>/g) ?? []).length).toBe(16);
  });
  it('validates tg-time: integer unix within ±5 years and a format matching r|w?[dD]?[tT]?', () => {
    const ok = san(`At <tg-time unix="${NOW_S + 3600}" format="wDT">Tue 10:00</tg-time>.`);
    expect(ok).toBe(`At <tg-time unix="${NOW_S + 3600}" format="wDT">Tue 10:00</tg-time>.`);
    expect(san(`<tg-time unix="${NOW_S}" format="r">in 1h</tg-time>`)).toContain('format="r"');
    expect(san(`<tg-time unix="${NOW_S + 6 * 366 * 86400}" format="t">far</tg-time>`)).toBe('far');
    expect(san(`<tg-time unix="12.5" format="t">frac</tg-time>`)).toBe('frac');
    expect(san(`<tg-time unix="${NOW_S}" format="rT">bad</tg-time>`)).toBe('bad');
    expect(san(`<tg-time unix="${NOW_S}" format="x" onclick="y">bad2</tg-time>`)).toBe('bad2');
  });
  it('escapes autolinks and comments', () => {
    expect(san('see <https://evil.example/x> <!-- hidden -->')).toBe('see &lt;https://evil.example/x> &lt;!-- hidden -->');
  });
});

describe('sanitize: media and links (steps 3–4)', () => {
  it('images become their alt text; reference images and link definitions are removed', () => {
    expect(san('![a cat](https://img.example/cat.png "Cat") here')).toBe('a cat here');
    expect(san('![logo][l]\n\n[l]: https://img.example/l.png')).toBe('\n');
    expect(san('Read [the docs][d].\n[d]: https://evil.example/')).toBe('Read the docs.');
  });
  it('keeps links only for https/http hosts in the allowed set plus t.me / telegram.org', () => {
    const c = ctx(['cited.example']);
    expect(san('[ok](https://cited.example/a?b=1)', c)).toBe('[ok](https://cited.example/a?b=1)');
    expect(san('[www](https://www.cited.example/a)', c)).toBe('[www](https://www.cited.example/a)');
    expect(san('[tg](https://t.me/gora_bot) [core](https://core.telegram.org/bots)', c)).toBe('[tg](https://t.me/gora_bot) [core](https://core.telegram.org/bots)');
    expect(san('[evil](https://evil.example/steal?d=secret)', c)).toBe('evil (link removed)');
    expect(san('[sub](https://sub.cited.example/)', c)).toBe('sub (link removed)');
    expect(san('[js](javascript:alert(1))', c)).toBe('js (link removed)');
    expect(san('[userinfo](https://cited.example@evil.example/)', c)).toBe('userinfo (link removed)');
    expect(san('[tg](tg://resolve?domain=x)', c)).toBe('tg (link removed)');
  });
  it('allows mailto:/tel: only for trusted targets', () => {
    const c = ctx([], ['anna@example.com', '+77001234567']);
    expect(san('[mail](mailto:Anna@Example.com)', c)).toBe('[mail](mailto:anna@example.com)');
    expect(san('[mail](mailto:x@evil.com)', c)).toBe('mail (link removed)');
    expect(san('[call](tel:+7 700 123 45 67)', c)).toBe('\\[call](tel:+7 700 123 45 67)'); // not a valid link: the bracket is escaped
    expect(san('[call](tel:+77001234567)', c)).toBe('[call](tel:+77001234567)');
  });
  it('does not touch code spans and fenced code blocks', () => {
    const md = 'Use `<tg-button>` and `[x](https://evil.example)`\n\n```html\n<script>alert(1)</script>\n[x](https://evil.example)\n```';
    expect(san(md)).toBe(md);
  });
  it('keeps footnotes', () => {
    expect(san('Fact[^1].\n\n[^1]: Source text')).toBe('Fact[^1].\n\n[^1]: Source text');
  });
});

describe('sanitize: lookalikes and limits (steps 5–6)', () => {
  it('turns 🔐 into 🔒 and prefixes Approve lines with ↳', () => {
    expect(san('🔐 **Send email?**\nApprove: yes\n✅ Approve and send\n- ✅ Approve item')).toBe('🔒 **Send email?**\n↳ Approve: yes\n↳ ✅ Approve and send\n↳ - ✅ Approve item');
  });
  it('turns tables wider than 20 columns into code blocks and keeps narrower ones', () => {
    const wide = `| ${Array.from({ length: 21 }, (_, i) => `c${i}`).join(' | ')} |\n|${' --- |'.repeat(21)}\n| ${Array.from({ length: 21 }, () => 'v').join(' | ')} |`;
    const out = san(`Table:\n${wide}\nafter`);
    expect(out).toMatch(/^Table:\n```\n\| c0/);
    expect(out).toContain('```\nafter');
    const narrow = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(san(narrow)).toBe(narrow);
  });
  it('caps blockquote depth at 16', () => {
    const out = san(`${'>'.repeat(20)} deep`);
    expect((out.match(/>/g) ?? []).length).toBe(16);
  });
  it('strips private-use placeholder characters from model text', () => {
    expect(san('a0b')).toBe('a0b');
  });
});

describe('hygiene (drafts)', () => {
  it('closes an open fence, $$ and <details>, and drops a partial tag / link at the end', () => {
    expect(hygiene('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n```');
    expect(hygiene('Sum: $$x^2')).toBe('Sum: $$x^2$$');
    expect(hygiene('text <tg-bu')).toBe('text ');
    expect(hygiene('see [site](https://exa')).toBe('see ');
    expect(hygiene('<details><summary>a</summary>\nbody')).toBe('<details><summary>a</summary>\nbody\n</details>');
    expect(hygiene('call `fn')).toBe('call fn');
  });
});

describe('split', () => {
  it('keeps short text whole and splits at 450 blocks / 30 000 chars', () => {
    expect(splitMarkdown('hello')).toEqual(['hello']);
    const many = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const parts = splitMarkdown(many);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(countBlocks(p)).toBeLessThanOrEqual(450);
    const big = Array.from({ length: 40 }, () => 'word '.repeat(400)).join('\n\n');
    for (const p of splitMarkdown(big)) expect(p.length).toBeLessThanOrEqual(30_000);
  });
  it('re-fences a code block that is cut and reopens <details>', () => {
    const code = '```py\n' + Array.from({ length: 8000 }, (_, i) => `print(${i})`).join('\n') + '\n```';
    const parts = splitMarkdown(code);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.startsWith('```py')).toBe(true);
      expect(p.endsWith('```')).toBe(true);
    }
    const det = '<details><summary>Log</summary>\n\n' + Array.from({ length: 600 }, (_, i) => `entry ${i}\n`).join('\n') + '\n</details>';
    const dp = splitMarkdown(det);
    expect(dp.length).toBeGreaterThan(1);
    expect(dp[0]!.endsWith('</details>')).toBe(true);
    expect(dp[1]!.startsWith('<details><summary>Log (cont.)</summary>')).toBe(true);
  });
});
