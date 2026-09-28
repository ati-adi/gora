// WP7a test environment: a real App (createTestApp) with the WP7a surfaces, the real strings and the real WP1
// storage (the WP7 tables have foreign keys to users), and every other module pinned to deterministic fakes, so the
// surfaces flows are tested on their own. Full-stack variants (real WP2/WP3/WP4/WP6 …) are gated per test.
import type {
  AgentModule, ConversationKey, ConversationRow, ConversationService, Factories, MemoryFactView, MemoryHit, MemoryService, NudgeService, ProactiveModule, Scope, Services,
} from '../../../src/contracts/index.ts';
import { scopeKey } from '../../../src/contracts/index.ts';
import { ROUTES } from '../../../src/config.ts';
import { NOOP_FACTORIES, createFakeRunner, createMemoryToolkitState, notImplemented, type FakeRunner } from '../../harness/fakes.ts';
import { createTestApp, type CreateTestAppOptions, type TestApp } from '../../harness/testApp.ts';

export function conversationScopeKey(key: ConversationKey): string {
  switch (key.kind) {
    case 'dm':
      return key.threadId ? `dm:${key.tgUserId}:t${key.threadId}` : `dm:${key.tgUserId}`;
    case 'mission':
      return `mission:${key.missionId}`;
    case 'group':
      return key.threadId ? `grp:${key.chatId}:t${key.threadId}` : `grp:${key.chatId}`;
    case 'guest':
      return `guest:${key.guestQueryId}`;
    default:
      return `bizdraft:${Math.random().toString(36).slice(2)}`;
  }
}

/** ConversationService over the real WP1 ConversationsRepo (01 §5.1 scope keys and routes). */
export function repoConversations(s: Services): ConversationService {
  return {
    scopeKeyOf: conversationScopeKey,
    resolve(key, owner) {
      const sk = conversationScopeKey(key);
      const found = s.repos.conversations.byScopeKey(sk);
      if (found && found.status === 'active') return found;
      const kind: ConversationRow['kind'] = key.kind === 'dm' ? (key.threadId ? 'topic' : 'dm') : key.kind;
      const route = key.kind === 'group' ? 'group' : key.kind === 'guest' ? 'guest' : key.kind === 'biz_draft' ? 'biz' : key.kind === 'mission' ? 'mission' : 'chat';
      const r = ROUTES[route];
      return s.repos.conversations.create({
        scopeKey: sk, kind, userId: owner.userId, tgChatId: owner.tgChatId, threadId: owner.threadId ?? null, businessConnectionId: owner.businessConnectionId ?? null,
        route, model: 'test-model', effort: r.effort, toolset: r.toolset, toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: key.kind === 'guest' || key.kind === 'biz_draft',
      });
    },
  };
}

export interface FakeMemory extends MemoryService {
  facts: Map<string, Array<MemoryFactView & { scope: string }>>;
  imports: string[];
}
export function fakeMemory(): FakeMemory {
  const facts = new Map<string, Array<MemoryFactView & { scope: string }>>();
  const imports: string[] = [];
  let n = 0;
  const of = (sc: Scope) => {
    const k = scopeKey(sc);
    if (!facts.has(k)) facts.set(k, []);
    return facts.get(k)!;
  };
  const hit = (f: MemoryFactView): MemoryHit => ({ id: f.id, text: f.text, kind: f.kind, sourceLabel: f.sourceLabel, createdAt: f.createdAt, pinned: f.pinned });
  const add = (sc: Scope, text: string, status: 'active' | 'pending_confirm' = 'active') => {
    const f = { id: `m${++n}`, text, kind: 'fact' as const, sourceLabel: 'test', createdAt: 0, pinned: false, status, sensitivity: 'normal' as const, quote: null, useCount: 0, scope: scopeKey(sc) };
    of(sc).push(f);
    return f;
  };
  return notImplemented<FakeMemory>('memory', {
    facts,
    imports,
    async save(sc, f) {
      return { id: add(sc, f.text).id, status: 'active' };
    },
    async list(sc) {
      return { items: [...of(sc)] };
    },
    async search(sc, q) {
      return of(sc).filter((f) => f.text.includes(q)).map(hit);
    },
    async retrieve(sc) {
      return of(sc).map(hit);
    },
    async forget(sc, sel) {
      const arr = of(sc);
      const gone = arr.filter((f) => (sel.ids ? sel.ids.includes(f.id) : sel.query ? f.text.includes(sel.query) : false));
      facts.set(scopeKey(sc), arr.filter((f) => !gone.includes(f)));
      return { forgotten: gone.map((f) => ({ id: f.id, preview: f.text.slice(0, 40) })) };
    },
    async importText(userId, text) {
      imports.push(text);
      return text
        .split('\n')
        .map((l) => l.replace(/^[-•*]\s*/, '').trim())
        .filter((l) => l.length > 3)
        .slice(0, 12)
        .map((l) => {
          const f = add({ kind: 'user', userId }, l, 'pending_confirm');
          return { id: f.id, text: f.text };
        });
    },
    getMany(sc, ids) {
      return of(sc).filter((f) => ids.includes(f.id)).map(hit);
    },
    filterFingerprinted: (_sc, s) => s,
  });
}

export interface FakeBrief {
  runs: Array<{ userId: string; preview: boolean }>;
  daily: Map<string, string | null>;
}

export interface SurfacesTestApp extends TestApp {
  runner: FakeRunner;
  memory: FakeMemory;
  brief: FakeBrief;
}

export async function createSurfacesApp(o: CreateTestAppOptions & { extraFactories?: Partial<Factories> } = {}): Promise<SurfacesTestApp> {
  const runner = createFakeRunner();
  const memory = fakeMemory();
  const brief: FakeBrief = { runs: [], daily: new Map() };
  const N = NOOP_FACTORIES;
  const factories: Partial<Factories> = {
    createQuotaService: N.createQuotaService,
    createLedger: N.createLedger,
    createPrivacyService: N.createPrivacyService,
    createScheduler: N.createScheduler,
    createLlmGovernance: N.createLlmGovernance,
    createTransport: N.createTransport,
    createCapabilities: N.createCapabilities,
    createIntegrationService: N.createIntegrationService,
    createToolRegistry: N.createToolRegistry,
    createTrustModule: N.createTrustModule,
    createMemoryService: () => memory,
    createReminderModule: N.createReminderModule,
    createProactiveModule: (): ProactiveModule => ({
      nudges: notImplemented<NudgeService>('nudges', { prefs: () => [], get: () => undefined, outcome: async () => {} }),
      brief: {
        async run(userId, p) {
          brief.runs.push({ userId, preview: p.preview });
        },
        setDaily(userId, hhmm) {
          brief.daily.set(userId, hhmm);
        },
      },
      commitments: notImplemented('commitments'),
    }),
    createMissionModule: N.createMissionModule,
    createAgentModule: (s): AgentModule => ({
      runner,
      conversations: repoConversations(s),
      side: { triage: async () => null, extract: async () => null, importFacts: async () => [], topicTitle: async () => null, semanticCheck: async () => null, structured: async () => null },
      toolkits: createMemoryToolkitState(),
    }),
    createTelegramModule: N.createTelegramModule,
    createBusinessModule: N.createBusinessModule,
    createHttpApp: N.createHttpApp,
    ...(o.extraFactories ?? {}),
  };
  const t = await createTestApp({ ...o, factories: { ...factories, ...(o.factories ?? {}) } });
  return Object.assign(t, { runner, memory, brief });
}

/** Texts (markdown or plain) of every message the bot sent/edited, in order. */
export function sentTexts(t: TestApp): string[] {
  return t.tg.calls
    .filter((c) => ['sendRichMessage', 'sendMessage', 'editMessageText'].includes(c.method))
    .map((c) => String((c.payload?.rich_message as { markdown?: string } | undefined)?.markdown ?? c.payload?.text ?? ''));
}
/** Callback data of every button on the last message that had an inline keyboard. */
export function lastButtons(t: TestApp): Array<{ text: string; data?: string; url?: string; webApp?: string }> {
  return t.lastCard().buttons.map((b) => {
    const x = b as { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
    return { text: x.text, ...(x.callback_data ? { data: x.callback_data } : {}), ...(x.url ? { url: x.url } : {}), ...(x.web_app ? { webApp: x.web_app.url } : {}) };
  });
}
