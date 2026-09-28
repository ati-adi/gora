// WP6a e2e harness: createTestApp with the REAL scheduler, memory and reminders factories, and pinned fakes for every
// other work package (so the tests do not depend on their progress). State that must survive t.restart() — the in-memory
// core repos, the key store, the ledger, the runner and the recording side calls — is shared through `WpShared`.
import type { AgentModule, CoreRepos, ConversationRow, Factories, KeyStore, ProactiveModule, Services, SideCalls, UserRow } from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import {
  NOOP_FACTORIES, createFakeCrypto, createFakeKeyStore, createFakeLedger, createFakeRunner, createFakeStrings, createFakeTelegramModule,
  createMemoryCoreRepos, createMemoryToolkitState, createStaticRegistry, notImplemented, type FakeRunner,
} from '../../harness/fakes.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

export interface RecordingSide extends SideCalls {
  extractCalls: Array<{ inputs: Array<{ id: string; text: string }>; existing: Array<{ id: string; text: string }>; priority?: string }>;
  extractQueue: unknown[];
  importResult: Array<{ text: string; kind: string; sensitivity: 'normal' | 'sensitive' }>;
}

export function recordingSide(): RecordingSide {
  const side: RecordingSide = {
    extractCalls: [],
    extractQueue: [],
    importResult: [],
    triage: async () => null,
    async extract(i, meta) {
      side.extractCalls.push({ inputs: i.inputs, existing: i.existing, ...(meta?.priority ? { priority: meta.priority } : {}) });
      return (side.extractQueue.shift() ?? { facts: [], commitments: [] }) as never;
    },
    importFacts: async () => side.importResult as never,
    topicTitle: async () => null,
    semanticCheck: async () => null,
    structured: async () => null,
  };
  return side;
}

export interface WpShared {
  clock: FakeClock; ks: KeyStore & { deks: Map<string, { key: Uint8Array | null; owner: string }> }; repos: CoreRepos | null; runner: FakeRunner; side: RecordingSide;
  ledger: ReturnType<typeof createFakeLedger> | null; commitments: unknown[];
}
export function newShared(): WpShared {
  return { clock: new FakeClock(), ks: createFakeKeyStore(), repos: null, runner: createFakeRunner(), side: recordingSide(), ledger: null, commitments: [] };
}

function conversationsOf(s: Services): AgentModule['conversations'] {
  return {
    resolve(key, owner) {
      const scopeKey =
        key.kind === 'dm' ? `dm:${key.tgUserId}${key.threadId ? `:${key.threadId}` : ''}` : key.kind === 'group' ? `grp:${key.chatId}${key.threadId ? `:${key.threadId}` : ''}` : `x:${JSON.stringify(key)}`;
      return (
        s.repos.conversations.byScopeKey(scopeKey) ??
        s.repos.conversations.create({
          scopeKey, kind: key.kind === 'dm' ? (key.threadId ? 'topic' : 'dm') : 'group', userId: owner.userId, tgChatId: owner.tgChatId, threadId: owner.threadId ?? null,
          businessConnectionId: null, route: key.kind === 'dm' ? 'chat' : 'group', model: 'm', effort: 'medium', toolset: key.kind === 'dm' ? 'FULL' : 'GROUP', toolsHash: 'h',
          systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
        })
      );
    },
    scopeKeyOf: () => '',
  };
}

export function wp6Factories(sh: WpShared): Partial<Factories> {
  const { createMemoryService: _m, createScheduler: _s, createReminderModule: _r, ...rest } = NOOP_FACTORIES;
  return {
    ...rest,
    createStrings: () => createFakeStrings(),
    openKeyStore: () => sh.ks,
    createCrypto: (ks, hk) => createFakeCrypto(ks, hk),
    createCoreRepos: (_db, _c, clock) => (sh.repos ??= createMemoryCoreRepos(clock)),
    createLedger: (s) => (sh.ledger ??= createFakeLedger(s.clock)),
    createToolRegistry: (_p, external) => createStaticRegistry(external),
    createTelegramModule: (s, o) => createFakeTelegramModule(s, o),
    createProactiveModule: (): ProactiveModule => ({
      nudges: notImplemented('nudges'), brief: notImplemented('brief'),
      commitments: { add: (c) => (sh.commitments.push(c), `cm${sh.commitments.length}`), deleteBySourceMessages: () => 0 },
    }),
    createAgentModule: (s): AgentModule => ({ runner: sh.runner, conversations: conversationsOf(s), side: sh.side, toolkits: createMemoryToolkitState() }),
  };
}

export async function wp6App(sh: WpShared, env: Record<string, string> = {}): Promise<TestApp> {
  return createTestApp({ clock: sh.clock, factories: wp6Factories(sh), noopFallback: false, env });
}

/** A DM user with memory consent and a confirmed tz; also the SQL users row the WP6 tables reference. */
export function addUser(t: TestApp, o: { tgUserId: number; tz?: string; lang?: string; consent?: boolean }): UserRow {
  const s = t.s;
  const u = s.repos.users.upsertFromTelegram({ id: o.tgUserId, first_name: 'U', language_code: o.lang ?? 'en' }, { dmChatId: o.tgUserId });
  s.repos.users.update(u.id, { tz: o.tz ?? 'Asia/Almaty', tzSource: 'miniapp', memoryConsent: o.consent ?? true });
  s.db.prepare(`INSERT OR IGNORE INTO users (id, tg_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(u.id, o.tgUserId, t.clock.now(), t.clock.now());
  return s.repos.users.getById(u.id)!;
}

export function dm(t: TestApp, u: UserRow, threadId?: number): ConversationRow {
  return t.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId, ...(threadId ? { threadId } : {}) }, { userId: u.id, tgChatId: u.tgUserId, ...(threadId ? { threadId } : {}) });
}
