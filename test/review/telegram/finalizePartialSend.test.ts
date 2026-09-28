// REVIEW (telegram) — sendDurable() enqueues split parts one by one with outbox.sendNow(); a transient failure of part 0
// (429 with retry_after > autoRetry's 30 s cap, or 5xx/network after autoRetry gives up) makes sendNow throw, so parts
// 1..n (which carry the reply keyboard: Continue / Undo buttons) are NEVER enqueued. The engine only logs "channel finalize
// failed" and marks the run done, so the tail of the answer is lost for good even though part 0 is retried by the pump.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConv, makeEnv, makeRun, step, type Env } from '../../unit/telegram/helpers.ts';

let e: Env;
beforeEach(async () => {
  e = await makeEnv();
});
afterEach(async () => {
  await e.close();
});

describe('final answer split into parts', () => {
  it('every part is eventually delivered after a transient 429 on part 0', async () => {
    e.s.telegram.outbox.start();
    const ch = e.mod.channels.forRun(makeRun({ channel: 'dm_stream', replyRef: { chatId: 1001 } }), makeConv(), () => {});
    await ch.begin();
    // ~36 000 chars in 360 paragraphs → two parts (split at 30 000)
    const paras = Array.from({ length: 360 }, (_, i) => `P${i} ${'y'.repeat(95)}`);
    ch.text(paras.join('\n\n'));
    e.tg.failNext('sendRichMessage', { error_code: 429, description: 'Too Many Requests: retry after 45', parameters: { retry_after: 45 } });
    const undo = [[{ text: 'Undo', callback_data: 'x' }]];
    await ch
      .finalize({ footerLines: [], effects: [{ kind: 'buttons', rows: undo }], allowedLinkHosts: new Set(), allowedEmails: new Set() })
      .catch(() => undefined); // engine.finalize() logs and moves on
    await step(e.clock, 120_000, 1000); // the outbox pump retries whatever it has
    const sent = e.tg.callsOf('sendRichMessage').filter((c) => !c.error).map((c) => String(c.payload.rich_message.markdown));
    const all = sent.join('\n\n');
    expect(all).toContain('P0 ');
    expect(all).toContain('P359 '); // the second part
    expect(e.tg.callsOf('sendRichMessage').some((c) => !c.error && c.payload.reply_markup)).toBe(true); // the keyboard
  });
});
