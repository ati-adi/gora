// RED TEAM (friend mode, spec 05 C4): the 90-day retention of user_signals / proactive_log silently resets two safety
// caps that must hold "until the user writes":
//  (a) the hard stop after 4 consecutive unanswered Gora-first messages is computed from user_signals only
//      (sig.unanswered counts gora_sent since the last inbound/reply SIGNAL). Once the retention sweep deletes the
//      old gora_sent rows the count drops back to 0 and Gora starts writing first again to someone who ignored it.
//  (b) first_hint ("at most 2" for owners who never wrote) is counted from proactive_log, which the same sweep
//      prunes after 90 days: a /start-only user gets 2 more hints every ~90 days, forever.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../../src/contracts/index.ts';
import { createSignals } from '../../../src/behaviour/signals.ts';
import { createPolicy } from '../../../src/behaviour/policy.ts';
import { createBehaviourRepo } from '../../../src/behaviour/repo.ts';
import { createProactiveRepo } from '../../../src/proactive/repo.ts';
import { addUser, createFriendApp, DAY, HOUR, localAt, seedHistory, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';
const internals = (t: FriendApp) => {
  const repo = createBehaviourRepo(() => t.s.db, () => t.s.crypto);
  const sig = createSignals(t.s, repo);
  return { repo, sig, pol: createPolicy(t.s, repo, sig, createProactiveRepo(() => t.s.db, () => t.s.crypto)) };
};

describe('retention resets the proactive safety caps', () => {
  it('(a) hard stop after 4 unanswered must survive the 90-day signal retention (owner never wrote back)', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    const { pol, sig } = internals(t);
    // four Gora-first messages on four evenings, none answered
    for (let d = 1; d <= 4; d++) t.s.signals.goraSent(u.id, { at: localAt(t, TZ, d, 20, 10), source: 'proactive' });
    const later = localAt(t, TZ, 5, 20, 10);
    expect(sig.unanswered(u.id)).toBe(4);
    expect(pol.evaluate(t.s.repos.users.getById(u.id)!, later).reason).toBe('hard_stop');
    // ~3 months of silence; the daily retention sweep runs
    const hook = t.s.privacyHooks.find((h) => h.name === 'behaviour')!;
    const after = localAt(t, TZ, 100, 20, 10);
    await hook.retentionSweep!(after);
    // the owner still has not written a single word since the 4 ignored messages
    expect(sig.unanswered(u.id)).toBe(4); // FAILS: 0 — the streak evaporated with the pruned rows
    expect(pol.evaluate(t.s.repos.users.getById(u.id)!, after).reason).toBe('hard_stop');
  });

  it('(b) first_hint stays capped at 2 for an owner who never wrote, also after the 90-day log retention', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const other = addUser(t, { tz: TZ });
    seedHistory(t, other, { days: 14, hour: 19 }); // a population prior so the silent user has "active" hours
    const u: UserRow = addUser(t, { tz: TZ });
    const { pol, repo } = internals(t);
    const at = localAt(t, TZ, 0, 19, 10);
    for (let i = 0; i < 2; i++) {
      const sentAt = at - (10 + i) * DAY;
      repo.insertLog({ id: `pl_h${i}`, userId: u.id, arm: 'first_hint|<1d', contentType: 'first_hint', gapBucket: '<1d', score: 1, sent: true, reason: 'ok', text: 'hint', now: sentAt });
      repo.setReward(`pl_h${i}`, 0, null); // the 24 h window closed unanswered
    }
    expect(pol.evaluate(t.s.repos.users.getById(u.id)!, at).reason).toBe('no_content');
    const hook = t.s.privacyHooks.find((h) => h.name === 'behaviour')!;
    const later = at + 95 * DAY;
    await hook.retentionSweep!(later);
    const types = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const d = pol.evaluate(t.s.repos.users.getById(u.id)!, later + (i % 2) * HOUR / 6);
      if (d.contentType) types.add(d.contentType);
    }
    expect([...types]).not.toContain('first_hint'); // FAILS: first_hint is offered again (3rd, 4th … hint)
  });
});
