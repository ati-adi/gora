// INTEGRATION (TRUST-11): a phrase step-up minted for one pending action (the Mini App route passes its id) cannot
// create an always grant for another action whose target shares the first word ('ALWAYS ANNA' for anna@x.com and
// anna@evil.com). Without an action id the grant stays phrase-bound (direct service callers).
import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock } from '../../../src/contracts/index.ts';
import { expectedPhrase } from '../../../src/trust/stepup.ts';
import { fakeEmailTool, makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function twoAnnas() {
  const tool = fakeEmailTool();
  env = makeEnv([tool]);
  const u = env.addUser();
  for (const v of ['anna@x.com', 'anna@evil.com']) env.s.trustedTargets.add(u.id, { kind: 'email', value: v, source: 'miniapp' });
  const { conv, run } = env.addConv(u);
  const last: Record<string, string> = {};
  let seq = 1;
  for (const to of ['anna@x.com', 'anna@evil.com']) {
    for (let i = 0; i < 3; i++) {
      const out = await env.s.executor.processRound(run, conv, seq, [use(`t${seq}`, 'send_email', { to, subject: `s${seq}`, body: 'b' })] as BetaToolUseBlock[], null as never, signal());
      seq++;
      const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
      if (i < 2) await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
      else last[to] = id;
    }
  }
  return { u, good: last['anna@x.com']!, evil: last['anna@evil.com']! };
}

describe('phrase step-up bound to the pending action (TRUST-11)', () => {
  it('an action-bound "ALWAYS ANNA" grant is rejected for anna@evil.com and accepted for anna@x.com', async () => {
    const { u, good, evil } = await twoAnnas();
    const view = env!.s.approvals.get(good, u.id)!;
    const phrase = expectedPhrase(view.targets[0]!.display);
    expect(phrase).toBe(expectedPhrase(env!.s.approvals.get(evil, u.id)!.targets[0]!.display));
    const g = env!.s.stepup.verifyPhrase(u.id, 'ALWAYS ANNA', phrase, 60_000, good)!;
    expect(await env!.s.grants.createAlways(u.id, evil, g.grantId)).toEqual({ error: 'stepup_invalid' });
    const ok = await env!.s.grants.createAlways(u.id, good, g.grantId);
    expect('id' in ok).toBe(true);
  });
});
