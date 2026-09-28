// Shared WP4 e2e world (used by test/e2e/approvals.e2e.test.ts and injection.e2e.test.ts): the app with other WPs
// pinned to their fakes, shared repos/keystore across restart, the real WP2 HMAC callback codec, and fake Gmail-like tools.
import { z } from 'zod';
import type {
  ApprovalDiff, BetaToolUseBlock, CoreRepos, Factories, KeyStore, RunRow, ConversationRow, Services, Target, ToolCtx, ToolSpec, UserRow,
} from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createCallbackCodec } from '../../../src/telegram/callbackCodec.ts';
import { createTrustModule } from '../../../src/trust/index.ts';
import { TOOLS as TRUST_TOOLS } from '../../../src/trust/tools.ts';
import {
  NOOP_FACTORIES, createFakeKeyStore, createFakeRunner, createFakeTelegramModule, createMemoryCoreRepos, createStaticRegistry,
} from '../../harness/fakes.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

export interface World {
  calls: Array<{ to: string; idemKey: string }>;
  subject: { override: string | null };
  clockRef: { c: FakeClock | null };
  repos: CoreRepos;
  ks: KeyStore;
  runner: ReturnType<typeof createFakeRunner>;
}

export function gmailLikeTool(w: World): ToolSpec {
  const input = z.object({ to: z.string().email(), subject: z.string(), body: z.string() });
  return {
    name: 'gmail_send_draft',
    description: 'test send',
    input,
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: false,
    classify: () => ({ actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act' }),
    targets: async (i: z.infer<typeof input>): Promise<Target[]> => [{ kind: 'email', value: i.to, hmac: '', provenance: 'user' }],
    renderDiff: async (i: z.infer<typeof input>): Promise<ApprovalDiff> => ({
      title: 'Send email', summary: `Send email to ${i.to}`, rows: [['To', i.to], ['Subject', w.subject.override ?? i.subject]], body: { label: 'Body', text: i.body }, warnings: [], targets: [],
    }),
    statusLabel: () => 'Sending',
    async execute(i: z.infer<typeof input>, ctx: ToolCtx) {
      w.calls.push({ to: i.to, idemKey: ctx.idemKey });
      return { content: JSON.stringify({ sent: true }), ledger: [{ kind: 'email_sent', summary: 'Email sent' }] };
    },
  };
}

export function mailReadTool(text: string): ToolSpec {
  return {
    name: 'gmail_read_thread',
    description: 'test read',
    input: z.object({ id: z.string() }),
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: true,
    outputTaint: 'email',
    classify: () => ({ actionClass: 'read_private', risk: 0, integration: 'gmail', requiredLevel: 'read' }),
    statusLabel: () => 'Reading',
    async execute() {
      return { content: text, untrusted: { source: 'email', label: 'Invoice' } };
    },
  };
}

export function newWorld(): World {
  const clockRef: { c: FakeClock | null } = { c: null };
  const clock = { now: () => clockRef.c!.now(), setTimeout: (f: () => void, ms: number) => clockRef.c!.setTimeout(f, ms), clearTimeout: (h: unknown) => clockRef.c!.clearTimeout(h), sleep: (ms: number, sg?: AbortSignal) => clockRef.c!.sleep(ms, sg) };
  return { calls: [], subject: { override: null }, clockRef, repos: createMemoryCoreRepos(clock), ks: createFakeKeyStore(), runner: createFakeRunner() };
}

export async function boot(w: World, specs: ToolSpec[], prev?: TestApp): Promise<TestApp> {
  const factories: Partial<Factories> = {
    ...NOOP_FACTORIES,
    openKeyStore: () => w.ks,
    createCoreRepos: () => w.repos,
    createToolRegistry: () => createStaticRegistry([...specs, ...TRUST_TOOLS]),
    createTrustModule,
    createAgentModule: (s: Services) => ({ ...NOOP_FACTORIES.createAgentModule(s), runner: w.runner }),
    createIntegrationService: (s: Services) => {
      const base = NOOP_FACTORIES.createIntegrationService(s);
      return { ...base, status: () => ({ gmail: { connected: true, level: 'act' as const }, gcal: { connected: true, level: 'act' as const } }) };
    },
    createTelegramModule: async (s, o) => {
      const m = await createFakeTelegramModule(s, o);
      return { ...m, gateway: { ...m.gateway, codec: createCallbackCodec(s.config.secrets.callbackKey) } };
    },
  };
  const t = prev ? await prev.restart() : await createTestApp({ factories, noopFallback: true, config: { publicUrl: 'https://gora.test' } as never });
  w.clockRef.c = t.clock;
  return t;
}

export function owner(t: TestApp, w: World, tgId = 1001): UserRow {
  const u = w.repos.users.upsertFromTelegram({ id: tgId, first_name: 'Ann', language_code: 'en' }, { dmChatId: tgId });
  w.repos.users.update(u.id, { tzSource: 'manual', tz: 'Asia/Almaty' });
  for (const k of ['gmail', 'gcal'] as const) w.repos.users.setPermission(u.id, k, 'act', 'system');
  // pending_actions / grants reference users(id) in SQL (the in-memory repos keep users elsewhere)
  t.s.db.prepare('INSERT OR IGNORE INTO users (id, tg_user_id, dm_chat_id, created_at, updated_at) VALUES (?,?,?,?,?)').run(u.id, tgId, tgId, t.clock.now(), t.clock.now());
  return w.repos.users.getById(u.id)!;
}

export function dm(w: World, u: UserRow, kind: ConversationRow['kind'] = 'dm'): { conv: ConversationRow; run: RunRow } {
  const conv = w.repos.conversations.create({
    scopeKey: kind === 'dm' ? `user:${u.id}` : `mission:${u.id}:${Math.random()}`, kind, userId: u.id, tgChatId: u.tgUserId, threadId: null, businessConnectionId: null,
    route: 'dm' as never, model: 'claude-opus-5', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
  });
  const run = w.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm' as never, replyRef: { chatId: u.tgUserId }, maxTokens: 1000 });
  return { conv, run };
}

/** What WP2's callback_query handler does: decode (MAC + owner), then dispatch; the answer text is returned. */
export async function tapAs(t: TestApp, data: string, fromTgId: number, messageId = 1): Promise<string> {
  const d = t.s.telegram.codec.decode(data, fromTgId);
  if ('error' in d) return `rejected:${d.error}`;
  const ans = await t.s.telegram.callbacks.dispatch({ kind: d.kind, parts: d.parts, fromTgId, user: t.s.repos.users.getByTg(fromTgId), callbackQueryId: 'cq', message: { chatId: fromTgId, messageId } });
  return (ans && ans.text) || '';
}

export const sig = () => new AbortController().signal;
export const tu = (id: string, name: string, input: unknown) => [{ type: 'tool_use', id, name, input }] as BetaToolUseBlock[];

