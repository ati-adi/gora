// REVIEW (proactive) — Stop on a mission whose budget is used up does not stop its run.
// missions.ts stop(): `const e = effective(m)`; effective() returns { run: undefined } for any status other than
// active/parked, so for 'budget_exhausted' neither the parked-run wake('cancelled') nor stopRun() is reached.
// 01 §5.7: "Stopping a parked or background run (mission [⏹ Stop]): wake it with cancelled … No model call is made."
// Worse: once the mission is 'cancelled', engine.missionBudgetExhausted() (status === 'budget_exhausted') is false, so a
// run that survives Stop resumes model calls with no budget gate at all.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../../src/contracts/index.ts';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function exhaustedMission(t: Wp6bApp, u: UserRow): Promise<{ id: string; conv: string }> {
  const { missionId, conversationId } = await t.s.missions.start({ userId: u.id, tgUserId: u.tgUserId, title: 'Fares', goal: 'g', criteria: ['c'], taint: [] });
  await t.settle();
  return { id: missionId, conv: conversationId };
}

describe('mission Stop while budget_exhausted', () => {
  it('a run parked by task_wait in the same round that used up the budget is left parked by Stop', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const { id, conv } = await exhaustedMission(t, u);
    // The last paid model call asked for task_wait(watcher:W1): the run parks; the call's cost exhausts the budget.
    const run = t.parkRun(conv, ['watcher:WAAAAAA']);
    const budget = Math.round(t.s.missions.get(id)!.budgetUsd * 1e6);
    expect(t.s.missions.chargeCost(id, budget).exhausted).toBe(true);
    await t.settle();
    expect(t.s.missions.get(id)!.status).toBe('budget_exhausted');

    await t.s.missions.stop(id, u.tgUserId); // owner taps ⏹ Stop on the "budget used up" card
    await t.settle();

    expect(t.s.missions.get(id)!.status).toBe('cancelled');
    // Expected per §5.7: the parked run is woken with 'cancelled'. Actual: still parked (and will resume at its
    // timeout with the budget gate gone, because the mission is no longer 'budget_exhausted').
    expect(t.runner.wakes.map((w) => w.p.reason)).toContain('cancelled');
    expect(t.s.repos.runs.get(run.id)!.state).not.toBe('parked');
  });

  it('a live run of an exhausted mission is not stopped by Stop', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const { id, conv } = await exhaustedMission(t, u);
    const c = t.s.repos.conversations.get(conv)!;
    const run = t.s.repos.runs.create({ conversationId: conv, userId: u.id, epoch: c.epoch, trigger: 'mission_start', triggerRef: null, channel: 'notify', replyRef: { chatId: u.tgUserId, missionId: id }, maxTokens: 1000 });
    t.s.repos.runs.update(run.id, { state: 'running' });
    t.s.repos.conversations.casActiveRun(conv, c.activeRunId, run.id);
    const budget = Math.round(t.s.missions.get(id)!.budgetUsd * 1e6);
    t.s.missions.chargeCost(id, budget); // exhausted mid-run (tool round still executing)
    await t.s.missions.stop(id, u.tgUserId);
    await t.settle();
    expect(t.runner.stops).toContain(run.id);
  });
});
