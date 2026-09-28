// Shared unit-test environment for WP4: a real migrated SQLite DB (WP4 tables), fake crypto/repos/ledger/quotas and
// a recording outbox. Users live in the in-memory repos AND as SQL rows (pending_actions/grants FK → users).
import type { Bot } from 'grammy';
import { z } from 'zod';
import type {
  ApprovalDiff, Classification, ConversationRow, OutboxRequest, RunRow, SentRef, Services, Target, ToolCtx, ToolOutput, ToolSpec, UserRow,
} from '../../../src/contracts/index.ts';
import { testConfig } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { createCallbackRegistry } from '../../../src/kernel/registries.ts';
import { createTrustModule } from '../../../src/trust/index.ts';
import {
  createFakeCapabilities, createFakeCodec, createFakeCrypto, createFakeIntegrations, createFakeKeyStore, createFakeLedger, createFakeQuotas,
  createFakeRenderer, createFakeRunner, createFakeScheduler, createFakeStrings, createMemoryCoreRepos, createMemoryLinks, createStaticRegistry,
  notImplemented,
} from '../../harness/fakes.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';

export interface RecordingOutbox { sent: OutboxRequest[]; queued: OutboxRequest[] }

export function makeEnv(specs: ToolSpec[], o: { groqKey?: boolean; publicUrl?: string } = {}) {
  const clock = new FakeClock();
  const tmp = openTmpDb({ now: clock.now() });
  const ks = createFakeKeyStore();
  const crypto = createFakeCrypto(ks, new Uint8Array(32).fill(7));
  const repos = createMemoryCoreRepos(clock);
  const caps = createFakeCapabilities(() => clock.now());
  const runner = createFakeRunner();
  const ledger = createFakeLedger(clock);
  const quotas = createFakeQuotas(clock);
  const scheduler = createFakeScheduler(() => clock);
  let msgId = 100;
  const out: RecordingOutbox = { sent: [], queued: [] };
  const outbox = {
    enqueue(r: OutboxRequest) {
      out.queued.push(r);
      return r.idempotencyKey;
    },
    async sendNow(r: OutboxRequest): Promise<SentRef[]> {
      out.sent.push(r);
      return [{ chatId: r.chatId, messageId: ++msgId, kind: 'rich' }];
    },
    onSent() {},
    start() {},
    async stop() {},
    async flush() {
      return 0;
    },
  };
  const links = createMemoryLinks();
  const callbacks = createCallbackRegistry();
  const notices = { quota: [] as string[], tz: [] as string[] };
  const config = testConfig({}, { publicUrl: o.publicUrl ?? 'https://gora.test', ...(o.groqKey ? { groq: { apiKey: 'gsk_test' } } : {}) } as never);
  const integrations = createFakeIntegrations(config.publicUrl);
  const connected = { gmail: true, gcal: true };
  const s = {
    config, clock, log: nullLogger, db: tmp.db, crypto, repos, ledger, quotas, privacyHooks: [], contextProviders: [], runHooks: [],
    caps, capabilities: caps, runner, scheduler, strings: createFakeStrings(),
    registry: createStaticRegistry(specs),
    telegram: { codec: createFakeCodec(), render: createFakeRenderer(() => ({}) as Bot['api']), outbox, links, callbacks },
    integrations: {
      ...integrations,
      status: () => ({ gmail: { connected: connected.gmail, level: 'act' as const }, gcal: { connected: connected.gcal, level: 'act' as const } }),
    },
    notices: notImplemented('notices', {
      quotaExceeded: async (_u: string, k: string) => void notices.quota.push(k),
      askTimezone: async (u: string) => void notices.tz.push(u),
    }),
    business: notImplemented('business', {}),
  } as unknown as Services;
  const trust = createTrustModule(s);
  Object.assign(s, trust);

  const addUser = (tgId = 1001, patch: Partial<UserRow> = {}): UserRow => {
    const u = repos.users.upsertFromTelegram({ id: tgId, first_name: 'Ann', language_code: 'en' }, { dmChatId: tgId });
    repos.users.update(u.id, { tzSource: 'manual', tz: 'Asia/Almaty', ...patch });
    for (const k of ['gmail', 'gcal'] as const) repos.users.setPermission(u.id, k, 'act', 'system');
    tmp.db.prepare('INSERT OR IGNORE INTO users (id, tg_user_id, dm_chat_id, created_at, updated_at) VALUES (?,?,?,?,?)').run(u.id, tgId, tgId, clock.now(), clock.now());
    return repos.users.getById(u.id)!;
  };

  const addConv = (user: UserRow, taint: string[] = []): { conv: ConversationRow; run: RunRow } => {
    const conv = repos.conversations.create({
      scopeKey: `user:${user.id}`, kind: 'dm', userId: user.id, tgChatId: user.tgUserId, threadId: null, businessConnectionId: null, route: 'dm' as never,
      model: 'claude-opus-5', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
    });
    const run = repos.runs.create({ conversationId: conv.id, userId: user.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm' as never, replyRef: { chatId: user.tgUserId }, maxTokens: 1000, taint: taint as never });
    return { conv, run };
  };

  return { s, clock, tmp, repos, caps, runner, ledger, quotas, scheduler, out, links, callbacks, notices, connected, addUser, addConv, close: () => tmp.cleanup() };
}
export type Env = ReturnType<typeof makeEnv>;

// ── fake tools

export interface FakeEmailTool extends ToolSpec {
  sent: Array<{ input: unknown; idemKey: string }>;
  subjectOverride: { value: string | null };
}

/** A send_external email tool (like gmail_send_draft), idempotent per idemKey. */
export function fakeEmailTool(): FakeEmailTool {
  const sent: Array<{ input: unknown; idemKey: string }> = [];
  const seen = new Set<string>();
  const subjectOverride = { value: null as string | null };
  const input = z.object({ to: z.string().email(), subject: z.string(), body: z.string() });
  const spec: FakeEmailTool = {
    name: 'send_email',
    description: 'test',
    input,
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: false,
    sent,
    subjectOverride,
    classify: (): Classification => ({ actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act' }),
    targets: async (i: z.infer<typeof input>): Promise<Target[]> => [{ kind: 'email', value: i.to, hmac: 'tool-supplied', provenance: 'user' }],
    renderDiff: async (i: z.infer<typeof input>): Promise<ApprovalDiff> => ({
      title: 'Send email',
      summary: `Send email to ${i.to}`,
      rows: [['To', i.to], ['Subject', subjectOverride.value ?? i.subject]],
      body: { label: 'Body', text: i.body },
      warnings: [],
      targets: [],
    }),
    statusLabel: () => 'Sending',
    async execute(i: unknown, ctx: ToolCtx): Promise<ToolOutput> {
      if (!seen.has(ctx.idemKey)) {
        seen.add(ctx.idemKey);
        sent.push({ input: i, idemKey: ctx.idemKey });
      }
      return { content: JSON.stringify({ sent: true }), ledger: [{ kind: 'email_sent', summary: 'Email sent' }] };
    },
  };
  return spec;
}

export function fakeReadTool(name: string, o: { taint?: 'email' | 'web'; delayMs?: number; clockRef?: { v: FakeClock | null }; log?: string[] } = {}): ToolSpec {
  return {
    name,
    description: 'test',
    input: z.object({ q: z.string() }),
    surfaces: ['dm', 'topic', 'mission', 'group'],
    parallelSafe: true,
    ...(o.taint ? { outputTaint: o.taint } : {}),
    classify: () => ({ actionClass: 'read_private', risk: 0 }),
    statusLabel: () => 'Reading',
    async execute(i: { q: string }) {
      o.log?.push(`start:${name}`);
      await Promise.resolve();
      o.log?.push(`end:${name}`);
      return { content: `result of ${name} for ${i.q}` };
    },
  };
}

export function fakeNoteTool(): ToolSpec & { undone: unknown[] } {
  const undone: unknown[] = [];
  return {
    name: 'note_save',
    description: 'test',
    input: z.object({ text: z.string() }),
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: false,
    undone,
    classify: () => ({ actionClass: 'write_self', risk: 1 }),
    statusLabel: () => 'Saving',
    async execute(i: { text: string }) {
      return { content: 'saved', undo: { payload: { id: 'n1', text: i.text }, line: 'Saved a note' } };
    },
    async undo(payload: unknown) {
      undone.push(payload);
    },
  };
}

export const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use' as const, id, name, input });
export const signal = () => new AbortController().signal;
