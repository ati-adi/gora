// REVIEW (telegram) — per-chat ordering is lost after a 429 whose retry_after exceeds autoRetry's 30 s cap: the failed row
// is re-queued with not_before = now + retry_after, while the rows queued behind it keep their older not_before, and the
// sweep orders by (priority, not_before, created_at). When the block lifts, the later message goes out FIRST.
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
    if (method === 'sendMessage' && ++n === 1) return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 45', parameters: { retry_after: 45 } } as any;
    return prev(method, payload, signal);
  };
  const { bot, limiter } = await createBot({ token: 'T', apiRoot: 'https://api.telegram.org', testEnv: false, botInfo: TEST_BOT_INFO, transformers: [tg.transformer, first429], clock, log, enforceLimits: true });
  outbox = createOutbox({ db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(9)), clock, log, api: () => bot.api, limiter, repos: () => createMemoryCoreRepos(clock), businessRich: false });
});
afterEach(async () => {
  await outbox.stop();
  db.cleanup();
});

describe('outbox per-chat order after a long 429', () => {
  it('keeps enqueue order for one chat', async () => {
    outbox.start();
    outbox.enqueue({ idempotencyKey: 'a', chatId: 1001, method: 'sendMessage', payload: { text: 'first' } });
    await step(clock, 100, 50); // 'first' → 429 retry_after 45, re-queued at +45 s
    outbox.enqueue({ idempotencyKey: 'b', chatId: 1001, method: 'sendMessage', payload: { text: 'second' } });
    await step(clock, 60_000, 500);
    expect(tg.callsOf('sendMessage').map((c) => c.payload.text)).toEqual(['first', 'second']);
  });
});
