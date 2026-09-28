// REVIEW (telegram) — outbox head-of-line blocking: sweep() awaits each row in turn, and autoRetry (a transformer INSIDE
// the call) sleeps up to 30 s on a 429 retry_after (and 3+6+12 s on 5xx/network). While one chat is rate-limited every
// other chat's messages — including other users' final answers and approval cards — wait behind it. The outbox header
// promises "a chat that the limiter says must wait is skipped for this pass so other chats are not held up".
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
  const log = createMemoryLogger();
  let n = 0;
  const first429: Transformer = async (prev, method, payload, signal) => {
    if (method === 'sendMessage' && (payload as { chat_id?: number }).chat_id === 1001 && ++n === 1)
      return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 25', parameters: { retry_after: 25 } } as any;
    return prev(method, payload, signal);
  };
  const { bot, limiter } = await createBot({ token: 'T', apiRoot: 'https://api.telegram.org', testEnv: false, botInfo: TEST_BOT_INFO, transformers: [tg.transformer, first429], clock, log, enforceLimits: true });
  outbox = createOutbox({ db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(9)), clock, log, api: () => bot.api, limiter, repos: () => createMemoryCoreRepos(clock), businessRich: false });
});
afterEach(async () => {
  await step(clock, 30_000, 1000); // let the in-call retry sleep finish so stop() can settle
  await outbox.stop();
  db.cleanup();
});

describe('outbox: a rate-limited chat does not hold up other chats', () => {
  it("chat B's message goes out within 2 s while chat A waits out a 25 s retry_after", async () => {
    outbox.start();
    outbox.enqueue({ idempotencyKey: 'a', chatId: 1001, method: 'sendMessage', payload: { text: 'to A' } });
    outbox.enqueue({ idempotencyKey: 'b', chatId: 2002, method: 'sendMessage', payload: { text: 'to B' } });
    await step(clock, 2000, 100);
    expect(tg.callsOf('sendMessage').map((c) => c.payload.text)).toContain('to B');
  });
});
