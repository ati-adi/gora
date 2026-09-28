import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock } from '../../../src/contracts/index.ts';
import { expectedPhrase } from '../../../src/trust/stepup.ts';
import { fakeEmailTool, makeEnv, signal, use, type Env } from './env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe('step-up (01 §11.1, ⚠U20)', () => {
  it('biometric token path: enroll → verify → a single-use grant', () => {
    env = makeEnv([]);
    const u = env.addUser();
    const { token } = env.s.stepup.enroll(u.id);
    expect(env.s.stepup.verifyBiometric(u.id, 'x'.repeat(40))).toBeNull();
    const other = env.addUser(2002);
    expect(env.s.stepup.verifyBiometric(other.id, token)).toBeNull();
    const g = env.s.stepup.verifyBiometric(u.id, token)!;
    expect(g.grantId).toBeTruthy();
    expect(env.s.stepup.consume(u.id, g.grantId)).toBe(true);
    expect(env.s.stepup.consume(u.id, g.grantId)).toBe(false);
  });

  it('re-enrolling revokes the previous device token', () => {
    env = makeEnv([]);
    const u = env.addUser();
    const a = env.s.stepup.enroll(u.id).token;
    const b = env.s.stepup.enroll(u.id).token;
    expect(env.s.stepup.verifyBiometric(u.id, a)).toBeNull();
    expect(env.s.stepup.verifyBiometric(u.id, b)).not.toBeNull();
  });

  it('phrase path: fresh initData + ALWAYS <FIRST WORD>', () => {
    env = makeEnv([]);
    const u = env.addUser();
    const expected = expectedPhrase('anna@x.com');
    expect(expected).toBe('ALWAYS ANNA');
    expect(env.s.stepup.verifyPhrase(u.id, 'always anna', expected, 60_000)).not.toBeNull();
    expect(env.s.stepup.verifyPhrase(u.id, 'ALWAYS BOB', expected, 60_000)).toBeNull();
    expect(env.s.stepup.verifyPhrase(u.id, 'ALWAYS ANNA', expected, 6 * 60_000)).toBeNull();
  });

  it('grants expire after 5 minutes', async () => {
    env = makeEnv([]);
    const u = env.addUser();
    const g = env.s.stepup.verifyPhrase(u.id, 'ALWAYS ANNA', 'ALWAYS ANNA', 0)!;
    await env.clock.advance(5 * 60_000 + 1);
    expect(env.s.stepup.consume(u.id, g.grantId)).toBe(false);
  });

  it('createAlways needs S16 eligibility (ladder) and a valid step-up', async () => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const u = env.addUser();
    env.s.trustedTargets.add(u.id, { kind: 'email', value: 'anna@x.com', source: 'miniapp' });
    const { conv, run } = env.addConv(u);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await env.s.executor.processRound(run, conv, i + 1, [use(`t${i}`, 'send_email', { to: 'anna@x.com', subject: `s${i}`, body: 'b' })] as BetaToolUseBlock[], null as never, signal());
      ids.push(JSON.parse(String(out.results[0]!.content)).approval_id);
      if (i === 0) {
        // no executed history yet: the ladder is not met
        const g0 = env.s.stepup.verifyPhrase(u.id, 'ALWAYS ANNA', 'ALWAYS ANNA', 0)!;
        expect(await env.s.grants.createAlways(u.id, ids[0]!, g0.grantId)).toEqual({ error: 'not_eligible' });
      }
      if (i < 2) await env.s.approvals.resolve(ids[i]!, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    }
    const g1 = env.s.stepup.verifyPhrase(u.id, 'ALWAYS ANNA', 'ALWAYS ANNA', 0)!;
    expect(await env.s.grants.createAlways(u.id, ids[2]!, 'bogus')).toEqual({ error: 'stepup_invalid' });
    const view = env.s.approvals.get(ids[2]!, u.id)!;
    expect(view.ladderOffer).toBe(true);
    const r = await env.s.grants.createAlways(u.id, ids[2]!, g1.grantId);
    expect('id' in r).toBe(true);
    expect(env.s.grants.list(u.id)).toMatchObject([{ toolName: 'send_email', scope: 'always', expiresAt: null }]);
    // the next send to anna is allowed by S15 (clean run)
    const out = await env.s.executor.processRound(run, conv, 9, [use('t9', 'send_email', { to: 'anna@x.com', subject: 'z', body: 'b' })] as BetaToolUseBlock[], null as never, signal());
    expect(String(out.results[0]!.content)).toContain('sent');
    expect(env.s.grants.revoke(u.id, env.s.grants.list(u.id)[0]!.id)).toBe(true);
    expect(env.s.grants.list(u.id)).toEqual([]);
  });
});
