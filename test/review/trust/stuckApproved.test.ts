// REVIEW (trust) — an approval whose process dies between the CAS pending→approved (approvals.resolve) and the end of
// executeApproved (CAS approved→executing … executing→executed) is stuck forever: nothing in src/ ever reads a
// pending_actions row in 'approved' or 'executing' again (expireDue/dueForExpiry only select status='pending', there is
// no boot recovery, and a re-tap hits the failed CAS → "already handled"). The owner's approved send silently never
// happens (or, for 'executing', is never reconciled), the card keeps its buttons and the parked run is never woken.
import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock } from '../../../src/contracts/index.ts';
import { fakeEmailTool, makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe('approval stuck after a restart mid-execution', () => {
  it.each(['approved', 'executing'] as const)('a row left in %s is eventually resolved (retried, reconciled or marked unknown)', async (crashed) => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'send_email', { to: 'anna@x.com', subject: 'Hi', body: 'Hello' })] as BetaToolUseBlock[], null as never, signal());
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    // The owner tapped Approve; the process died right after the CAS (state as left in the DB).
    env.tmp.db.prepare('UPDATE pending_actions SET status = ?, decided_at = ?, decided_by_tg_id = ?, decided_via = ? WHERE id = ?').run(crashed, env.clock.now(), u.tgUserId, 'callback', id);
    // After the restart the owner taps again → "already handled", nothing executes.
    const again = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(again.status).toBe('already_handled');
    // Time passes; every sweep runs. The row must not stay in a non-terminal state forever.
    await env.clock.advance(48 * 3_600_000);
    await env.s.approvals.expireDue(env.clock.now());
    const status = env.tmp.db.prepare('SELECT status FROM pending_actions WHERE id = ?').get<{ status: string }>(id)!.status;
    expect(['executed', 'failed', 'unknown', 'expired']).toContain(status);
  });

  it("a row left in 'approved' runs on the next sweep while the approval is still valid, exactly once", async () => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'send_email', { to: 'anna@x.com', subject: 'Hi', body: 'Hello' })] as BetaToolUseBlock[], null as never, signal());
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    env.tmp.db.prepare('UPDATE pending_actions SET status = ?, decided_at = ?, decided_by_tg_id = ?, decided_via = ? WHERE id = ?').run('approved', env.clock.now(), u.tgUserId, 'callback', id);
    await env.clock.advance(2 * 60_000);
    await env.s.approvals.expireDue(env.clock.now()); // too fresh: may still be executing in this process
    expect(env.tmp.db.prepare('SELECT status FROM pending_actions WHERE id = ?').get<{ status: string }>(id)!.status).toBe('approved');
    await env.clock.advance(10 * 60_000);
    await env.s.approvals.expireDue(env.clock.now());
    await env.s.approvals.expireDue(env.clock.now());
    expect(env.tmp.db.prepare('SELECT status FROM pending_actions WHERE id = ?').get<{ status: string }>(id)!.status).toBe('executed');
    expect(tool.sent).toHaveLength(1);
  });
});
