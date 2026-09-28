// Shared unit-test environment for WP6a (memory, scheduler, reminders): a real migrated gora.db for the WP6 tables, fake
// crypto over an in-memory key store, in-memory core repos (WP1 contract), and small recording fakes for Telegram.
import type { Services } from '../../../src/contracts/index.ts';
import type { CallbackCtx, CallbackKind, Outbox, OutboxRequest, SentRef, TelegramGateway } from '../../../src/contracts/telegram.ts';
import { testConfig } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createCallbackRegistry } from '../../../src/kernel/registries.ts';
import {
  FakeLlmBudget, createFakeCodec, createFakeCrypto, createFakeKeyStore, createFakeLedger, createFakeQuotas, createFakeRenderer,
  createFakeRunner, createFakeStrings, createMemoryCoreRepos, createMemoryGroups, createMemoryLinks, createMemoryToolkitState,
} from '../../harness/fakes.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';

export interface RecordingOutbox extends Outbox {
  queued: OutboxRequest[];
  sentNow: OutboxRequest[];
  failSendNow: number;
}

export function recordingOutbox(): RecordingOutbox {
  let mid = 5000;
  const seen = new Set<string>();
  const ob: RecordingOutbox = {
    queued: [],
    sentNow: [],
    failSendNow: 0,
    enqueue(r) {
      if (!seen.has(r.idempotencyKey)) {
        seen.add(r.idempotencyKey);
        ob.queued.push(r);
      }
      return r.idempotencyKey;
    },
    async sendNow(r) {
      if (ob.failSendNow > 0) {
        ob.failSendNow--;
        throw Object.assign(new Error('Bad Request: message can not be edited'), { error_code: 400 });
      }
      ob.sentNow.push(r);
      return [{ chatId: r.chatId, messageId: ++mid, kind: 'rich' } satisfies SentRef];
    },
    onSent() {},
    start() {},
    async stop() {},
    async flush() {
      return 0;
    },
  };
  return ob;
}

export type TestEnv = ReturnType<typeof makeEnv>;

export function makeEnv(o: { now?: number; provider?: 'groq' | 'anthropic' } = {}) {
  const clock = new FakeClock(o.now);
  const tmp = openTmpDb();
  const keyStore = createFakeKeyStore();
  const crypto = createFakeCrypto(keyStore, new Uint8Array(32).fill(7));
  const repos = createMemoryCoreRepos(clock);
  const log = createMemoryLogger();
  const outbox = recordingOutbox();
  const links = createMemoryLinks();
  const callbacks = createCallbackRegistry();
  const reactions: Array<{ chatId: number; messageId: number; emoji: string }> = [];
  const chatMembers = new Map<string, string>();
  const api = {
    getChatMember: async (chatId: number, userId: number) => ({ status: chatMembers.get(`${chatId}:${userId}`) ?? 'member', user: { id: userId } }),
  };
  const telegram = {
    api, outbox, links, callbacks, codec: createFakeCodec(), render: createFakeRenderer(() => { throw new Error('no api in unit tests'); }),
    flags: { topics: true, guest: true, business: true, mainWebApp: true, usersCanCreateTopics: true },
  } as unknown as TelegramGateway;
  const config = testConfig({ LLM_PROVIDER: o.provider ?? 'anthropic' });
  const runner = createFakeRunner();
  const ledger = createFakeLedger(clock);
  const llmBudget = new FakeLlmBudget();
  const groups = createMemoryGroups();
  const side = {
    extractCalls: [] as Array<{ inputs: Array<{ id: string; text: string }>; existing: Array<{ id: string; text: string }> }>,
    extractResult: null as unknown,
    importResult: [] as Array<{ text: string; kind: string; sensitivity: 'normal' | 'sensitive' }>,
    async triage() {
      return null;
    },
    async extract(i: { inputs: Array<{ id: string; text: string }>; existing: Array<{ id: string; text: string }> }) {
      side.extractCalls.push({ inputs: i.inputs, existing: i.existing });
      return side.extractResult as never;
    },
    async importFacts() {
      return side.importResult as never;
    },
    async topicTitle() {
      return null;
    },
    async semanticCheck() {
      return null;
    },
    // friend mode (spec 05): scripted structured calls (consolidate), validated against the caller's schema like the transport
    structuredCalls: [] as Array<{ purpose: string; role?: string; system: string; user: string; meta?: unknown }>,
    structuredQueue: [] as unknown[],
    async structured(req: { purpose: string; role?: 'fast' | 'main'; system: string; user: string; schema: { parse(v: unknown): unknown } }, meta?: unknown) {
      side.structuredCalls.push({ purpose: req.purpose, ...(req.role ? { role: req.role } : {}), system: req.system, user: req.user, meta });
      const v = side.structuredQueue.shift();
      return (v === undefined || v === null ? null : req.schema.parse(v)) as never;
    },
  };
  const commitments = { added: [] as unknown[], add(c: unknown) {
    commitments.added.push(c);
    return 'cm1';
  }, deleteBySourceMessages: () => 0 };
  const conversations = {
    resolved: [] as unknown[],
    resolve(key: { kind: string; tgUserId?: number; chatId?: number; threadId?: number }, owner: { userId: string | null; tgChatId: number | null; threadId?: number }) {
      conversations.resolved.push(key);
      const scopeKey = key.kind === 'dm' ? `dm:${key.tgUserId}${key.threadId ? `:${key.threadId}` : ''}` : `grp:${key.chatId}${key.threadId ? `:${key.threadId}` : ''}`;
      return repos.conversations.byScopeKey(scopeKey) ?? repos.conversations.create({
        scopeKey, kind: key.kind === 'dm' ? (key.threadId ? 'topic' : 'dm') : 'group', userId: owner.userId, tgChatId: owner.tgChatId, threadId: owner.threadId ?? null,
        businessConnectionId: null, route: key.kind === 'dm' ? 'chat' : 'group', model: 'm', effort: 'medium', toolset: key.kind === 'dm' ? 'FULL' : 'GROUP', toolsHash: 'h',
        systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
      });
    },
    scopeKeyOf: () => '',
  };
  const s = {
    config, clock, log, db: tmp.db, crypto, repos, ledger, llmBudget, keyStore,
    privacyHooks: [], contextProviders: [], runHooks: [], strings: createFakeStrings(), profile: config.profile,
    runner, groups, quotas: createFakeQuotas(clock), telegram, side, commitments, conversations, toolkits: createMemoryToolkitState(),
  } as unknown as Services;

  let tg = 2000;
  const user = (p: { tz?: string; consent?: boolean | null; lang?: string; tzSource?: 'miniapp' | 'default'; tgUserId?: number } = {}) => {
    const tgUserId = p.tgUserId ?? ++tg;
    const u = repos.users.upsertFromTelegram({ id: tgUserId, first_name: 'T', language_code: p.lang ?? 'en' }, { dmChatId: tgUserId });
    repos.users.update(u.id, { tz: p.tz ?? 'Asia/Almaty', tzSource: p.tzSource ?? 'miniapp', memoryConsent: p.consent === undefined ? true : p.consent });
    // FK target for memory_facts / reminders (WP1's users table; the in-memory repos do not write it).
    tmp.db.prepare(`INSERT OR IGNORE INTO users (id, tg_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(u.id, tgUserId, clock.now(), clock.now());
    return repos.users.getById(u.id)!;
  };

  const dmConv = (u: { id: string; tgUserId: number }, threadId?: number) =>
    conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId, ...(threadId ? { threadId } : {}) }, { userId: u.id, tgChatId: u.tgUserId, ...(threadId ? { threadId } : {}) });

  const tap = async (kind: CallbackKind, parts: string[], fromTgId: number, message?: CallbackCtx['message']) =>
    callbacks.dispatch({ kind, parts, fromTgId, user: repos.users.getByTg(fromTgId), callbackQueryId: 'cq1', ...(message ? { message } : {}) });

  return {
    s, clock, db: tmp.db, crypto, keyStore, repos, log, outbox, links, runner, ledger, llmBudget, groups, side, commitments, conversations, reactions,
    chatMembers, user, dmConv, tap, close: () => tmp.cleanup(),
  };
}

/** A ToolCtx for calling a spec's execute/undo directly (the executor is WP4's; unit tests call specs in isolation). */
export function toolCtx(
  env: { s: Services; clock: FakeClock; log: ReturnType<typeof createMemoryLogger> },
  o: {
    userId?: string | null; tgUserId?: number | null; surface?: import('../../../src/contracts/index.ts').Surface; scope?: import('../../../src/contracts/index.ts').Scope | null;
    chatId?: number; threadId?: number; triggerMessageId?: number; toolUseId?: string; taint?: import('../../../src/contracts/index.ts').TaintSource[]; tz?: string; lang?: string;
  } = {},
): import('../../../src/contracts/index.ts').ToolCtx & { pushed: import('../../../src/contracts/index.ts').Effect[] } {
  const pushed: import('../../../src/contracts/index.ts').Effect[] = [];
  const id = o.toolUseId ?? `toolu_${Math.random().toString(36).slice(2, 10)}`;
  return {
    toolUseId: id, runId: 'run_1', conversationId: 'conv_1', epoch: 1, userId: o.userId ?? null, tgUserId: o.tgUserId ?? null,
    surface: o.surface ?? 'dm', scope: o.scope === undefined ? (o.userId ? { kind: 'user', userId: o.userId } : null) : o.scope, tz: o.tz ?? 'Asia/Almaty', lang: o.lang ?? 'en',
    now: env.clock.now(), chat: { chatId: o.chatId ?? 1, ...(o.threadId ? { threadId: o.threadId } : {}), ...(o.triggerMessageId ? { triggerMessageId: o.triggerMessageId } : {}) },
    taint: new Set(o.taint ?? []), signal: new AbortController().signal, effects: { push: (e) => pushed.push(e) }, services: env.s, log: env.log,
    idemKey: id, priority: 'interactive', pushed,
  };
}
