// WP3 e2e — crash recovery (01 §5.11, §15.2): crash during the stream → the call is re-issued on the unchanged history;
// crash during tools → executor.finishInterruptedRound (an `unknown` outcome is not retried and the model asks the owner);
// a crash after the final assistant row → marked done and the final text re-sent once; exactly one visible final message.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BetaToolResultBlockParam, ConversationRow, Factories, MemoryService, ToolSpec, TrustModule, UserRow } from '../../src/contracts/index.ts';
import { createAgentModule } from '../../src/agent/index.ts';
import type { EngineRunner } from '../../src/agent/engine.ts';
import { checkEpochGrammar } from '../../src/agent/grammar.ts';
import { flushMicrotasks } from '../../src/kernel/clock.ts';
import { AbortedError } from '../../src/kernel/errors.ts';
import {
  NOOP_FACTORIES, createFakeCapabilities, createFakeGovernance, createFakeIntegrations, createFakeLedger, createFakeQuotas, createFakeScheduler, createFakeStrings,
  createFakeTelegramModule, createRecordingChannelFactory, createStaticRegistry, notImplemented,
} from '../harness/fakes.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { createTestApp } from '../harness/testApp.ts';
import type { TestApp } from '../harness/testApp.ts';

const UNKNOWN = 'Outcome unknown after restart; not retried — ask the owner';
const sendTool: ToolSpec = {
  name: 'weather_get', description: 'Weather.', input: z.object({}), surfaces: ['dm', 'topic', 'mission'], parallelSafe: false,
  classify: () => ({ actionClass: 'read_public', risk: 0 }), statusLabel: () => 'working', execute: async () => ({ content: 'ok' }),
};
const ctl = { hangTools: false, inTools: false };

function trustModule(s: Parameters<NonNullable<Factories['createTrustModule']>>[0]): TrustModule {
  const base = NOOP_FACTORIES.createTrustModule(s);
  const pt = base.executor;
  return {
    ...base,
    executor: {
      ...pt,
      async processRound(run, conv, seq, uses, ch, signal) {
        if (!ctl.hangTools) return pt.processRound(run, conv, seq, uses, ch, signal);
        ctl.hangTools = false;
        s.repos.runs.stageToolCalls(uses.map((u, ordinal) => ({ toolUseId: u.id, runId: run.id, conversationId: conv.id, epoch: run.epoch, userId: run.userId, assistantSeq: seq, ordinal, name: u.name, input: u.input })));
        for (const u of uses) s.repos.runs.updateToolCall(u.id, { status: 'executing' });
        ctl.inTools = true;
        return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new AbortedError(String(signal.reason))), { once: true }));
      },
      async finishInterruptedRound(run, _conv, seq) {
        // WP4 reconcile stand-in: an 'executing' call whose reconcile() says 'unknown' is not retried
        const results: BetaToolResultBlockParam[] = s.repos.runs.toolCallsFor(run.id, seq).map((c) =>
          c.status === 'executing'
            ? { type: 'tool_result', tool_use_id: c.toolUseId, content: UNKNOWN, is_error: true }
            : { type: 'tool_result', tool_use_id: c.toolUseId, content: String(c.result ?? ''), ...(c.isError ? { is_error: true } : {}) },
        );
        return { results, park: null, taintAdded: [], effects: [] };
      },
    },
  };
}

async function agentApp(): Promise<{ t: TestApp; channels: ReturnType<typeof createRecordingChannelFactory>; user: UserRow; conv: ConversationRow }> {
  const channels = createRecordingChannelFactory();
  const factories: Partial<Factories> = {
    createStrings: () => createFakeStrings(),
    createLedger: (s) => createFakeLedger(s.clock),
    createQuotaService: (s) => createFakeQuotas(s.clock),
    createLlmGovernance: () => createFakeGovernance(),
    createCapabilities: (_c, _f, s) => createFakeCapabilities(() => s.clock.now()),
    createIntegrationService: (s, p) => createFakeIntegrations(s.config.publicUrl, p ?? null),
    createToolRegistry: () => createStaticRegistry([sendTool]),
    createTrustModule: trustModule,
    createMemoryService: () => notImplemented<MemoryService>('memory', { filterFingerprinted: (_s, xs) => xs }),
    createScheduler: (s) => createFakeScheduler(() => s.clock),
    createReminderModule: NOOP_FACTORIES.createReminderModule,
    createProactiveModule: NOOP_FACTORIES.createProactiveModule,
    createMissionModule: NOOP_FACTORIES.createMissionModule,
    createTelegramModule: (s, o) => createFakeTelegramModule(s, o),
    createBusinessModule: NOOP_FACTORIES.createBusinessModule,
    createSurfaces: NOOP_FACTORIES.createSurfaces,
    createHttpApp: NOOP_FACTORIES.createHttpApp,
    createAgentModule: (s) => createAgentModule(s, { channels }),
  };
  const t = await createTestApp({ factories });
  const user = t.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  const conv = t.s.conversations.resolve({ kind: 'dm', tgUserId: 1001 }, { userId: user.id, tgChatId: 1001 });
  return { t, channels, user, conv };
}

let seq = 0;
function addInput(t: TestApp, conv: ConversationRow, text: string): void {
  seq += 1;
  t.s.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text }], tgUpdateId: 80_000 + seq, tgChatId: 1001, tgMessageId: 700 + seq, fromTgUserId: 1001, replyToCardId: null });
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await flushMicrotasks();
  if (!cond()) throw new Error('until(): condition never became true');
}
/** app.stop() while a run is in flight; the FakeClock is advanced so the shutdown grace period can elapse. */
async function crashRestart(t: TestApp): Promise<TestApp> {
  let t2: TestApp | null = null;
  let err: unknown = null;
  const p = t.restart().then((x) => (t2 = x), (e: unknown) => (err = e));
  for (let i = 0; i < 100 && !t2 && !err; i++) {
    await flushMicrotasks();
    await t.clock.advance(1_000);
  }
  await p;
  if (err) throw err;
  return t2!;
}
const finals = (ch: ReturnType<typeof createRecordingChannelFactory>) => ch.channels.flatMap((c) => c.log.filter((l) => l.op === 'finalize').map((l) => (l.arg as { text: string }).text));
const rows = (t: TestApp, conv: ConversationRow) => t.s.repos.messages.load(conv.id, t.s.repos.conversations.get(conv.id)!.epoch);

let app: TestApp | null = null;
afterEach(async () => {
  ctl.hangTools = false;
  ctl.inTools = false;
  await app?.close();
  app = null;
});

describe('crash recovery (01 §5.11)', () => {
  it('crash during the stream: nothing persisted; after restart the model call is re-issued; one final message', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().text('Partial that will be lost').hang(), say('The full answer.'));
    addInput(x.t, x.conv, 'explain');
    (x.t.s.runner as EngineRunner).startNext(x.conv.id);
    await until(() => x.channels.channels.some((c) => c.log.some((l) => l.op === 'text')));
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId!;
    const t2 = await crashRestart(x.t);
    app = t2;
    await t2.settle();
    expect(t2.s.repos.runs.get(runId)!.state).toBe('done');
    expect(rows(t2, x.conv).map((m) => m.kind)).toEqual(['user_input', 'context', 'assistant']);
    expect(finals(x.channels)).toEqual(['The full answer.']);
    expect(t2.llm.requests).toHaveLength(2);
    expect(JSON.stringify(t2.llm.requests[1]!.messages)).toBe(JSON.stringify(t2.llm.requests[0]!.messages));
    t2.llm.assertInvariants();
  });

  it('crash during tools: reconcile → an unknown outcome is not retried and the model asks the owner; one final message', async () => {
    const x = await agentApp();
    app = x.t;
    ctl.hangTools = true;
    x.t.llm.push(turn().text('Doing it.').toolUse('weather_get', {}, 'toolu_crash'), say('I could not confirm whether that went through — could you check?'));
    addInput(x.t, x.conv, 'do the thing');
    (x.t.s.runner as EngineRunner).startNext(x.conv.id);
    await until(() => ctl.inTools);
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId!;
    const t2 = await crashRestart(x.t);
    app = t2;
    await t2.settle();
    const r = rows(t2, x.conv);
    expect(r.map((m) => m.kind)).toEqual(['user_input', 'context', 'assistant', 'tool_results', 'context', 'assistant']);
    const res = (r[3]!.content.content as unknown as Array<{ tool_use_id: string; content: string; is_error?: boolean }>)[0]!;
    expect(res).toMatchObject({ tool_use_id: 'toolu_crash', content: UNKNOWN, is_error: true });
    expect(t2.s.repos.runs.get(runId)!.state).toBe('done');
    expect(finals(x.channels)).toEqual(['I could not confirm whether that went through — could you check?']);
    expect(checkEpochGrammar(r)).toEqual([]);
    t2.llm.assertInvariants();
  });

  it('crash after the final assistant row: marked done and the final text re-sent exactly once (outbox idempotency)', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(say('Final words.'));
    addInput(x.t, x.conv, 'wrap up');
    x.t.s.runner.kick(x.conv.id);
    await x.t.settle();
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId ?? (rows(x.t, x.conv).pop()!.runId as string);
    // simulate the crash window: the row is persisted, finalize never ran
    x.t.s.repos.runs.update(runId, { state: 'running', phase: 'model', leaseUntil: x.t.clock.now() + 120_000 });
    x.t.s.repos.conversations.casActiveRun(x.conv.id, null, runId);
    const before = x.t.tg.callsOf('sendMessage', 'sendRichMessage').length;
    const t2 = await x.t.restart();
    app = t2;
    await t2.settle();
    await t2.s.telegram.outbox.flush();
    expect(t2.s.repos.runs.get(runId)!.state).toBe('done');
    expect(t2.llm.requests).toHaveLength(1); // no new model call
    const sent = t2.tg.callsOf('sendMessage', 'sendRichMessage').slice(before);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.payload)).toContain('Final words.');
    // a second restart does not send it again
    const t3 = await t2.restart();
    app = t3;
    await t3.settle();
    expect(t3.tg.callsOf('sendMessage', 'sendRichMessage').slice(before)).toHaveLength(1);
  });
});
