// REVIEW (telegram) — group placeholder edit: when the rich edit is refused (400), the entities/plain rungs of
// editMarkdownChain only carry the FIRST 4096-char chunk, and group.deliver() only sends parts.slice(1) of the 30 000-char
// split. Everything between char ~4096 and 30 000 of the answer is silently dropped.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_GROUP_ID } from '../../harness/updates.ts';
import { makeConv, makeEnv, makeRun, step, type Env } from '../../unit/telegram/helpers.ts';

let e: Env;
beforeEach(async () => {
  e = await makeEnv();
});
afterEach(async () => {
  await e.close();
});
const fin = { footerLines: [], effects: [], allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };

describe('group placeholder edit fallback', () => {
  it('a 10 000-char answer is delivered in full when the rich edit of the placeholder is refused', async () => {
    const run = makeRun({ channel: 'group', replyRef: { chatId: TEST_GROUP_ID, triggerMessageId: 31 } });
    const ch = e.mod.channels.forRun(run, makeConv({ kind: 'group', tgChatId: TEST_GROUP_ID }), () => {});
    await ch.begin();
    await step(e.clock, 12_500, 500); // placeholder posted
    // 100 paragraphs "P<n> xxxx…" (~100 chars each) = ~10 000 chars; the last one is recognisable
    const paras = Array.from({ length: 100 }, (_, i) => `P${i} ${'x'.repeat(95)}`);
    ch.text(paras.join('\n\n'));
    e.tg.failNext('editMessageText', { error_code: 400, description: 'Bad Request: can\'t parse rich message' });
    await ch.finalize(fin);
    await step(e.clock, 2000, 250);
    const ok = e.tg.callsOf('editMessageText', 'sendMessage', 'sendRichMessage').filter((c) => !c.error).map((c) => c.payload);
    const delivered = ok.map((p) => String(p.text ?? p.rich_message?.markdown ?? '')).join('\n');
    expect(delivered).toContain('P99 ');
  });
});
