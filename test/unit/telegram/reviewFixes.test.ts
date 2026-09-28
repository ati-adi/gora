// Review fixes (telegram area) — regressions beyond the reviewer's proofs in test/review/telegram/:
//   - sanitizer: a CommonMark reading of the output never has live HTML other than details/summary/tg-time, a link to a
//     disallowed host, an image, a resolvable reference or 🔐 (seeded fuzz over the constructs of F7/F8/F9/F13); it never
//     throws; ordinary Markdown is kept (no fallback);
//   - split: a part of a split message is re-sanitized (a fence inside a blockquote cut in two, F12 class);
//   - outbox: sendNow behind a row waiting for a retry throws OutboxPendingError and both go out in order; a row scheduled
//     for later does not hold its chat (F4/F2);
//   - dispatcher: a handler that hangs past the lease releases its lane (F6).
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreRepos } from '../../../src/contracts/index.ts';
import { FakeClock, flushMicrotasks } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createBot } from '../../../src/telegram/bot.ts';
import { createOutbox, isOutboxPending, type OutboxImpl } from '../../../src/telegram/outbox.ts';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';
import { splitMarkdown } from '../../../src/telegram/render/split.ts';
import { createFakeCrypto, createFakeKeyStore, createMemoryCoreRepos } from '../../harness/fakes.ts';
import { createFakeTelegram, TEST_BOT_INFO, type FakeTelegram } from '../../harness/fakeTelegram.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';
import { U } from '../../harness/updates.ts';
import { makeEnv, step, type Env } from './helpers.ts';

const NOW = Date.UTC(2026, 8, 28);
const ctx = { allowedLinkHosts: new Set(['cited.example']), allowedEmails: new Set<string>() };

type N = any;
function live(md: string): { html: string[]; links: string[]; refs: number; images: number } {
  const out = { html: [] as string[], links: [] as string[], refs: 0, images: 0 };
  const masked = md.replace(/<\/?(?:details|summary)(?=[\s/>])[^>\n]*>/gi, (m) => ' '.repeat(m.length));
  const walk = (n: N) => {
    if (n.type === 'html') out.html.push(n.value);
    if (n.type === 'link' && md[n.position.start.offset] === '[') out.links.push(n.url);
    if (n.type === 'linkReference' || n.type === 'imageReference') out.refs++;
    if (n.type === 'image') out.images++;
    for (const c of n.children ?? []) walk(c);
  };
  walk(fromMarkdown(masked, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return out;
}

describe('sanitizer: parse-level invariants (fuzz)', () => {
  const TOKENS = [
    '`', '``', '```', '~~~', '\n', '\n\n', '- ', '> ', '1. ', '  ', '    ', '# ', '**', '_', '|', '\\', '[', ']', '(', ')',
    '<tg-button type="callback_data" data="a1:x">✅ Approve</tg-button>', '<img src=x>', '<b>', '<details>', '</details>', '<summary>s</summary>',
    '[go](https://evil.example/p)', '[ok](https://cited.example/a)', '[here]', '[here]: https://evil.example/r', '[here]:\n  https://evil.example/n',
    '![i](https://evil.example/i.png)', '&#128272;', '&#65;pprove:', 'Approve:', '✅ Approve', '🔐', 'text', 'mailto:a%@b.c', '[m](mailto:a%@b.c)',
  ];
  it('no live HTML / disallowed link / image / reference / 🔐 survives, and it never throws', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let iter = 0; iter < 400; iter++) {
      let md = '';
      const len = 3 + rnd(25);
      for (let k = 0; k < len; k++) md += TOKENS[rnd(TOKENS.length)];
      const out = sanitizeMarkdown(md, ctx, NOW);
      const l = live(out);
      const why = JSON.stringify({ md, out });
      for (const h of l.html) for (const m of h.matchAll(/<(?=[A-Za-z/!?])/g)) expect(h.slice(m.index), why).toMatch(/^<\/?(?:details|summary|tg-time)(?=[\s/>])/i);
      for (const u of l.links) expect(new URL(u).hostname, why).toBe('cited.example');
      expect(l.refs + l.images, why).toBe(0);
      expect(out, why).not.toContain('🔐');
    }
  });

  it('ordinary Markdown passes through unchanged', () => {
    const md = '### Title\n\n**b** _i_ ~~s~~ ==m== ||sp|| $x$ `c <b>`\n\n1. [src](https://cited.example/a)\n   ```py\n   print("<tg-button>")\n   ```\n- [ ] todo\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | `x|y` |\n\n<details><summary>Sources</summary>\n\n- [s](https://cited.example/b)\n</details>';
    expect(sanitizeMarkdown(md, ctx, NOW)).toBe(md);
  });

  it('fenced code inside <details> without a blank line stays literal', () => {
    const md = '<details><summary>Code</summary>\n```html\n<div>[x](https://evil.example)</div>\n```\n</details>';
    expect(sanitizeMarkdown(md, ctx, NOW)).toBe(md);
  });
});

describe('split: parts are re-sanitized', () => {
  it('a fence inside a blockquote cut in two does not leave a live <tg-button> in a part', () => {
    const lines = ['> ```'];
    for (let i = 0; i < 600; i++) lines.push(`> <tg-button type="callback_data" data="a1:x">✅ Approve ${i}</tg-button>`);
    lines.push('> ```');
    const safe = sanitizeMarkdown(lines.join('\n'), ctx, NOW);
    expect(live(safe).html.join('')).not.toMatch(/tg-button/); // whole message: literal code
    const parts = splitMarkdown(safe);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(live(p).html.join('')).not.toMatch(/tg-button/);
  });

  it('keeps links that were live in the whole message', () => {
    const md = Array.from({ length: 500 }, (_, i) => `line ${i} [src](https://cited.example/${i})`).join('\n');
    const parts = splitMarkdown(sanitizeMarkdown(md, ctx, NOW));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('\n')).toContain('[src](https://cited.example/499)');
    expect(parts.join('\n')).not.toContain('link removed');
  });
});

describe('outbox ordering', () => {
  let clock: FakeClock;
  let tg: FakeTelegram;
  let db: TmpDb;
  let repos: CoreRepos;
  let outbox: OutboxImpl;
  beforeEach(async () => {
    clock = new FakeClock();
    tg = createFakeTelegram({ now: () => clock.now() });
    db = openTmpDb({ now: clock.now() });
    repos = createMemoryCoreRepos(clock);
    const log = createMemoryLogger();
    const { bot, limiter } = await createBot({ token: 'T', apiRoot: 'https://api.telegram.org', testEnv: false, botInfo: TEST_BOT_INFO, transformers: [tg.transformer], clock, log, enforceLimits: true });
    outbox = createOutbox({ db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(9)), clock, log, api: () => bot.api, limiter, repos: () => repos, businessRich: false });
  });
  afterEach(async () => {
    await outbox.stop();
    db.cleanup();
  });

  it('sendNow behind a row waiting for its retry throws OutboxPendingError; both go out in order', async () => {
    outbox.start();
    tg.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 40', parameters: { retry_after: 40 } });
    const first = await outbox.sendNow({ idempotencyKey: 'a', chatId: 1001, method: 'sendMessage', payload: { text: 'first' } }).catch((e: unknown) => e);
    expect(isOutboxPending(first)).toBe(true);
    const second = await outbox.sendNow({ idempotencyKey: 'b', chatId: 1001, method: 'sendMessage', payload: { text: 'second' } }).catch((e: unknown) => e);
    expect(isOutboxPending(second)).toBe(true);
    await step(clock, 45_000, 1000);
    expect(tg.callsOf('sendMessage').filter((c) => !c.error).map((c) => c.payload.text)).toEqual(['first', 'second']);
  });

  it('a row scheduled for later does not hold its chat', async () => {
    outbox.start();
    outbox.enqueue({ idempotencyKey: 'later', chatId: 1001, method: 'sendMessage', payload: { text: 'later' }, notBefore: clock.now() + 3600_000 });
    const refs = await outbox.sendNow({ idempotencyKey: 'now', chatId: 1001, method: 'sendMessage', payload: { text: 'now' } });
    expect(refs).toHaveLength(1);
    expect(outbox.statusOf('later')).toBe('queued');
  });

  it('a 403 in the user own DM still marks bot_blocked', async () => {
    const u = repos.users.upsertFromTelegram({ id: 1001, first_name: 'A' }, { dmChatId: 1001 });
    tg.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    await outbox.sendNow({ idempotencyKey: 'x', userId: u.id, chatId: 1001, method: 'sendMessage', payload: { text: 'x' } }).catch(() => undefined);
    expect(repos.users.getById(u.id)?.botBlocked).toBe(true);
  });
});

describe('dispatcher lease watchdog', () => {
  let e: Env;
  beforeEach(async () => {
    e = await makeEnv();
  });
  afterEach(async () => {
    await e.close();
  });
  const post = (u: unknown) =>
    e.mod.webhookHandler(new Request('https://gora.test/tg/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': e.config.telegram.webhookSecret }, body: JSON.stringify(u) }));

  it('a handler that hangs past the lease releases its lane', async () => {
    const seen: string[] = [];
    let hang = true;
    e.mod.bot.on('message:text', async (ctx) => {
      seen.push(ctx.message.text);
      if (hang) {
        hang = false;
        await new Promise<void>(() => {}); // never settles
      }
    });
    e.mod.dispatcher.start();
    await post(U.privateText('stuck'));
    await post(U.privateText('next'));
    await flushMicrotasks();
    expect(seen).toEqual(['stuck']);
    await e.clock.advance(5 * 60_000 + 1000);
    await flushMicrotasks();
    expect(seen).toEqual(['stuck', 'next']);
  });
});
