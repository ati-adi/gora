// RED TEAM (friend mode, spec 05 C4 "hard-stop after 4 consecutive unanswered until the user writes"; "the old
// fixed-cadence re-engagement or nudge kinds must not double-send"). The unrequested nudge kinds (date_from_memory,
// checkin) ask ProactivePolicy.canSendNow(), which checks only status / botBlocked / proactive 'off' / the 24 h cap —
// not the unanswered streak. After 4 ignored Gora-first messages the policy is silent, but a date_from_memory nudge
// (which also skips the friend check) still goes out, and then one per day for every remembered date.
import { afterEach, describe, expect, it } from 'vitest';
import type { NudgeCandidate, UserRow } from '../../../src/contracts/index.ts';
import { addUser, createFriendApp, DAY, localAt, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const TZ = 'Asia/Almaty';
const cand = (u: UserRow, refId: string): NudgeCandidate => ({
  userId: u.id, kind: 'date_from_memory', dedupeKey: `date:${refId}:2026`, refId, why: "Tomorrow: Anna's birthday", body: 'A date to remember is tomorrow',
  score: 0.75, priority: 'normal', countsAgainstBudget: true,
});

describe('unrequested nudges vs the hard stop', () => {
  it('after 4 unanswered Gora-first messages no unrequested nudge goes out until the owner writes', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    t.s.signals.inbound(u.id, { at: localAt(t, TZ, -10, 20), text: 'hi' });
    for (let d = 0; d < 4; d++) t.s.signals.goraSent(u.id, { at: localAt(t, TZ, -8 + d, 20), source: 'proactive' });
    await t.clock.set(localAt(t, TZ, 0, 10));
    expect(await t.s.nudges.propose(cand(u, 'f1'))).toBe('dropped'); // FAILS: 'sent'
    await t.clock.set(t.clock.now() + DAY);
    expect(await t.s.nudges.propose(cand(u, 'f2'))).toBe('dropped');
  });
});
