// Review helper (area "agent"): the e2e agentApp harness (real engine + fakes around it), reused by the proofs.
import type { ConversationRow, Factories, MemoryService, ToolSpec, UserRow } from '../../../src/contracts/index.ts';
import { createAgentModule } from '../../../src/agent/index.ts';
import type { EngineRunner } from '../../../src/agent/engine.ts';
import {
  NOOP_FACTORIES, createFakeCapabilities, createFakeGovernance, createFakeIntegrations, createFakeLedger, createFakeQuotas, createFakeScheduler, createFakeStrings,
  createFakeTelegramModule, createRecordingChannelFactory, createStaticRegistry, notImplemented,
} from '../../harness/fakes.ts';
import { createTestApp } from '../../harness/testApp.ts';
import type { TestApp } from '../../harness/testApp.ts';

export async function agentApp(o: { env?: Record<string, string>; specs?: ToolSpec[]; factories?: Partial<Factories> } = {}): Promise<{ t: TestApp; runner: EngineRunner; user: UserRow; conv: ConversationRow; channels: ReturnType<typeof createRecordingChannelFactory> }> {
  const channels = createRecordingChannelFactory();
  const factories: Partial<Factories> = {
    createStrings: () => createFakeStrings(),
    createLedger: (s) => createFakeLedger(s.clock),
    createQuotaService: (s) => createFakeQuotas(s.clock),
    createLlmGovernance: () => createFakeGovernance(),
    createCapabilities: (_c, _f, s) => createFakeCapabilities(() => s.clock.now()),
    createIntegrationService: (s, p) => createFakeIntegrations(s.config.publicUrl, p ?? null),
    createToolRegistry: () => createStaticRegistry(o.specs ?? []),
    createTrustModule: NOOP_FACTORIES.createTrustModule,
    createMemoryService: () => notImplemented<MemoryService>('memory', { filterFingerprinted: (_s, xs) => xs }),
    createScheduler: (s) => createFakeScheduler(() => s.clock),
    createReminderModule: NOOP_FACTORIES.createReminderModule,
    createProactiveModule: NOOP_FACTORIES.createProactiveModule,
    createMissionModule: NOOP_FACTORIES.createMissionModule,
    createTelegramModule: (s, x) => createFakeTelegramModule(s, x),
    createBusinessModule: NOOP_FACTORIES.createBusinessModule,
    createSurfaces: NOOP_FACTORIES.createSurfaces,
    createHttpApp: NOOP_FACTORIES.createHttpApp,
    createAgentModule: (s) => createAgentModule(s, { channels }),
    ...(o.factories ?? {}),
  };
  const t = await createTestApp({ factories, ...(o.env ? { env: o.env } : {}) });
  const user = t.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  const conv = t.s.conversations.resolve({ kind: 'dm', tgUserId: 1001 }, { userId: user.id, tgChatId: 1001 });
  return { t, runner: t.s.runner as EngineRunner, user, conv, channels };
}

let seq = 0;
export function addInput(t: TestApp, conv: ConversationRow, text: string, o: { untrusted?: boolean } = {}): void {
  seq += 1;
  t.s.repos.inputs.add({
    conversationId: conv.id, kind: o.untrusted ? 'forward' : 'text', author: 'owner', untrusted: !!o.untrusted, content: [{ type: 'text', text }],
    tgUpdateId: 190_000 + seq, tgChatId: 1001, tgMessageId: 5_000 + seq, fromTgUserId: 1001, replyToCardId: null,
  });
}
export async function userSays(t: TestApp, conv: ConversationRow, text: string, o: { untrusted?: boolean } = {}): Promise<void> {
  addInput(t, conv, text, o);
  t.s.runner.kick(conv.id);
  await t.settle();
}
export const cur = (t: TestApp, conv: ConversationRow) => t.s.repos.conversations.get(conv.id)!;
export const rowsOf = (t: TestApp, conv: ConversationRow, epoch?: number) => t.s.repos.messages.load(conv.id, epoch ?? cur(t, conv).epoch);
