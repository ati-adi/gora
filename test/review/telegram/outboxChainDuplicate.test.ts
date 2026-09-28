// REVIEW (telegram) — one outbox row can produce several Telegram messages (the entities/plain rungs of
// sendMarkdownChain split at 4096). When a later chunk fails transiently (429 above autoRetry's cap, 5xx, network), the
// whole row is re-queued and the retry starts again from chunk 0: the chunks that already went out are sent AGAIN
// (and their message ids are never recorded). "Idempotent outbox" does not hold for multi-message rows.
import type { Transformer } from 'grammy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createBot } from '../../../src/telegram/bot.ts';
import { createOutbox, type OutboxImpl } from '../../../src/telegram/outbox.ts';
import { createFakeCrypto, createFakeKeyStore, createMemoryCoreRepos } from '../../harness/fakes.ts';
import { createFakeTelegram, TEST_BOT_INFO, type FakeTelegram } from '../../harness/fakeTelegram.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';
import { step } from '../../unit/telegram/helpers.ts';

let clock: FakeClock;
let tg: FakeTelegram;
let db: TmpDb;
let outbox: OutboxImpl;

beforeEach(async () => {
  clock = new FakeClock();
  tg = createFakeTelegram({ now: () => clock.now() });
  db = openTmpDb({ now: clock.now() });
  const repos = createMemoryCoreRepos(clock);
  const log = createMemoryLogger();
  // an outer test transformer: the 2nd sendMessage call gets a 429 retry_after=45 (above autoRetry's 30 s cap)
  let sm = 0;
  const second429: Transformer = async (prev, method, payload, signal) => {
    if (method === 'sendMessage' && ++sm === 2) return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 45', parameters: { retry_after: 45 } } as any;
    return prev(method, payload, signal);
  };
  const { bot, limiter } = await createBot({ token: 'T', apiRoot: 'https://api.telegram.org', testEnv: false, botInfo: TEST_BOT_INFO, transformers: [tg.transformer, second429], clock, log, enforceLimits: true });
  outbox = createOutbox({ db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(9)), clock, log, api: () => bot.api, limiter, repos: () => repos, businessRich: false });
});
afterEach(async () => {
  await outbox.stop();
  db.cleanup();
});

describe('multi-message outbox row', () => {
  it('a transient failure on chunk 2 does not re-send chunk 1', async () => {
    outbox.start();
    const md = Array.from({ length: 90 }, (_, i) => `Line${i} ${'z'.repeat(90)}`).join('\n\n'); // ~8 600 chars → 3 entity chunks
    tg.failNext('sendRichMessage', { error_code: 400, description: 'Bad Request: can\'t parse rich message' }, 2);
    outbox.enqueue({ idempotencyKey: 'k1', chatId: 1001, method: 'sendRichMessage', markdown: md, payload: {} });
    await step(clock, 90_000, 500);
    const okTexts = tg.callsOf('sendMessage').filter((c) => !c.error).map((c) => String(c.payload.text));
    const firstChunk = okTexts[0]!;
    expect(okTexts.filter((t) => t === firstChunk)).toHaveLength(1);
  });
});
