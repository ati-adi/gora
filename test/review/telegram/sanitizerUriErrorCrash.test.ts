// REVIEW (telegram) — allowedHref() calls decodeURIComponent() on mailto:/tel: paths without a try/catch. A model (or a
// prompt-injected page) writing "[mail me](mailto:a%@b.com)" makes sanitizeMarkdown THROW URIError.
//   - dmStream: compose() → sanitizeFor() runs synchronously inside the draft throttle timer callback (push → compose), so
//     the exception escapes a real setTimeout callback → 'uncaughtException' → main.ts has no handler → the whole bot
//     process exits (every user's runs die).
//   - finalize(): the sanitize throw rejects finalize; engine.finalize only logs it, so the answer is never delivered.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';
import { makeConv, makeEnv, makeRun, step, type Env } from '../../unit/telegram/helpers.ts';

const ctx = { allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };

describe('sanitizer: malformed percent-encoding in mailto/tel', () => {
  it('does not throw', () => {
    expect(() => sanitizeMarkdown('Write to [support](mailto:a%@b.com) or call [us](tel:%ZZ1)', ctx, Date.now())).not.toThrow();
  });
});

describe('dmStream with such a link', () => {
  let e: Env;
  beforeEach(async () => {
    e = await makeEnv();
  });
  afterEach(async () => {
    await e.close();
  });

  it('the draft timer callback does not throw (a real setTimeout throw is an uncaught exception)', async () => {
    const ch = e.mod.channels.forRun(makeRun({ channel: 'dm_stream', replyRef: { chatId: 1001 } }), makeConv(), () => {});
    await ch.begin();
    ch.text('Contact [billing](mailto:100%real@shop.example) for a refund.');
    await expect(step(e.clock, 2000, 100)).resolves.toBeUndefined();
  });

  it('finalize still delivers the answer', async () => {
    const ch = e.mod.channels.forRun(makeRun({ channel: 'dm_stream', replyRef: { chatId: 1001 } }), makeConv(), () => {});
    await ch.begin();
    ch.text('Contact [billing](mailto:100%real@shop.example) for a refund.');
    await ch.finalize({ footerLines: [], effects: [], allowedLinkHosts: new Set(), allowedEmails: new Set() }).catch(() => undefined);
    expect(e.tg.callsOf('sendRichMessage', 'sendMessage').filter((c) => !c.error).length).toBeGreaterThan(0);
  });
});
