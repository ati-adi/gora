// PROOF (agent review): rotateNow() (the epoch_rotate job) awaits the handoff side call while the conversation is idle
// and rotate_pending is still set; a run that starts meanwhile sees the same rotate_pending and rotates AGAIN. The two
// rotations interleave: the run writes its rows into epoch N+1 while rotateNow() then starts epoch N+2 (seeded from the
// summary of epoch N). The run's exchange is silently dropped from the conversation context and N+1 is orphaned.
// FIXED (agent fixer): rotateNow() holds a per-conversation rotation lock; a run start waits for it and then uses the
// new epoch (one rotation, one handoff call). The gate is released while the run waits (holding it until the run is done
// would now deadlock by design: the run correctly waits for the job's rotation).
import { afterEach, describe, expect, it } from 'vitest';
import { say } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { addInput, agentApp, cur, rowsOf, userSays } from './_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('rotateNow vs a run start', () => {
  it('a run started while the epoch_rotate job awaits its handoff leaves its rows in the current epoch', async () => {
    const x = await agentApp({ env: { LLM_PROVIDER: 'groq' } });
    app = x.t;
    x.t.llm.push(say('Hi.'));
    await userSays(x.t, x.conv, 'hello there');
    // a forget sets rotate_pending and schedules the epoch_rotate job
    x.t.s.repos.conversations.update(x.conv.id, { rotatePending: 'forget' });
    const before = cur(x.t, x.conv).epoch;
    x.t.llm.pushParse('handoff', { note: 'Summary A.' });
    // the job's handoff side call is slower than the run's (network latency): hold it until the run is done
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = x.t.llm as unknown as { parse: (...a: unknown[]) => Promise<unknown> };
    const orig = llm.parse.bind(llm);
    let n = 0;
    llm.parse = async (...a: unknown[]) => {
      if (n++ === 0) await gate;
      return orig(...a);
    };
    const job = x.runner.rotateNow(x.conv.id); // the job is running (awaiting the handoff side call)
    addInput(x.t, x.conv, 'REMEMBER-THIS: book the 9am train');
    x.runner.startNext(x.conv.id); // the owner's message starts a run meanwhile
    x.t.llm.push(say('Booked-reply.'));
    for (let i = 0; i < 50; i++) await Promise.resolve(); // the run reaches its start and waits on the job's rotation
    release();
    expect(await job).toBe('done');
    await x.t.settle();
    const epoch = cur(x.t, x.conv).epoch;
    expect(epoch, 'exactly one rotation').toBe(before + 1);
    expect(n, 'exactly one handoff side call').toBe(1);
    const texts = JSON.stringify(rowsOf(x.t, x.conv, epoch).map((r) => r.content));
    // the run's exchange must be in the epoch the next request will be built from
    expect(texts).toContain('REMEMBER-THIS');
    expect(texts).toContain('Booked-reply.');
  });
});
