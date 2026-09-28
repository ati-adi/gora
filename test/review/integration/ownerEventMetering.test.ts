// INTEGRATION (F7): an owner-requested event run (the brief preview: trigger 'event', priority 'interactive') spends a
// turn and is refused with the quota template when turns are used up — no model call. A scheduled (proactive) brief is
// not metered.
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeQuotas } from '../../harness/fakes.ts';
import { say } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp } from '../agent/_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const brief = { type: 'brief' as const, ref: 'brief:2026-09-28', body: 'Morning brief PREVIEW requested by the owner.' };

describe('owner-requested event runs are metered (F7)', () => {
  it('brief preview consumes a turn; with no turns left it gets the quota template and makes no model call', async () => {
    const x = await agentApp();
    app = x.t;
    const q = x.t.s.quotas as unknown as FakeQuotas;
    x.t.llm.push(say('Your brief.'));
    x.runner.startEventRun(x.conv.id, brief, { channel: 'notify', priority: 'interactive', replyRef: { chatId: 1001 } });
    await x.t.settle();
    expect(q.check(x.user.id, 'turn').used).toBe(1);
    expect(x.t.llm.requests).toHaveLength(1);
    q.limits.turn = 1;
    const id = x.runner.startEventRun(x.conv.id, brief, { channel: 'notify', priority: 'interactive', replyRef: { chatId: 1001 } });
    await x.t.settle();
    expect(x.t.llm.requests).toHaveLength(1);
    expect(x.t.s.repos.runs.get(id)!.stopCategory).toBe('quota');
  });
  it('a scheduled (proactive) brief is not metered', async () => {
    const x = await agentApp();
    app = x.t;
    const q = x.t.s.quotas as unknown as FakeQuotas;
    x.t.llm.push(say('Your brief.'));
    x.runner.startEventRun(x.conv.id, { ...brief, body: 'Scheduled morning brief.' }, { channel: 'notify', priority: 'proactive', replyRef: { chatId: 1001 } });
    await x.t.settle();
    expect(q.check(x.user.id, 'turn').used).toBe(0);
    expect(x.t.llm.requests).toHaveLength(1);
  });
});
