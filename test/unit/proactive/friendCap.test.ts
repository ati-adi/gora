// Friend set B — spec 05 C4 "Integration": the existing nudges and the brief report every Gora-first message to the
// behaviour signals (shared 24 h cap, unanswered streak); the unrequested nudge kinds ask the policy first; nudges have
// no "Why now:" label any more (the details line stays).
import { afterEach, describe, expect, it } from 'vitest';
import type { NudgeCandidate, UserRow } from '../../../src/contracts/index.ts';
import { say } from '../../harness/scriptedTransport.ts';
import { addUser, advanceTicks, createFriendApp, DAY, HOUR, localAt, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';
const cand = (u: UserRow, over: Partial<NudgeCandidate> = {}): NudgeCandidate => ({
  userId: u.id, kind: 'commitment_due', dedupeKey: `k:${over.kind ?? 'c'}:${over.refId ?? 1}`, why: 'You told Anna you would send the deck by 15:00.', body: 'Send the deck to Anna',
  score: 0.8, priority: 'normal', countsAgainstBudget: true, ...over,
});
const goraSent = (t: FriendApp, u: UserRow) => t.s.db.prepare(`SELECT source FROM user_signals WHERE user_id = ? AND kind = 'gora_sent' ORDER BY id`).all<{ source: string }>(u.id).map((r) => r.source);

describe('nudges and the brief share the proactive cap', () => {
  it('a sent nudge counts; an unrequested date nudge then waits for the cap; requested kinds still go out', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    await t.clock.set(localAt(t, TZ, 0, 10));
    expect(t.s.proactivePolicy.canSendNow(u.id, t.clock.now())).toBe(true);
    expect(await t.s.nudges.propose(cand(u))).toBe('sent');
    await t.settle();
    expect(goraSent(t, u)).toEqual(['nudge']);
    expect(t.s.proactivePolicy.canSendNow(u.id, t.clock.now())).toBe(false);
    expect(await t.s.nudges.propose(cand(u, { kind: 'date_from_memory', refId: 'm1', why: 'Tomorrow: Anna\'s birthday', body: 'A date to remember is tomorrow' }))).toBe('dropped');
    expect(await t.s.nudges.propose(cand(u, { kind: 'watcher_hit', refId: 'w1', countsAgainstBudget: false }))).toBe('sent');
    // the next day the cap is over
    await t.clock.set(t.clock.now() + DAY);
    expect(await t.s.nudges.propose(cand(u, { kind: 'date_from_memory', refId: 'm2', why: 'Tomorrow: Anna\'s birthday', body: 'A date to remember is tomorrow' }))).toBe('sent');
    await t.settle();
    // no "Why now:" label; the details stay
    const md = t.tg.calls.filter((c) => c.method === 'sendRichMessage').map((c) => String(c.payload.rich_message?.markdown ?? ''));
    expect(md.some((m) => m.includes('Why now'))).toBe(false);
    expect(md.some((m) => m.replace(/\\/g, '').includes('You told Anna you would send the deck by 15:00.'))).toBe(true);
  });

  it('proactive off (or blocked) also silences the unrequested nudge kinds', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    await t.clock.set(localAt(t, TZ, 0, 10));
    t.s.repos.users.update(u.id, { proactiveLevel: 'off' });
    expect(await t.s.nudges.propose(cand(u, { kind: 'date_from_memory', refId: 'm1' }))).toBe('dropped');
    expect(await t.s.nudges.propose(cand(u))).toBe('sent'); // a commitment the owner made is not a "write first"
  });

  it('the scheduled brief counts toward the cap (08:00 → nothing Gora-first until 08:00 the next day)', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tgUserId: 1001, tz: TZ });
    t.s.brief.setDaily(u.id, '08:00');
    t.llm.push(say('Good morning! Quiet day ahead.'));
    const eight = localAt(t, TZ, 0, 8); // the clock starts at 05:00 local
    await advanceTicks(t, eight + 20 * 60_000 - t.clock.now());
    expect(goraSent(t, u)).toEqual(['brief']);
    expect(t.s.proactivePolicy.canSendNow(u.id, eight + 23 * HOUR)).toBe(false);
    expect(t.s.proactivePolicy.canSendNow(u.id, eight + DAY + 60_000)).toBe(true);
  });
});
