// 01 §15.2 WP7 /why: lists the memories used, the tools, the sources, and whether a fallback served the reply
// (deterministic, no LLM), with a Forget button per memory; only the owner's own messages are explained.
import { afterEach, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '../../src/contracts/index.ts';
import { SURF } from '../../src/surfaces/strings.ts';
import { createFakePolicy, createRecordingSignals } from '../harness/fakes.ts';
import { OTHER_USER, TEST_USER, U } from '../harness/updates.ts';
import { createSurfacesApp, lastButtons, sentTexts, type SurfacesTestApp } from '../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function answeredRun(app: SurfacesTestApp, o: { fallback: boolean }) {
  const s = app.s;
  await app.send(U.start());
  const user = s.repos.users.getByTg(TEST_USER.id)!;
  const scope = { kind: 'user' as const, userId: user.id };
  const veg = await s.memory.save(scope, { text: 'vegetarian', kind: 'preference', sensitivity: 'normal', explicit: true, authorUserId: user.id, source: { kind: 'user_message' } });
  await s.memory.save(scope, { text: 'unrelated fact', kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: user.id, source: { kind: 'user_message' } });
  const vegId = 'id' in veg ? veg.id : '';
  const conv = s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });
  const epoch = s.repos.conversations.currentEpoch(conv.id).epoch;
  const run = s.repos.runs.create({ conversationId: conv.id, userId: user.id, epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: TEST_USER.id }, maxTokens: 1000, taint: ['web'] });
  s.repos.runs.recordMemoryUses(run.id, [vegId]);
  s.repos.runs.stageToolCalls([
    { toolUseId: 'toolu_1', runId: run.id, conversationId: conv.id, epoch, userId: user.id, assistantSeq: 1, ordinal: 0, name: 'web_search', input: { query: 'vegan cafes almaty' } },
    { toolUseId: 'toolu_2', runId: run.id, conversationId: conv.id, epoch, userId: user.id, assistantSeq: 1, ordinal: 1, name: 'weather_get', input: { place: 'Almaty' } },
  ]);
  s.repos.runs.updateToolCall('toolu_1', { status: 'done', result: { answer: 'Try these', sources: [{ title: 'Guide', url: 'https://www.almaty-eats.kz/vegan' }, { title: 'Map', url: 'https://maps.example.org/x' }] } });
  s.repos.runs.updateToolCall('toolu_2', { status: 'done', result: { tempC: 12 } });
  s.repos.runs.recordLlmCall({
    runId: run.id, conversationId: conv.id, epoch, userId: user.id, purpose: 'main', requestHmac: 'h', modelRequested: 'claude-opus-5', modelServed: o.fallback ? 'claude-opus-4-8' : 'claude-opus-5',
    servedByFallback: o.fallback, stopReason: 'end_turn', refusalCategory: null, usage: ZERO_USAGE, iterations: null, costMicros: 0, latencyMs: 10, ttftMs: 5, requestId: 'req_1', errorClass: null, raw: null,
  });
  s.repos.runs.update(run.id, { state: 'done' });
  const answer = await app.s.telegram.api.sendRichMessage(TEST_USER.id, { markdown: 'Here are two vegan cafés.', skip_entity_detection: true });
  s.telegram.links.record({ chatId: TEST_USER.id, messageId: answer.message_id, kind: 'answer', userId: user.id, conversationId: conv.id, epoch, runId: run.id });
  return { user, run, vegId, answerId: answer.message_id };
}

describe('/why', () => {
  it('lists memories used (with Forget), tools with queries, sources and the fallback model', async () => {
    const app = await createSurfacesApp();
    t = app;
    const { vegId, answerId } = await answeredRun(app, { fallback: true });
    const llmBefore = app.llm.requests.length;
    await app.send(U.command('why', '', { replyTo: answerId }));
    const md = sentTexts(app).at(-1)!.replace(/\\(.)/g, '$1'); // markdown-escaped by the renderer
    expect(md).toContain(SURF.why_title.en);
    expect(md).toContain(`[${vegId}] vegetarian`);
    expect(md).not.toContain('unrelated fact');
    expect(md).toContain('web_search: “vegan cafes almaty”');
    expect(md).toContain('weather_get: “Almaty”');
    expect(md).toContain('almaty-eats.kz');
    expect(md).toContain('maps.example.org');
    expect(md).toContain('(a fallback model answered)');
    expect(md).toContain('claude-opus-4-8');
    expect(md).toContain('External content was read');
    expect(lastButtons(app).some((b) => b.data?.startsWith(`mm:fg:${vegId}`))).toBe(true);
    expect(app.llm.requests.length).toBe(llmBefore); // deterministic, no LLM
  });

  it('says when the primary model answered, handles non-replies and never explains someone else’s message', async () => {
    const app = await createSurfacesApp();
    t = app;
    const { answerId } = await answeredRun(app, { fallback: false });
    await app.send(U.command('why', '', { replyTo: answerId }));
    expect(sentTexts(app).at(-1)).toContain('Answered by: claude-opus-5');
    expect(sentTexts(app).at(-1)).not.toContain('fallback');
    await app.send(U.command('why'));
    expect(sentTexts(app).at(-1)).toBe(SURF.why_usage.en);
    await app.send(U.command('why', '', { replyTo: 9999 }));
    expect(sentTexts(app).at(-1)).toBe(SURF.why_unknown.en);
    await app.send(U.command('why', '', { replyTo: answerId, user: OTHER_USER }));
    expect(sentTexts(app).at(-1)).toBe(SURF.why_unknown.en);
  });

  it('a message Gora wrote first (pl_ id) shows the arm, gap, score and reason from the policy, never nudges.get (05 C4)', async () => {
    const policy = createFakePolicy();
    const explained: string[] = [];
    policy.explain = (id) => {
      explained.push(id);
      return id === 'pl_7' ? { contentType: 'follow_up', gapBucket: '3-5d', score: 0.4213, reason: 'asks how the interview went', sentAt: 1 } : undefined;
    };
    const app = await createSurfacesApp({ extraFactories: { createBehaviourModule: () => ({ signals: createRecordingSignals(), policy }) } });
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });
    const sent = await app.s.telegram.api.sendRichMessage(TEST_USER.id, { markdown: 'How did the interview go?', skip_entity_detection: true });
    app.s.telegram.links.record({ chatId: TEST_USER.id, messageId: sent.message_id, kind: 'nudge', nudgeId: 'pl_7', userId: user.id, conversationId: conv.id });
    const llmBefore = app.llm.requests.length;
    await app.send(U.command('why', '', { replyTo: sent.message_id }));
    const md = sentTexts(app).at(-1)!.replace(/\\(.)/g, '$1');
    expect(md).toContain(SURF.proactive_type_follow_up.en);
    expect(md).toContain('3-5d');
    expect(md).toContain('0.42');
    expect(md).toContain('asks how the interview went');
    expect(explained).toEqual(['pl_7']);
    expect(app.llm.requests.length).toBe(llmBefore);
    // the message itself never carried a "Why now" line
    expect(sentTexts(app).some((x) => x.includes('Why now'))).toBe(false);
  });
});
