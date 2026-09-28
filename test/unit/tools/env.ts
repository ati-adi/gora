// Shared unit-test environment for WP5 tools: fake repos/ledger/capabilities, the FakeIntegrationProvider behind a thin
// IntegrationService stand-in, a recording outbox, and a ToolCtx builder.
import type { Effect, IntegrationService, OutboxRequest, Services, ToolCtx, ToolSpec } from '../../../src/contracts/index.ts';
import { testConfig } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { FakeIntegrationProvider } from '../../../src/integrations/fake.ts';
import { clearEventMemo } from '../../../src/tools/impl/calMemo.ts';
import {
  createFakeCapabilities, createFakeCodec, createFakeCrypto, createFakeKeyStore, createFakeLedger, createFakeQuotas, createFakeStrings, createMemoryChoices, createMemoryCoreRepos,
  createMemoryToolkitState, notImplemented,
} from '../../harness/fakes.ts';

export function createToolEnv(o: { tz?: string; connected?: { gmail?: boolean; gcal?: boolean } } = {}) {
  clearEventMemo();
  const clock = new FakeClock();
  const repos = createMemoryCoreRepos(clock);
  const user = repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  repos.users.update(user.id, { tz: o.tz ?? 'Asia/Almaty', tzSource: 'manual' });
  const provider = new FakeIntegrationProvider({ now: () => clock.now() });
  const connected = { gmail: o.connected?.gmail ?? true, gcal: o.connected?.gcal ?? true };
  const connectCards: Array<{ kind: string; reason?: string }> = [];
  const integrations: IntegrationService = {
    provider,
    status: () => ({ gmail: { connected: connected.gmail, level: connected.gmail ? 'act' : 'none' }, gcal: { connected: connected.gcal, level: connected.gcal ? 'act' : 'none' } }),
    startConnect: async () => ({ url: 'https://gora.test/dev/fake-connect?state=x' }),
    oauthCallback: async () => new Response('ok'),
    mail: (uid) => (connected.gmail ? provider.mail(uid, 'ref') : null),
    calendar: (uid) => (connected.gcal ? provider.calendar(uid, 'ref') : null),
    revoke: async () => {},
    sendConnectCard: async (_u, kind, _c, reason) => {
      connectCards.push({ kind, ...(reason ? { reason } : {}) });
    },
    devConnect: async () => new Response('ok'),
  };
  const outbox: OutboxRequest[] = [];
  const ks = createFakeKeyStore();
  const s = {
    config: testConfig(),
    clock, log: nullLogger, repos, crypto: createFakeCrypto(ks, new Uint8Array(32).fill(7)), ledger: createFakeLedger(clock), quotas: createFakeQuotas(clock),
    caps: createFakeCapabilities(() => clock.now()),
    integrations,
    toolkits: createMemoryToolkitState(),
    choices: createMemoryChoices(),
    strings: createFakeStrings(),
    telegram: notImplemented('telegram', {
      codec: createFakeCodec(),
      outbox: notImplemented('outbox', { enqueue: (r: OutboxRequest) => (outbox.push(r), r.idempotencyKey) }),
    }),
    reminders: notImplemented('reminders', { rescheduleForTz: () => 0 }),
    brief: notImplemented('brief', { setDaily: () => {} }),
  } as unknown as Services & { caps: ReturnType<typeof createFakeCapabilities> };
  s.capabilities = s.caps;
  s.location = s.caps.location;
  let n = 0;
  const effects: Effect[] = [];
  const ctx = (over: Partial<ToolCtx> = {}): ToolCtx => {
    const id = `toolu_${++n}`;
    return {
      toolUseId: id, runId: 'run_1', conversationId: 'conv_1', epoch: 1, userId: user.id, tgUserId: 1001, surface: 'dm', scope: { kind: 'user', userId: user.id },
      tz: o.tz ?? 'Asia/Almaty', lang: 'en', now: clock.now(), chat: { chatId: 1001, triggerMessageId: 55 }, taint: new Set(), signal: new AbortController().signal,
      effects: { push: (e) => effects.push(e) }, services: s, log: nullLogger, idemKey: id, priority: 'interactive', ...over,
    };
  };
  /** Runs a spec the way the executor does: zod-parse, then execute (tests only; never outside the executor in src). */
  const run = async <I,>(spec: ToolSpec<I>, input: unknown, c: ToolCtx = ctx()) => spec['execute'](spec.input.parse(input) as I, c);
  return { s, user, clock, provider, outbox, effects, ctx, run, connectCards, connected };
}
