// Review (memory): "forget" does not remove the fact from every later request / view.
//  (a) memory_search results are never recorded in run_memory_uses (store.ts:403 search() vs retrieve() at :382), so a
//      conversation whose transcript holds the fact via a memory_search tool result is not rotated by forgetFacts (:571-586).
//  (b) the extractor stores the WHOLE source input as each fact's quote (extract.ts:175); forgetting one fact leaves its
//      text inside the sibling fact's quote, which list()/export/Mini App (routes/memory.ts:80) keep showing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationRow, InputRow, MemoryService, RunRow, Scheduler, Scope, ToolSpec } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { TOOLS } from '../../../src/memory/tools.ts';
import { makeEnv, toolCtx, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
let sch: Scheduler;
let mem: MemoryService;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  mem = createMemoryService(env.s);
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

const MIN = 60_000;
const tool = (n: string) => TOOLS.find((t) => t.name === n) as ToolSpec;
function addInput(conv: ConversationRow, text: string): string {
  return env.repos.inputs.add({
    conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text }],
    tgUpdateId: null, tgChatId: conv.tgChatId, tgMessageId: 10, fromTgUserId: null, replyToCardId: null,
  });
}
function finishRun(conv: ConversationRow, inputIds: string[]): RunRow {
  const run = env.repos.runs.create({ conversationId: conv.id, userId: conv.userId, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId!, triggerMessageId: 10 }, maxTokens: 1000 });
  env.repos.inputs.markConsumed(inputIds, run.id, 1);
  env.repos.runs.update(run.id, { state: 'done' });
  const done = env.repos.runs.get(run.id)!;
  for (const h of env.s.runHooks) void h.onRunFinished(done, conv, []);
  return done;
}

describe('forget leaves the fact reachable', () => {
  it('a conversation that saw the fact through memory_search is not rotated on forget', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const saved = await mem.save(sc, { text: 'Owes Marat 5000 dollars', kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' } });
    const id = (saved as { id: string }).id;
    // topic conversation: the model calls memory_search, the tool result (with the fact text) lands in its transcript
    const topic = env.dmConv(u, 42);
    const run = env.repos.runs.create({ conversationId: topic.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.tgUserId }, maxTokens: 1000 });
    const ctx = { ...toolCtx(env, { userId: u.id, tgUserId: u.tgUserId, surface: 'topic' }), runId: run.id, conversationId: topic.id };
    const out = await tool('memory_search').execute({ query: 'Marat dollars', limit: 8 } as never, ctx);
    expect(out.content).toContain('Owes Marat 5000 dollars');
    // forget from the DM
    await mem.forget(sc, { ids: [id] }, { tgUserId: u.tgUserId });
    // regression (was failing before the fix): the topic conversation is not rotated, so its transcript (with the fact) is replayed in later requests
    expect(env.runner.rotations.map((r) => r.conversationId)).toContain(topic.id);
  });

  it("forgetting one extracted fact leaves its text in a sibling fact's quote (list / export / Mini App)", async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const conv = env.dmConv(u);
    const inp = addInput(conv, 'I am vegetarian. My sister Dana is in rehab in Almaty.');
    finishRun(conv, [inp]);
    env.side.extractResult = {
      facts: [
        { text: 'Vegetarian', kind: 'preference', subject: null, sensitivity: 'normal', confidence: 0.9, source_input_id: inp, supersedes_id: null, explicit: false },
        { text: 'Sister Dana is in rehab in Almaty', kind: 'person', subject: 'Dana', sensitivity: 'normal', confidence: 0.9, source_input_id: inp, supersedes_id: null, explicit: false },
      ],
      commitments: [],
    };
    await env.clock.advance(10 * MIN); // spec 05 B1: the batch runs after 10 idle minutes (or 3 exchanges)
    await sch.tick();
    const items = (await mem.list(sc, { limit: 20 })).items;
    const dana = items.find((f) => f.text.includes('Dana'))!;
    await mem.forget(sc, { ids: [dana.id] }, { tgUserId: u.tgUserId });
    const after = (await mem.list(sc, { limit: 20 })).items;
    expect(after.map((f) => f.text)).toEqual(['Vegetarian']);
    // regression (was failing before the fix): the forgotten sentence survives verbatim in the remaining fact's quote
    expect(JSON.stringify(after)).not.toContain('rehab');
  });
});
