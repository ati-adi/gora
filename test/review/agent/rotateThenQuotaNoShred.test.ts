// PROOF (agent review): engine.ts start() rotates the epoch FIRST (rotate() clears rotate_pending and starts the new
// epoch), then checks the quota and returns early via finishWithTemplate(). The shred of the old epoch is scheduled only
// at the END of start() (`if (shred) scheduleShred(...)`), and the in-memory seed is dropped. So when the owner is over
// the daily quota (free plan) at the moment a forget rotation happens at run start, the epoch that holds the forgotten
// text is NEVER shredded: rotate_pending is already cleared, so the pending epoch_rotate job finds nothing to do.
// Same early exit loses the seed (context) for size rotations.
import { afterEach, describe, expect, it } from 'vitest';
import { say } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, cur, userSays } from './_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('rotation at run start followed by a quota template', () => {
  it('still shreds the old epoch of a forget rotation', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(say('Noted.'));
    await userSays(x.t, x.conv, 'my ex-partner lives at 12 Abay St');
    const oldEpoch = cur(x.t, x.conv).epoch;
    // the owner forgets the fact → rotate_pending='forget' (+ an epoch_rotate job that has not fired yet)
    x.runner.requestRotation(x.conv.id, 'forget', { excludeTexts: ['12 Abay St'] });
    // the owner is out of free turns for today
    (x.t.s.quotas as unknown as { limits: Record<string, number> }).limits['turn'] = 1;
    await userSays(x.t, x.conv, 'hi again');
    // the second run got the quota template: its only model call is the rotation's handoff fork
    expect(x.t.llm.requests).toHaveLength(2);
    expect(JSON.stringify(x.t.llm.requests[1]!.messages)).toContain('handoff_request');
    expect(cur(x.t, x.conv).epoch).toBeGreaterThan(oldEpoch); // …but it rotated at run start first
    // the epoch_rotate job now fires: nothing is pending any more
    expect(await x.runner.rotateNow(x.conv.id)).toBe('none');
    const sched = (x.t.s.scheduler as unknown as { jobs: Map<string, { kind: string; payload: Record<string, unknown>; status: string }> }).jobs;
    const shreds = [...sched.values()].filter((j) => j.kind === 'shred_epoch' && j.payload['epoch'] === oldEpoch);
    expect(shreds.length, 'shred_epoch scheduled for the forgotten epoch').toBeGreaterThan(0);
  });
});
