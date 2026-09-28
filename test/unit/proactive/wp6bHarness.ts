// WP6b test harness: a TestApp with the fakes WP6b relies on pinned (04 §4.1 "pin the fakes you rely on").
// - scheduler, quotas, ledger, strings (echo keys), capabilities, governance: harness fakes;
// - agent: a runner that wakes parked runs through the REAL runs repo (WP1) and records wakes/events/stops,
//   a conversation service over the real conversations repo, and a scriptable semanticCheck;
// - Telegram: the fake module with a recording TopicManager (topics on/off).
import type {
  AgentModule, CalendarApi, ConversationKey, ConversationRow, ConversationService, Factories, IntegrationService, MailApi, MailThreadSummary, Ms,
  PermissionLevel, RunRow, Services, TopicManager, UserRow, WakePayload,
} from '../../../src/contracts/index.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import {
  createFakeCapabilities, createFakeGovernance, createFakeIntegrations, createFakeLedger, createFakeQuotas, createFakeScheduler, createFakeStrings,
  createFakeTelegramModule, createMemoryToolkitState, NOOP_FACTORIES, type FakeCapabilities, type FakeQuotas,
} from '../../harness/fakes.ts';

export interface TopicLog { created: Array<{ missionId: string; title: string; threadId: number }>; statuses: Array<{ threadId: number; s: string }>; fixed: Array<{ kind: string; threadId: number }> }
export interface TestRunner {
  wakes: Array<{ token: string; p: WakePayload; woke: number }>;
  events: Array<{ conversationId: string; type: string; body: string; channel: string; priority?: string; untrusted: number; replyRef: unknown }>;
  stops: string[];
}

export interface Wp6bApp extends TestApp {
  topics: TopicLog;
  runner: TestRunner;
  caps: FakeCapabilities;
  quotas: FakeQuotas;
  semantic: { next: { met: boolean; summary: string } | null; calls: number };
  gmail: { connected: boolean; level: PermissionLevel; threads: MailThreadSummary[]; searches: number };
  user(o?: { id?: number; tz?: string; lang?: string }): UserRow;
  /** A run in `conv` parked on `wakeOn` and made the conversation's active run. */
  parkRun(conversationId: string, wakeOn: string[]): RunRow;
}

export async function createWp6bApp(o: { topics?: boolean; now?: Ms } = {}): Promise<Wp6bApp> {
  const topics: TopicLog = { created: [], statuses: [], fixed: [] };
  const runner: TestRunner = { wakes: [], events: [], stops: [] };
  const semantic: Wp6bApp['semantic'] = { next: null, calls: 0 };
  const gmail: Wp6bApp['gmail'] = { connected: false, level: 'none', threads: [], searches: 0 };
  let caps!: FakeCapabilities;
  let quotas!: FakeQuotas;
  let nextThread = 500;
  const topicsOn = o.topics ?? true;

  const recordingTopics: TopicManager = {
    async ensureFixed(_u, _tg, kind) {
      if (!topicsOn) return null;
      const f = topics.fixed.find((x) => x.kind === kind);
      if (f) return f.threadId;
      const threadId = ++nextThread;
      topics.fixed.push({ kind, threadId });
      return threadId;
    },
    async createMission(_u, _tg, missionId, title) {
      if (!topicsOn) return null;
      const threadId = ++nextThread;
      topics.created.push({ missionId, title, threadId });
      return threadId;
    },
    async setStatus(_tg, threadId, st) {
      topics.statuses.push({ threadId, s: st });
    },
    onUserTopicCreated() {},
    kindOf: () => null,
    lookup: () => null,
  };

  function conversations(s: Services): ConversationService {
    const scopeKeyOf = (k: ConversationKey): string => {
      switch (k.kind) {
        case 'mission': return `mission:${k.missionId}`;
        case 'dm': return `dm:${k.tgUserId}:${k.threadId ?? 0}`;
        case 'group': return `grp:${k.chatId}:${k.threadId ?? 0}`;
        case 'guest': return `guest:${k.guestQueryId}`;
        default: return 'biz_draft';
      }
    };
    return {
      scopeKeyOf,
      resolve(key, owner): ConversationRow {
        const sk = scopeKeyOf(key);
        const hit = s.repos.conversations.byScopeKey(sk);
        if (hit) return hit;
        const mission = key.kind === 'mission';
        return s.repos.conversations.create({
          scopeKey: sk, kind: mission ? 'mission' : key.kind === 'dm' && key.threadId ? 'topic' : 'dm', userId: owner.userId, tgChatId: owner.tgChatId,
          threadId: owner.threadId ?? null, businessConnectionId: null, route: mission ? 'mission' : 'chat', model: 'test-model', effort: 'medium',
          toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
        });
      },
    };
  }

  function testRunner(s: Services): AgentModule['runner'] {
    let seq = 0;
    return {
      kick() {},
      startEventRun(conversationId, ev, opt) {
        runner.events.push({ conversationId, type: ev.type, body: ev.body, channel: opt.channel, ...(opt.priority ? { priority: opt.priority } : {}), untrusted: ev.untrusted?.length ?? 0, replyRef: opt.replyRef });
        return `run_evt_${++seq}`;
      },
      async wake(token, p) {
        const runs = s.repos.runs.byWaitToken(token);
        for (const r of runs) {
          s.repos.runs.clearWaits(r.id);
          if (p.reason === 'cancelled') {
            s.repos.runs.update(r.id, { state: 'cancelled' });
            s.repos.conversations.casActiveRun(r.conversationId, r.id, null);
          } else {
            s.repos.runs.update(r.id, { state: 'running' });
          }
        }
        runner.wakes.push({ token, p, woke: runs.length });
        return runs.length;
      },
      async stopByDraft() { return false; },
      async stopRun(runId) {
        runner.stops.push(runId);
        return true;
      },
      async recover() {},
      async idle() {},
      async shutdown() {},
      requestRotation() {},
    };
  }

  function integrations(s: Services): IntegrationService {
    const base = createFakeIntegrations(s.config.publicUrl, null);
    const mail: MailApi = {
      async search() {
        gmail.searches++;
        return gmail.threads;
      },
      readThread: async () => { throw new Error('n/a'); },
      createDraft: async () => { throw new Error('n/a'); },
      getDraft: async () => { throw new Error('n/a'); },
      deleteDraft: async () => {},
      sendDraft: async () => { throw new Error('n/a'); },
      findSent: async () => null,
    };
    return Object.assign(base, {
      status: () => ({ gmail: { connected: gmail.connected, level: gmail.level }, gcal: { connected: false, level: 'none' as PermissionLevel } }),
      mail: () => (gmail.connected ? mail : null),
      calendar: (): CalendarApi | null => null,
    });
  }

  const factories: Partial<Factories> = {
    createStrings: () => createFakeStrings(),
    createLedger: (s) => createFakeLedger(s.clock),
    createQuotaService: (s) => (quotas = createFakeQuotas(s.clock)),
    createPrivacyService: NOOP_FACTORIES.createPrivacyService,
    createLlmGovernance: () => createFakeGovernance(),
    createCapabilities: (_c, _f, s) => (caps = createFakeCapabilities(() => s.clock.now())),
    createIntegrationService: (s) => integrations(s),
    createTrustModule: NOOP_FACTORIES.createTrustModule,
    createMemoryService: NOOP_FACTORIES.createMemoryService,
    createScheduler: (s) => createFakeScheduler(() => s.clock),
    createReminderModule: NOOP_FACTORIES.createReminderModule,
    createAgentModule: (s): AgentModule => ({
      runner: testRunner(s),
      conversations: conversations(s),
      side: {
        triage: async () => null, extract: async () => null, importFacts: async () => [], topicTitle: async () => null,
        semanticCheck: async () => {
          semantic.calls++;
          return semantic.next;
        },
        structured: async () => null,
      },
      toolkits: createMemoryToolkitState(),
    }),
    createTelegramModule: async (s, opt) => {
      const m = await createFakeTelegramModule(s, opt);
      Object.assign(m.gateway, { topics: recordingTopics });
      return m;
    },
    createBusinessModule: NOOP_FACTORIES.createBusinessModule,
    createSurfaces: NOOP_FACTORIES.createSurfaces,
    createHttpApp: NOOP_FACTORIES.createHttpApp,
  };

  const t = await createTestApp({ factories, ...(o.now !== undefined ? { now: o.now } : {}) });
  const app = t as Wp6bApp;
  app.topics = topics;
  app.runner = runner;
  app.caps = caps;
  app.quotas = quotas;
  app.semantic = semantic;
  app.gmail = gmail;
  app.user = (u = {}) => {
    const row = t.s.repos.users.upsertFromTelegram({ id: u.id ?? 1001, first_name: 'Aigerim', language_code: u.lang ?? 'en' }, { dmChatId: u.id ?? 1001 });
    t.s.repos.users.update(row.id, { tz: u.tz ?? 'UTC', status: 'active' });
    return t.s.repos.users.getById(row.id)!;
  };
  app.parkRun = (conversationId, wakeOn) => {
    const conv = t.s.repos.conversations.get(conversationId)!;
    const run = t.s.repos.runs.create({
      conversationId, userId: conv.userId, epoch: conv.epoch, trigger: 'mission_start', triggerRef: null, channel: 'notify',
      replyRef: { chatId: conv.tgChatId ?? 0 }, maxTokens: 1000,
    });
    t.s.repos.runs.update(run.id, { state: 'running' });
    t.s.repos.conversations.casActiveRun(conversationId, conv.activeRunId, run.id);
    t.s.repos.runs.park(run.id, wakeOn, null);
    return t.s.repos.runs.get(run.id)!;
  };
  return app;
}

/** Decodes a callback button and dispatches it through the real registry (the fake module has no callback_query handler). */
export async function tapButton(t: Wp6bApp, data: string, fromTgId = 1001): Promise<unknown> {
  const d = t.s.telegram.codec.decode(data, fromTgId);
  if ('error' in d) throw new Error(`bad callback: ${d.error}`);
  const r = await t.s.telegram.callbacks.dispatch({ kind: d.kind, parts: d.parts, fromTgId, user: t.s.repos.users.getByTg(fromTgId), callbackQueryId: 'q1' });
  await t.settle();
  return r;
}
