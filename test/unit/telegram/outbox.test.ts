// WP2 — outbox (01 §15.2): ≥ 1 s spacing per private chat (burst 3); ≤ 20/min per group; a 429 retry_after is honored
// through autoRetry → limiter; idempotency; the onSent hook. Plus the markdown chain, binary payloads, ⚠U7, 403, retention.
import { InputFile } from 'grammy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreRepos, OutboxRequest } from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createBot } from '../../../src/telegram/bot.ts';
import { createOutbox, type OutboxImpl } from '../../../src/telegram/outbox.ts';
import { createFakeCrypto, createFakeKeyStore, createMemoryCoreRepos } from '../../harness/fakes.ts';
import { createFakeTelegram, TEST_BOT_INFO, type FakeTelegram } from '../../harness/fakeTelegram.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';
import { step } from './helpers.ts';

let clock: FakeClock;
let tg: FakeTelegram;
let db: TmpDb;
let repos: CoreRepos;
let outbox: OutboxImpl;

async function build(enforce = true) {
  clock = new FakeClock();
  tg = createFakeTelegram({ now: () => clock.now() });
  db = openTmpDb({ now: clock.now() });
  repos = createMemoryCoreRepos(clock);
  const log = createMemoryLogger();
  const { bot, limiter } = await createBot({ token: 'T', apiRoot: 'https://api.telegram.org', testEnv: false, botInfo: TEST_BOT_INFO, transformers: [tg.transformer], clock, log, enforceLimits: enforce });
  outbox = createOutbox({ db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(9)), clock, log, api: () => bot.api, limiter, repos: () => repos, businessRich: false });
}
const msg = (k: string, chatId = 1001, extra: Partial<OutboxRequest> = {}): OutboxRequest => ({ idempotencyKey: k, chatId, method: 'sendMessage', payload: { text: k }, ...extra });

beforeEach(async () => {
  await build();
});
afterEach(async () => {
  await outbox.stop();
  db.cleanup();
});

describe('outbox limits', () => {
  it('private chat: a burst of 3, then ≥ 1 s spacing', async () => {
    outbox.start();
    for (let i = 0; i < 6; i++) outbox.enqueue(msg(`m${i}`));
    await step(clock, 5000, 100);
    const at = tg.callsOf('sendMessage').map((c) => c.at - clock.now() + 5000);
    expect(at).toHaveLength(6);
    expect(at.slice(0, 3)).toEqual([0, 0, 0]);
    for (let i = 3; i < 6; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(tg.byMethod('sendMessage').map((p) => p.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('other chats are not held up by a limited chat', async () => {
    outbox.start();
    for (let i = 0; i < 5; i++) outbox.enqueue(msg(`a${i}`, 1001));
    outbox.enqueue(msg('b0', 2002));
    await step(clock, 100, 50);
    // chats are sent concurrently (review F5): per-chat order holds, the interleaving across chats is not fixed
    const texts = tg.byMethod('sendMessage').map((p) => String(p.text));
    expect(texts.filter((t) => t.startsWith('a'))).toEqual(['a0', 'a1', 'a2']);
    expect(texts).toContain('b0');
  });

  it('group: at most 20 messages in any rolling minute', async () => {
    outbox.start();
    for (let i = 0; i < 25; i++) outbox.enqueue(msg(`g${i}`, -1001234567890));
    await step(clock, 59_000, 1000);
    expect(tg.callsOf('sendMessage')).toHaveLength(20);
    await step(clock, 3_000, 500);
    const at = tg.callsOf('sendMessage').map((c) => c.at);
    expect(at.length).toBeGreaterThan(20);
    for (let i = 20; i < at.length; i++) expect(at[i]! - at[i - 20]!).toBeGreaterThanOrEqual(60_000);
  });

  it('a 429 retry_after is honored: autoRetry waits, the limiter blocks the chat meanwhile', async () => {
    outbox.start();
    tg.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } });
    outbox.enqueue(msg('first'));
    await step(clock, 200, 50);
    outbox.enqueue(msg('second'));
    await step(clock, 8000, 250);
    const calls = tg.callsOf('sendMessage');
    expect(calls.map((c) => c.payload.text)).toEqual(['first', 'first', 'second']);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(calls[2]!.at).toBeGreaterThanOrEqual(calls[0]!.at + 5000);
    expect(outbox.statusOf('first')).toBe('sent');
  });

  it('a long retry_after re-queues the row (not_before) instead of blocking', async () => {
    outbox.start();
    tg.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 120', parameters: { retry_after: 120 } });
    outbox.enqueue(msg('later'));
    await step(clock, 1000, 100);
    expect(outbox.statusOf('later')).toBe('queued');
    await step(clock, 118_000, 2000);
    expect(tg.callsOf('sendMessage')).toHaveLength(1);
    await step(clock, 4000, 500);
    expect(outbox.statusOf('later')).toBe('sent');
    expect(tg.callsOf('sendMessage')).toHaveLength(2);
  });
});

describe('outbox delivery', () => {
  it('is idempotent per key, and sendNow returns the stored refs of a sent row', async () => {
    const a = outbox.enqueue(msg('k1'));
    const b = outbox.enqueue({ ...msg('k1'), payload: { text: 'other' } });
    expect(a).toBe(b);
    await outbox.flush();
    const refs = await outbox.sendNow(msg('k1'));
    expect(tg.callsOf('sendMessage')).toHaveLength(1);
    expect(refs).toEqual([{ chatId: 1001, messageId: (tg.calls[0]!.result as { message_id: number }).message_id, kind: 'plain' }]);
  });

  it('runs onSent hooks with the refs', async () => {
    const seen: string[] = [];
    outbox.onSent('nudge', (id, sent) => seen.push(`${id}:${sent[0]?.messageId}`));
    const refs = await outbox.sendNow({ idempotencyKey: 'n1', chatId: 1001, method: 'sendRichMessage', markdown: '💡 **Nudge**', payload: {}, refKind: 'nudge', refId: 'ng_1' });
    expect(seen).toEqual([`ng_1:${refs[0]!.messageId}`]);
    expect(tg.byMethod('sendRichMessage')[0]).toMatchObject({ chat_id: 1001, rich_message: { markdown: '💡 **Nudge**', skip_entity_detection: true } });
  });

  it('markdown rows use the fallback chain; thread, silence and keyboard are applied', async () => {
    tg.failNext('sendRichMessage', { error_code: 400, description: 'Bad Request: can\'t parse' });
    await outbox.sendNow({ idempotencyKey: 'c1', chatId: 1001, threadId: 12, method: 'sendRichMessage', markdown: '**Hi**', disableNotification: true, payload: { reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] } } });
    const m = tg.byMethod('sendMessage')[0];
    expect(m).toMatchObject({ chat_id: 1001, message_thread_id: 12, text: 'Hi', disable_notification: true, reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] } });
  });

  it('binary methods load payload.blob_id and send an InputFile', async () => {
    const blob = repos.messages.putBlob({ ownerUserId: null, dek: 'sys', mime: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2') });
    await outbox.sendNow({ idempotencyKey: 'd1', chatId: 1001, method: 'sendDocument', payload: { blob_id: blob, filename: 'data.csv', caption: 'Here' } });
    const p = tg.byMethod('sendDocument')[0];
    expect(p.document).toBeInstanceOf(InputFile);
    expect(p.caption).toBe('Here');
    expect(p.blob_id).toBeUndefined();
    await expect(outbox.sendNow({ idempotencyKey: 'd2', chatId: 1001, method: 'sendPhoto', payload: { blob_id: 'b_missing', filename: 'x.png' } })).rejects.toThrow();
    expect(outbox.statusOf('d2')).toBe('dead');
  });

  it('⚠U7: a 400 on editMessageReplyMarkup sets a ✍ reaction instead', async () => {
    tg.failNext('editMessageReplyMarkup', { error_code: 400, description: 'Bad Request: message can\'t be edited' });
    await outbox.sendNow({ idempotencyKey: 'u7', chatId: 1001, method: 'editMessageReplyMarkup', payload: { message_id: 50, reply_markup: { inline_keyboard: [] }, fallback_reaction_to: 49 } });
    expect(tg.byMethod('setMessageReaction')[0]).toEqual({ chat_id: 1001, message_id: 49, reaction: [{ type: 'emoji', emoji: '✍' }] });
    expect(outbox.statusOf('u7')).toBe('sent');
  });

  it('"message is not modified" counts as sent; other 400s and 403 are dead (403 marks the user blocked)', async () => {
    tg.failNext('editMessageText', { error_code: 400, description: 'Bad Request: message is not modified' });
    await outbox.sendNow({ idempotencyKey: 'e1', chatId: 1001, method: 'editMessageText', payload: { message_id: 3, text: 'same' } });
    expect(outbox.statusOf('e1')).toBe('sent');
    const u = repos.users.upsertFromTelegram({ id: 1001, first_name: 'A' }, { dmChatId: 1001 });
    tg.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    await expect(outbox.sendNow({ ...msg('f1'), userId: u.id })).rejects.toThrow();
    expect(outbox.statusOf('f1')).toBe('dead');
    expect(repos.users.getById(u.id)?.botBlocked).toBe(true);
  });

  it('5xx is retried with backoff by the worker', async () => {
    await build(false);
    outbox.start();
    tg.failNext('sendMessage', { error_code: 502, description: 'Bad Gateway' }, 4);
    outbox.enqueue(msg('flaky'));
    await step(clock, 60_000, 1000);
    expect(outbox.statusOf('flaky')).toBe('sent');
  });

  it('retention: payloads nulled after 24 h, rows deleted after 7 days', async () => {
    await outbox.sendNow(msg('old'));
    await clock.advance(25 * 3600_000);
    outbox.retention(clock.now());
    expect(db.db.prepare(`SELECT payload_enc FROM outbox WHERE idempotency_key = 'old'`).get<{ payload_enc: unknown }>()!.payload_enc).toBeNull();
    await clock.advance(7 * 24 * 3600_000);
    outbox.retention(clock.now());
    expect(outbox.statusOf('old')).toBeNull();
  });
});
