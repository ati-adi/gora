// test/unit/telegram/helpers.ts (WP2) — a minimal Services built from harness fakes plus the REAL Telegram module over
// FakeTelegram, for the WP2 unit tests.
import type { Update } from 'grammy/types';
import { testConfig, type Config, type DeepPartial } from '../../../src/config.ts';
import type { ConversationKey, ConversationRow, ConversationService, RunRow, Services, TelegramModule, UserRow } from '../../../src/contracts/index.ts';
import { FakeClock, flushMicrotasks } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createCallbackRegistry } from '../../../src/kernel/registries.ts';
import { createTelegramModule } from '../../../src/telegram/index.ts';
import {
  createFakeCapabilities, createFakeCrypto, createFakeKeyStore, createFakeScheduler, createFakeStrings, createMemoryCoreRepos, createMemoryGroups,
  createRecordingGuests, notImplemented,
} from '../../harness/fakes.ts';
import { createFakeTelegram, TEST_BOT_INFO, type FakeTelegram } from '../../harness/fakeTelegram.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';
import { setUpdateClock } from '../../harness/updates.ts';

export interface Env {
  s: Services; tg: FakeTelegram; clock: FakeClock; mod: TelegramModule; db: TmpDb; config: Config;
  log: ReturnType<typeof createMemoryLogger>; strings: ReturnType<typeof createFakeStrings>; scheduler: ReturnType<typeof createFakeScheduler>;
  caps: ReturnType<typeof createFakeCapabilities>; guests: ReturnType<typeof createRecordingGuests>; groups: ReturnType<typeof createMemoryGroups>;
  close(): Promise<void>;
}

export async function makeEnv(o: { config?: DeepPartial<Config>; env?: Record<string, string>; services?: Partial<Services> } = {}): Promise<Env> {
  const clock = new FakeClock();
  setUpdateClock(() => clock.now());
  const db = openTmpDb({ now: clock.now() });
  const config = testConfig({ DATA_DIR: db.dbPath.replace(/\/gora\.db$/, ''), PUBLIC_URL: 'https://gora.test', ...(o.env ?? {}) }, o.config ?? {});
  const tg = createFakeTelegram({ now: () => clock.now() });
  const log = createMemoryLogger();
  const strings = createFakeStrings();
  const scheduler = createFakeScheduler(() => clock);
  const caps = createFakeCapabilities(() => clock.now());
  const guests = createRecordingGuests();
  const groups = createMemoryGroups();
  const s = {
    config, clock, log, db: db.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(7)), repos: createMemoryCoreRepos(clock),
    strings, scheduler, privacyHooks: [], contextProviders: [], runHooks: [], caps, capabilities: caps,
    guests, groups,
    conversations: notImplemented<ConversationService>('conversations', { scopeKeyOf: (k: ConversationKey) => (k.kind === 'dm' ? `dm:${k.tgUserId}${k.threadId ? `:t${k.threadId}` : ''}` : 'x') }),
    side: notImplemented('side', { topicTitle: async () => 'Trip planning' }),
    missions: notImplemented('missions', { setStatusLine: async () => {} }),
    business: notImplemented('business', { noteNoDraft: async () => {} }),
    ...(o.services ?? {}),
  } as unknown as Services;
  const mod = await createTelegramModule(s, { transformers: [tg.transformer], botInfo: TEST_BOT_INFO, fetchImpl: tg.fetch, callbacks: createCallbackRegistry() });
  s.telegram = mod.gateway;
  return {
    s, tg, clock, mod, db, config, log, strings, scheduler, caps, guests, groups,
    async close() {
      await mod.stopIngress();
      await mod.dispatcher.stop();
      await s.telegram.outbox.stop();
      db.cleanup();
    },
  };
}

export function makeUser(s: Services, o: { id?: number; lang?: string } = {}): UserRow {
  const id = o.id ?? 1001;
  const u = s.repos.users.upsertFromTelegram({ id, first_name: 'Aigerim', ...(o.lang ? { language_code: o.lang } : { language_code: 'en' }) }, { dmChatId: id });
  // the in-memory repos do not write gora.db; WP2 tables reference users(id)
  s.db.prepare('INSERT OR IGNORE INTO users (id, tg_user_id, dm_chat_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(u.id, id, id);
  return u;
}

export function makeConv(o: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'c_1', scopeKey: 'dm:1001', kind: 'dm', userId: null, tgChatId: 1001, threadId: null, businessConnectionId: null, route: 'chat', model: 'm', effort: 'medium',
    toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', epoch: 1, rotatePending: null, activeRunId: null, singleShot: false,
    status: 'active', createdAt: 0, lastActivityAt: 0, ...o,
  };
}

export function makeRun(o: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r_1', conversationId: 'c_1', userId: null, epoch: 1, trigger: 'user_input', triggerRef: null, state: 'running', priority: 'interactive', phase: 'model',
    channel: 'dm_stream', replyRef: { chatId: 1001 }, draftId: null, wakeOn: [], wakeAt: null, notBefore: null, turns: 0, continuations: 0, maxTokens: 32000, retries: 0,
    taint: [], costMicros: 0, error: null, leaseUntil: null, createdAt: 0, visibleText: null, stopCategory: null, ...o,
  };
}

/** Advances the fake clock in small steps so chained timers and promises interleave like real time. */
export async function step(clock: FakeClock, ms: number, by = 50): Promise<void> {
  for (let t = 0; t < ms; t += by) await clock.advance(Math.min(by, ms - t));
  await flushMicrotasks();
}

export const drafts = (tg: FakeTelegram) => tg.callsOf('sendRichMessageDraft', 'sendMessageDraft');
export type { Update };
