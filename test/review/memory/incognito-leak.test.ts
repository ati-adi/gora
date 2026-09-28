// Review (memory): incognito is detected only by the conversation's *current epoch reason* ('incognito_start').
// Any other rotation during incognito (/new → 'user_new', size, idle, forget…) or a conversation that was never rotated
// (topics / missions: /incognito rotates only the DM) makes incognito-time inputs look like normal ones:
//   - memory/extract.ts:131 extracts them into memory after incognito ends;
//   - memory/incognito.ts:27 does not rotate/shred that conversation at incognito end.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationRow, MemoryService, RunRow, Scheduler } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
let sch: Scheduler;
let _mem: MemoryService;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  _mem = createMemoryService(env.s);
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

const MIN = 60_000;
function addInput(conv: ConversationRow, text: string): string {
  return env.repos.inputs.add({
    conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text }],
    tgUpdateId: null, tgChatId: conv.tgChatId, tgMessageId: 10, fromTgUserId: null, replyToCardId: null,
  });
}
function finishRun(conv: ConversationRow, inputIds: string[]): RunRow {
  const epoch = env.repos.conversations.get(conv.id)!.epoch;
  const run = env.repos.runs.create({ conversationId: conv.id, userId: conv.userId, epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId!, triggerMessageId: 10 }, maxTokens: 1000 });
  env.repos.inputs.markConsumed(inputIds, run.id, epoch);
  env.repos.runs.update(run.id, { state: 'done' });
  const done = env.repos.runs.get(run.id)!;
  for (const h of env.s.runHooks) void h.onRunFinished(done, env.repos.conversations.get(conv.id)!, []);
  return done;
}

describe('incognito content leaks into memory', () => {
  // Production scheduling: agent/engine.ts:1022 schedules memory_extract (+2 min, dedupe mx:<conv>) after EVERY dm/topic/
  // mission run, incognito or not. A job that fires during incognito only bumps the watermark (extract.ts:108-111); one
  // that fires after incognito ended reads everything since the watermark and filters only incognito_start epochs.
  const engineSchedule = (conv: ConversationRow, run: RunRow) =>
    sch.schedule({ kind: 'memory_extract', runAt: env.clock.now() + 2 * MIN, userId: conv.userId!, refId: conv.id, payload: { conversationId: conv.id, runId: run.id }, dedupeKey: `mx:${conv.id}` });
  const walk = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      await env.clock.advance(MIN);
      await sch.tick();
    }
  };

  it('/new during incognito: the last incognito messages are extracted once incognito expires', async () => {
    const u = env.user();
    const conv = env.dmConv(u);
    env.side.extractResult = { facts: [], commitments: [] };
    // /incognito 1h → DM rotates to an incognito_start epoch
    env.repos.users.update(u.id, { incognitoUntil: env.clock.now() + 60 * MIN });
    env.repos.conversations.startEpoch(conv.id, 'incognito_start', 'deterministic', []);
    engineSchedule(conv, finishRun(conv, [addInput(conv, 'first incognito message')]));
    await walk(10); // the job fires during incognito → only the watermark moves
    // /new during incognito → a plain user_new epoch (surfaces/commands.ts:77)
    env.repos.conversations.startEpoch(conv.id, 'user_new', 'none', []);
    await walk(48);
    engineSchedule(conv, finishRun(conv, [addInput(conv, 'My HIV test came back positive.')])); // minute 58 of 60
    await walk(1);
    env.repos.users.update(u.id, { incognitoUntil: null }); // expired (or /incognito off)
    await walk(3);
    // regression (was failing before the fix): the incognito-time sentence reaches the extractor (and would be saved as a fact)
    expect(JSON.stringify(env.side.extractCalls)).not.toContain('HIV');
  });

  it('incognito_end does not rotate (shred) a DM whose incognito epoch was replaced by /new', async () => {
    const u = env.user();
    const conv = env.dmConv(u);
    env.repos.users.update(u.id, { incognitoUntil: env.clock.now() + 60 * MIN });
    env.repos.conversations.startEpoch(conv.id, 'incognito_start', 'deterministic', []);
    env.repos.conversations.startEpoch(conv.id, 'user_new', 'none', []);
    sch.schedule({ kind: 'incognito_end', runAt: env.clock.now() + 60 * MIN, userId: u.id, dedupeKey: `incog:${u.id}` });
    await env.clock.advance(61 * MIN);
    await sch.tick();
    // regression (was failing before the fix): no incognito_end rotation → the incognito-time epoch keeps living in the conversation context
    expect(env.runner.rotations.map((r) => [r.conversationId, r.reason])).toContainEqual([conv.id, 'incognito_end']);
  });

  it('topic conversation used during incognito: its last messages are extracted after incognito ends', async () => {
    const u = env.user();
    const dm = env.dmConv(u);
    const topic = env.dmConv(u, 77);
    env.side.extractResult = { facts: [], commitments: [] };
    env.repos.users.update(u.id, { incognitoUntil: env.clock.now() + 60 * MIN });
    env.repos.conversations.startEpoch(dm.id, 'incognito_start', 'deterministic', []); // only the DM rotates
    await walk(58);
    engineSchedule(topic, finishRun(topic, [addInput(topic, 'I am secretly interviewing at a competitor.')]));
    await walk(1);
    env.repos.users.update(u.id, { incognitoUntil: null });
    await walk(3);
    // regression (was failing before the fix): the incognito-time topic message reaches the extractor
    expect(JSON.stringify(env.side.extractCalls)).not.toContain('competitor');
  });
});
