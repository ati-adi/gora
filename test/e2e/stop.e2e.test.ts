// WP3 e2e — Stop (01 §5.7, §15.2): Stop mid-stream → synthetic partial row; Stop mid-tools → is_error results THEN a
// synthetic row; stopping a parked run; the next request passes the invariants.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConversationRow, Factories, MemoryService, ToolSpec, UserRow } from '../../src/contracts/index.ts';
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

const started: string[] = [];
const slow: ToolSpec = {
  name: 'slow_lookup', description: 'Slow lookup.', input: z.object({}), surfaces: ['dm', 'topic', 'mission'], parallelSafe: false,
  classify: () => ({ actionClass: 'read_public', risk: 0 }), statusLabel: () => 'looking up',
  execute: (_i, ctx) => {
    started.push('slow_lookup');
    return new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new AbortedError('user_stop')), { once: true }));
  },
};
const quick: ToolSpec = {
  name: 'weather_get', description: 'Weather.', input: z.object({ place: z.string().optional() }), surfaces: ['dm', 'topic', 'mission'], parallelSafe: true,
  classify: () => ({ actionClass: 'read_public', risk: 0 }), statusLabel: () => 'weather',
  execute: async (_i, ctx) => {
    if (ctx.signal.aborted) throw new AbortedError('user_stop');
    started.push('weather_get');
    return { content: '12°C' };
  },
};
const waitTool: ToolSpec = {
  name: 'task_wait', description: 'Wait.', input: z.object({ on: z.array(z.string()), timeout_hours: z.number().optional() }), surfaces: ['dm', 'topic', 'mission'], parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }), statusLabel: () => 'waiting', execute: async () => ({ content: 'unused' }),
};

async function agentApp(): Promise<{ t: TestApp; channels: ReturnType<typeof createRecordingChannelFactory>; runner: EngineRunner; user: UserRow; conv: ConversationRow }> {
  const channels = createRecordingChannelFactory();
  const factories: Partial<Factories> = {
    createStrings: () => createFakeStrings(),
    createLedger: (s) => createFakeLedger(s.clock),
    createQuotaService: (s) => createFakeQuotas(s.clock),
    createLlmGovernance: () => createFakeGovernance(),
    createCapabilities: (_c, _f, s) => createFakeCapabilities(() => s.clock.now()),
    createIntegrationService: (s, p) => createFakeIntegrations(s.config.publicUrl, p ?? null),
    createToolRegistry: () => createStaticRegistry([slow, quick, waitTool]),
    createTrustModule: NOOP_FACTORIES.createTrustModule,
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
  return { t, channels, runner: t.s.runner as EngineRunner, user, conv };
}

let seq = 0;
function addInput(t: TestApp, conv: ConversationRow, text: string): void {
  seq += 1;
  t.s.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text }], tgUpdateId: 70_000 + seq, tgChatId: 1001, tgMessageId: 300 + seq, fromTgUserId: 1001, replyToCardId: null });
}
const rows = (t: TestApp, conv: ConversationRow) => {
  const c = t.s.repos.conversations.get(conv.id)!;
  return t.s.repos.messages.load(c.id, c.epoch);
};
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await flushMicrotasks();
  if (!cond()) throw new Error('until(): condition never became true');
}
const text = (m: { content: { content: unknown } }) => JSON.stringify(m.content.content);

let app: TestApp | null = null;
afterEach(async () => {
  started.length = 0;
  await app?.close();
  app = null;
});

describe('Stop (01 §5.7)', () => {
  it('Stop mid-stream (via the draft): nothing from the call is persisted but a synthetic partial + [stopped by user]', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().text('Here is the partial answer').hang());
    addInput(x.t, x.conv, 'tell me a long story');
    x.runner.startNext(x.conv.id);
    const ch = () => x.channels.channels[0];
    await until(() => !!ch() && ch()!.log.some((l) => l.op === 'text'));
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId!;
    const run = x.t.s.repos.runs.get(runId)!;
    expect(run.draftId).not.toBeNull();
    expect(await x.runner.stopByDraft(1001, 0, run.draftId!)).toBe(true);
    await x.t.settle();
    const r = rows(x.t, x.conv);
    expect(r.map((m) => m.kind)).toEqual(['user_input', 'context', 'synthetic']);
    expect(text(r[2]!)).toContain('Here is the partial answer');
    expect(text(r[2]!)).toContain('[stopped by user]');
    expect(ch()!.log.map((l) => l.op)).toContain('stopped');
    expect(x.t.s.repos.runs.get(runId)).toMatchObject({ state: 'cancelled', stopCategory: 'user_stop' });
    expect(x.t.s.repos.conversations.get(x.conv.id)!.activeRunId).toBeNull();
    // the next request passes the invariants (and its context says the previous reply was stopped)
    x.t.llm.push(say('Sure, shorter then.'));
    addInput(x.t, x.conv, 'ok, shorter');
    x.t.s.runner.kick(x.conv.id);
    await x.t.settle();
    expect(checkEpochGrammar(rows(x.t, x.conv))).toEqual([]);
    expect(JSON.stringify(x.t.llm.requests[1]!.messages)).toContain('Your previous reply was stopped by the owner.');
    x.t.llm.assertInvariants();
  });

  it('Stop mid-tools: one tool_results row covering every tool_use (is_error) THEN a synthetic row', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().text('Looking.').toolUse('slow_lookup', {}, 'toolu_a').toolUse('weather_get', {}, 'toolu_b'));
    addInput(x.t, x.conv, 'look it up');
    x.runner.startNext(x.conv.id);
    await until(() => started.includes('slow_lookup'));
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId!;
    expect(await x.runner.stopRun(runId, 'user')).toBe(true);
    await x.t.settle();
    const r = rows(x.t, x.conv);
    expect(r.map((m) => m.kind)).toEqual(['user_input', 'context', 'assistant', 'tool_results', 'synthetic']);
    const results = r[3]!.content.content as unknown as Array<{ type: string; tool_use_id: string; is_error?: boolean }>;
    expect(results.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(results.every((b) => b.is_error === true)).toBe(true);
    expect(text(r[4]!)).toContain('[stopped by user]');
    expect(started).not.toContain('weather_get');
    expect(checkEpochGrammar(r)).toEqual([]);
    x.t.llm.push(say('Stopped as asked.'));
    addInput(x.t, x.conv, 'thanks');
    x.t.s.runner.kick(x.conv.id);
    await x.t.settle();
    x.t.llm.assertInvariants();
  });

  it('stopping a parked run wakes it with cancelled: task_wait result, synthetic row, no model call', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().toolUse('task_wait', { on: ['watcher:W1'], timeout_hours: 2 }, 'toolu_w'));
    addInput(x.t, x.conv, 'wait for it');
    x.t.s.runner.kick(x.conv.id);
    await x.t.settle();
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId!;
    expect(x.t.s.repos.runs.get(runId)!.state).toBe('parked');
    expect(await x.runner.stopRun(runId, 'user')).toBe(true);
    await x.t.settle();
    const r = rows(x.t, x.conv);
    expect(r.map((m) => m.kind)).toEqual(['user_input', 'context', 'assistant', 'tool_results', 'synthetic']);
    expect(text(r[3]!)).toContain('woke_because');
    expect(text(r[3]!)).toContain('cancelled');
    expect(x.t.llm.requests).toHaveLength(1);
    expect(x.t.s.repos.runs.get(runId)!.state).toBe('cancelled');
    expect(checkEpochGrammar(r)).toEqual([]);
  });
});
