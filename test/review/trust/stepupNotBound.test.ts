// REVIEW (trust) — the ⚠U20 phrase step-up is computed from ONE pending action's first target ('ALWAYS ANNA' for
// anna@x.com; http/routes/stepup.ts passes pendingActionId only to build the expected phrase), but the step-up grant it
// mints (stepup.ts grant(): stepup_grants has no action/target column) is consumed by grants.createAlways for ANY
// pending action of the user (consume() checks only user/unused/unexpired). Typing "ALWAYS ANNA" therefore authorizes a
// permanent always-allow grant for bob@y.com — the per-target intent check the phrase exists for is not enforced.
import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock } from '../../../src/contracts/index.ts';
import { expectedPhrase } from '../../../src/trust/stepup.ts';
import { fakeEmailTool, makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe('phrase step-up is bound to the action/target it was typed for', () => {
  it('"ALWAYS ANNA" cannot create an always grant for bob@y.com', async () => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const u = env.addUser();
    for (const v of ['anna@x.com', 'bob@y.com']) env.s.trustedTargets.add(u.id, { kind: 'email', value: v, source: 'miniapp' });
    const { conv, run } = env.addConv(u);
    const last: Record<string, string> = {};
    let seq = 1;
    for (const to of ['anna@x.com', 'bob@y.com']) {
      for (let i = 0; i < 3; i++) {
        const out = await env.s.executor.processRound(run, conv, seq, [use(`t${seq}`, 'send_email', { to, subject: `s${seq}`, body: 'b' })] as BetaToolUseBlock[], null as never, signal());
        seq++;
        const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
        if (i < 2) await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
        else last[to] = id;
      }
    }
    // Step-up done on Anna's card (the phrase is Anna's).
    const annaView = env.s.approvals.get(last['anna@x.com']!, u.id)!;
    const g = env.s.stepup.verifyPhrase(u.id, 'ALWAYS ANNA', expectedPhrase(annaView.targets[0]!.display), 60_000)!;
    expect(g).not.toBeNull();
    // …used for Bob's action instead.
    const r = await env.s.grants.createAlways(u.id, last['bob@y.com']!, g.grantId);
    expect(r).toEqual({ error: 'stepup_invalid' });
  });
});
