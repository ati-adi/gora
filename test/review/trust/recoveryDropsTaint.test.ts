// REVIEW (trust) — executor.finishInterruptedRound (crash recovery of a tool round, 01 §5.11) re-emits the stored
// results of calls that already finished ('done' / 'error' …, executor.ts:559-569) but never re-derives their taint:
// `taint` stays empty for them, so RoundOutcome.taintAdded omits e.g. 'email' for a gmail_read_thread that completed
// before the restart. The engine's afterRound then adds nothing: the <untrusted source="email"> result is appended to
// the epoch, yet the run/epoch stay UNTAINTED → later sends skip S14, S15 grants apply, the LLM Sentinel is not
// consulted. (Same loss on the user-Stop path: engine.stopDuringTools appends out.results but never calls addTaint.)
import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock } from '../../../src/contracts/index.ts';
import { fakeReadTool, makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe('crash recovery keeps the taint of finished calls', () => {
  it('a mail read that completed before the restart still taints the recovered round', async () => {
    env = makeEnv([fakeReadTool('mail_read', { taint: 'email' })]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const first = await env.s.executor.processRound(run, conv, 1, [use('a', 'mail_read', { q: 'inbox' })] as BetaToolUseBlock[], null as never, signal());
    expect(first.taintAdded).toEqual(['email']);
    expect(String(first.results[0]!.content)).toMatch(/^<untrusted source="email"/);
    // Process dies before engine.afterRound persisted the taint. On restart the round is finished from tool_calls.
    const rec = await env.s.executor.finishInterruptedRound(run, conv, 1);
    expect(String(rec.results[0]!.content)).toMatch(/^<untrusted source="email"/); // the email text goes to the model…
    expect(rec.taintAdded).toContain('email'); // …so the run must be tainted
  });

  it('the taint is persisted on the run and epoch as soon as the wrapped output exists (Stop / shutdown safe)', async () => {
    env = makeEnv([fakeReadTool('mail_read', { taint: 'email' })]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    await env.s.executor.processRound(run, conv, 1, [use('a', 'mail_read', { q: 'inbox' })] as BetaToolUseBlock[], null as never, signal());
    // No engine.afterRound ran (user Stop appends the results without addTaint).
    expect(env.repos.runs.get(run.id)!.taint).toContain('email');
    expect(env.repos.conversations.getEpoch(conv.id, run.epoch)!.taint).toContain('email');
  });
});
