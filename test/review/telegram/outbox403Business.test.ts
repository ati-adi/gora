// REVIEW (telegram) — outbox.handleError marks users.bot_blocked on ANY 403 to a positive chat id when the row has a
// user_id. Business (Secretary) sends carry userId = the OWNER but chatId = the PEER's private chat plus a
// business_connection_id (surfaces/business/send.ts). A 403 there (peer/connection refuses the bot) flags the OWNER as
// having blocked Gora: reminders/fire.ts then silently drops the owner's reminders, briefs go dead and nudges stop,
// until the owner happens to write to the bot again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreRepos } from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createBot } from '../../../src/telegram/bot.ts';
import { createOutbox, type OutboxImpl } from '../../../src/telegram/outbox.ts';
import { createFakeCrypto, createFakeKeyStore, createMemoryCoreRepos } from '../../harness/fakes.ts';
import { createFakeTelegram, TEST_BOT_INFO, type FakeTelegram } from '../../harness/fakeTelegram.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';

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
  const { bot, limiter } = await createBot({ token: 'T', apiRoot: 'https://api.telegram.org', testEnv: false, botInfo: TEST_BOT_INFO, transformers: [tg.transformer], clock, log, enforceLimits: false });
  outbox = createOutbox({ db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(9)), clock, log, api: () => bot.api, limiter, repos: () => repos, businessRich: false });
});
afterEach(async () => {
  await outbox.stop();
  db.cleanup();
});

describe('403 on a business-connection send', () => {
  it('does not mark the owner as having blocked the bot', async () => {
    const owner = repos.users.upsertFromTelegram({ id: 1001, first_name: 'Owner', language_code: 'en' } as any, { dmChatId: 1001 });
    db.db.prepare('INSERT OR IGNORE INTO users (id, tg_user_id, dm_chat_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(owner.id, 1001, 1001);
    tg.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot is not allowed to send messages to this chat' });
    await outbox
      .sendNow({ idempotencyKey: 'biz:send:x:0', userId: owner.id, chatId: 777_000_555, businessConnectionId: 'bc_1', method: 'sendMessage', payload: { text: 'Sure, 5pm works' }, priority: 0 })
      .catch(() => undefined);
    expect(repos.users.getById(owner.id)!.botBlocked).toBe(false);
  });
});
