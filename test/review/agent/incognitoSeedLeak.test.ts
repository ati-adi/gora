// PROOF (agent review): an incognito_end rotation seeds the new (permanent) epoch with a deterministic seed that QUOTES
// the owner's messages from the incognito epoch (epochs.ts deterministicSeed: ownerAuthoredSince + consumedEpoch ===
// old epoch). The incognito epoch is then shredded, but its text lives on verbatim in the next epoch's seed row and is
// sent to the model on every later request. 01 §9: incognito_end seeds from the PRE-incognito handoff and shreds the
// incognito epoch; F5: "starts an epoch that is shredded when incognito ends".
import { afterEach, describe, expect, it } from 'vitest';
import { say } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, cur, rowsOf, userSays } from './_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('incognito_end rotation', () => {
  it('does not carry incognito-epoch owner messages into the post-incognito epoch', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(say('Hi.'));
    await userSays(x.t, x.conv, 'hello there');
    // /incognito on → rotate (incognito_start)
    x.runner.requestRotation(x.conv.id, 'incognito_start');
    x.t.llm.push(say('Noted.'));
    await userSays(x.t, x.conv, 'SECRET-INCOGNITO: my HIV test came back positive');
    const incogEpoch = cur(x.t, x.conv).epoch;
    expect(x.t.s.repos.conversations.currentEpoch(x.conv.id).reason).toBe('incognito_start');
    // incognito ends → rotate (incognito_end); the incognito epoch is to be shredded
    x.runner.requestRotation(x.conv.id, 'incognito_end');
    x.t.llm.push(say('Ok.'));
    await userSays(x.t, x.conv, 'what is the weather');
    expect(cur(x.t, x.conv).epoch).toBeGreaterThan(incogEpoch);
    const after = JSON.stringify(rowsOf(x.t, x.conv).map((r) => r.content));
    const lastReq = JSON.stringify(x.t.llm.requests[x.t.llm.requests.length - 1]!.messages);
    expect(lastReq).not.toContain('SECRET-INCOGNITO');
    expect(after).not.toContain('SECRET-INCOGNITO');
  });
});
