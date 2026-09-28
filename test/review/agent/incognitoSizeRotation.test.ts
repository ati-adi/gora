// PROOF (agent review): an incognito epoch (reason 'incognito_start') is rotated like any other epoch by the engine's
// run-start rules (epochs.ts rotationReason: 'size' after 2 400 estimated tokens on groq-free, also 'idle'/'upgrade').
// That rotation (1) sends the incognito transcript to the fast model for a handoff note and seeds the NEW epoch with it,
// (2) is not a shred reason, and (3) gives the new epoch reason 'size'. The incognito_end job (memory/incognito.ts) only
// rotates conversations whose CURRENT epoch reason is 'incognito_start', so when incognito ends nothing is shredded and
// the incognito content lives on (seed of the current epoch + the old epoch, kept for 90 days).
// FIXED (agent fixer): rotations inside an open incognito window make no handoff (deterministic seed, the new epoch stays
// in the window), and incognito_end seeds from the pre-incognito epoch and shreds EVERY window epoch. Note: the real
// incognito_end job (memory/incognito.ts openWindowStart) walks back past the 'size' epoch to the incognito_start one, so
// it does request the rotation; the test now mirrors that instead of skipping it.
import { afterEach, describe, expect, it } from 'vitest';
import { say } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, cur, rowsOf, userSays } from './_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('incognito epoch and size rotation (groq-free)', () => {
  it('incognito content does not outlive the end of incognito', async () => {
    const x = await agentApp({ env: { LLM_PROVIDER: 'groq' } });
    app = x.t;
    x.t.llm.push(say('Hi.'));
    await userSays(x.t, x.conv, 'hello');
    x.runner.requestRotation(x.conv.id, 'incognito_start'); // /incognito 1h
    x.t.llm.push(say(`Understood. ${'I will keep that private. '.repeat(400)}`)); // a normal long answer (> 2 400 est. tokens in the epoch)
    await userSays(x.t, x.conv, 'SECRET-INCOGNITO: I am planning to quit my job at Kaspi next month');
    const incogEpoch = cur(x.t, x.conv).epoch;
    expect(x.t.s.repos.conversations.currentEpoch(x.conv.id).reason).toBe('incognito_start');
    // next message, still incognito: the engine rotates for size and seeds from a fast-model handoff of the incognito epoch
    x.t.llm.push(say('Sure.'));
    await userSays(x.t, x.conv, 'ok, and what about lunch?');
    const sizeEpoch = cur(x.t, x.conv).epoch;
    expect(sizeEpoch).toBeGreaterThan(incogEpoch);
    expect(JSON.stringify(x.t.llm.parseRequests.map((p) => p.user)), 'no handoff side call over incognito text').not.toContain('SECRET-INCOGNITO');
    // incognito ends: memory/incognito.ts finds the window (walking back past the 'size' epoch) and requests the rotation
    x.runner.requestRotation(x.conv.id, 'incognito_end');
    x.t.llm.push(say('Back to normal.'));
    await userSays(x.t, x.conv, 'thanks');
    const now = JSON.stringify(rowsOf(x.t, x.conv).map((r) => r.content));
    const jobs = (x.t.s.scheduler as unknown as { jobs: Map<string, { kind: string; payload: Record<string, unknown> }> }).jobs;
    const shredIncog = [...jobs.values()].some((j) => j.kind === 'shred_epoch' && j.payload['epoch'] === incogEpoch);
    const shredSize = [...jobs.values()].some((j) => j.kind === 'shred_epoch' && j.payload['epoch'] === sizeEpoch);
    expect.soft(shredIncog, 'the incognito epoch is shredded when incognito ends').toBe(true);
    expect.soft(shredSize, 'the in-window size epoch is shredded when incognito ends').toBe(true);
    expect(now, 'the post-incognito transcript carries no incognito content').not.toContain('SECRET-INCOGNITO');
  });
});
