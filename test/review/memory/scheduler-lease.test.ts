// Review (scheduler): a handler that outlives its lease is re-claimed while it is still running in this very process.
// scheduler.ts:185 only *signals* abort at lease-10 s; nothing keeps an in-flight job from being released (repo.ts:108)
// and re-claimed (repo.ts:124) by the next tick, and claim() never checks attempts <= max_attempts, so a hung handler is
// launched again every 5 minutes forever (never 'dead'). The memory_extract handler ignores ctx.signal and side.extract
// passes no signal to the transport (extract.ts:199, agent/side.ts:59; Anthropic transport timeout is 600 s > 300 s lease),
// so one slow LLM call becomes N concurrent duplicate extraction calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationRow, RunRow, Scheduler } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createJobsRepo } from '../../../src/scheduler/repo.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
let sch: Scheduler;
const MIN = 60_000;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  createMemoryService(env.s);
});
afterEach(() => {
  env.close();
});

function finishRun(conv: ConversationRow, text: string): RunRow {
  const id = env.repos.inputs.add({
    conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text }],
    tgUpdateId: null, tgChatId: conv.tgChatId, tgMessageId: 10, fromTgUserId: null, replyToCardId: null,
  });
  const run = env.repos.runs.create({ conversationId: conv.id, userId: conv.userId, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId!, triggerMessageId: 10 }, maxTokens: 1000 });
  env.repos.inputs.markConsumed([id], run.id, 1);
  env.repos.runs.update(run.id, { state: 'done' });
  const done = env.repos.runs.get(run.id)!;
  for (const h of env.s.runHooks) void h.onRunFinished(done, conv, []);
  return done;
}

describe('lease expiry while the handler is still running', () => {
  it('a slow extraction is launched again every lease period, beyond max_attempts, never dead', async () => {
    const u = env.user();
    const conv = env.dmConv(u);
    finishRun(conv, 'I like green tea');
    let calls = 0;
    // a slow / hung LLM call that (like the real one) has no signal to abort it
    (env.side as { extract: unknown }).extract = () => {
      calls++;
      return new Promise(() => {});
    };
    await env.clock.advance(10 * MIN); // spec 05 B1: the batch runs after 10 idle minutes (or 3 exchanges)
    void sch.tick();
    await env.clock.advance(0);
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i++) {
      await env.clock.advance(6 * MIN); // lease (5 min) expires; the first handler is still awaiting the LLM
      void sch.tick();
      await env.clock.advance(0);
    }
    const j = createJobsRepo(env.db).byDedupe(`mx:${conv.id}`)!;
    // regression (was failing before the fix): 6 concurrent extraction calls for one job, attempts 6 > max_attempts 4, status still 'leased'
    expect({ calls, overMax: j.attempts > j.maxAttempts }).toEqual({ calls: 1, overMax: false });
  });
});
