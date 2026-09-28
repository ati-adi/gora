// Skeptic proof (spec 05 C4 "first_hint (only for users who never wrote after /start)"): users created before
// migration 003 have a DM history but no user_signals / user_rhythm rows. The policy's "never wrote" test is
// `signals.lastInboundAt === null`, so every such live user who has not written since the upgrade is offered ONLY the
// first_hint arm ("one tiny example of what to say"), and the gap is measured from users.created_at instead of their
// last message. users.last_seen_at (kept by upsertFromTelegram) and the transcript are ignored.
import { afterEach, describe, expect, it } from 'vitest';
import { createBehaviourRepo } from '../../../src/behaviour/repo.ts';
import { createSignals } from '../../../src/behaviour/signals.ts';
import { createPolicy } from '../../../src/behaviour/policy.ts';
import { createProactiveRepo } from '../../../src/proactive/repo.ts';
import { addUser, createFriendApp, DAY, localAt, seedHistory, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';

describe('skeptic: pre-003 users are treated as "never wrote"', () => {
  it('a user who chatted for weeks before the upgrade is offered first_hint, not checkin', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    // weeks of real conversation happened before 003 existed …
    seedHistory(t, u, { days: 14, hour: 12 });
    // … i.e. in a pre-003 DB none of it is in the behaviour tables (they did not exist), but users.last_seen_at is set
    t.s.db.prepare(`DELETE FROM user_signals WHERE user_id = ?`).run(u.id);
    t.s.db.prepare(`DELETE FROM user_rhythm WHERE user_id = ?`).run(u.id);
    const lastSeen = localAt(t, TZ, -1, 12);
    t.s.db.prepare(`UPDATE users SET created_at = ?, last_seen_at = ? WHERE id = ?`).run(t.clock.now() - 60 * DAY, lastSeen, u.id);
    const repo = createBehaviourRepo(() => t!.s.db, () => t!.s.crypto);
    const sig = createSignals(t.s, repo);
    const pol = createPolicy(t.s, repo, sig, createProactiveRepo(() => t!.s.db, () => t!.s.crypto));
    const now = localAt(t, TZ, 0, 12); // a daytime hour the default day shape ranks in the top 30%
    const d = pol.evaluate(t.s.repos.users.getById(u.id)!, now);
    expect(d.reason).toMatch(/tau/); // it reached the bandit
    // spec: first_hint is only for users who never wrote after /start; this user wrote yesterday
    expect(d.contentType).not.toBe('first_hint');
    // and the gap is from their last message (1 day), not from account creation (60 days)
    expect(d.gapBucket).toBe('1-2d');
  });
});
