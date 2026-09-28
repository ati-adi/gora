// Friend set B — spec 05 §E re-engagement e2e on the full stack with a FakeClock: the learned proactive policy writes
// first at most once per 24 h and only at the owner's learned hours; a reply resets the unanswered streak and rewards the
// arm; four ignored messages mean silence; "don't write first" means none; a 403 blocks until the owner writes again;
// the friend check can veto; the budget gate pauses it. Compose / judge are scripted parses; no real LLM.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/contracts/index.ts';
import { say } from '../harness/scriptedTransport.ts';
import { addUser, advanceTicks, createFriendApp, DAY, localHour, proactiveSends, scriptSends, seedHistory, type FriendApp } from '../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';
const owner = (t: FriendApp, u: UserRow) => ({ id: u.tgUserId, first_name: 'Aigerim', language_code: 'en' });
const logRows = (t: FriendApp, userId: string) =>
  t.s.db.prepare(`SELECT id, sent, reward, content_type AS type FROM proactive_log WHERE user_id = ? ORDER BY created_at`).all<{ id: string; sent: number; reward: number | null; type: string }>(userId);
const arm = (t: FriendApp, userId: string, a: string) => t.s.db.prepare(`SELECT alpha, beta FROM proactive_arms WHERE user_id = ? AND arm = ?`).get<{ alpha: number; beta: number }>(userId, a);
const composeCalls = (t: FriendApp) => t.llm.parseRequests.filter((r) => r.purpose === 'compose' || r.purpose === 'judge');

describe('friend proactive policy (e2e)', () => {
  it('an inactive owner gets ≤ 1 message per 24 h, only at learned hours; 4 ignored → silence for the next 7 days', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 }); // the owner chats around 20:00 local, then goes quiet
    scriptSends(t, 12);
    await advanceTicks(t, 9 * DAY);
    const sends = proactiveSends(t, u);
    expect(sends.length).toBe(4); // the safety cap: 4 unanswered in a row, then silence until the owner writes
    for (const m of sends) expect(localHour(m.at, TZ)).toBeGreaterThanOrEqual(19);
    for (const m of sends) expect(localHour(m.at, TZ)).toBeLessThanOrEqual(21);
    for (let i = 1; i < sends.length; i++) expect(sends[i]!.at - sends[i - 1]!.at).toBeGreaterThanOrEqual(DAY);
    // no "Why now" line and no buttons on a message a friend would write
    const raw = t.tg.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === u.tgUserId);
    for (const c of raw) expect(c.payload.reply_markup).toBeUndefined();
    // 4 ignored: rewards 0 once the 24 h windows closed, and nothing more for a week
    await advanceTicks(t, 7 * DAY);
    expect(proactiveSends(t, u).length).toBe(4);
    const rows = logRows(t, u.id);
    expect(rows.filter((r) => r.sent === 1).map((r) => r.reward)).toEqual([0, 0, 0, 0]);
    expect(arm(t, u.id, 'type:checkin')).toEqual({ alpha: 0, beta: 4 });
    // the ledger has the arm and score, never the text
    const led = t.s.ledger.list(u.id, { kinds: ['proactive_sent'], limit: 10 });
    expect(led).toHaveLength(4);
    expect(JSON.stringify(led)).not.toContain('How did your week go');
    expect(t.s.proactivePolicy.explain(rows[0]!.id)).toMatchObject({ contentType: 'checkin', reason: 'natural and light' });
  }, 120_000);

  it('a reply resets the unanswered streak, gives reward 1, and the model sees the message as its own', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tgUserId: 1001, tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    scriptSends(t, 6);
    let guard = 0;
    while (proactiveSends(t, u).length === 0 && guard++ < 4 * 48) await advanceTicks(t, 30 * 60_000);
    expect(proactiveSends(t, u)).toHaveLength(1);
    const before = t.llm.requests.length;
    t.llm.push(say('Glad to hear it!'));
    await t.userSends('all good, thanks! busy week', { user: owner(t, u) });
    const [row] = logRows(t, u.id);
    expect(row).toMatchObject({ sent: 1, reward: 1 });
    expect(arm(t, u.id, 'type:checkin')).toEqual({ alpha: 1, beta: 0 });
    expect(t.s.db.prepare(`SELECT COUNT(*) AS n FROM user_signals WHERE user_id = ? AND kind = 'reply'`).get<{ n: number }>(u.id)!.n).toBe(1);
    // the proactive message reached the next run as an event ("you messaged the owner first")
    const req = JSON.stringify(t.llm.requests.slice(before));
    expect(req).toContain('You messaged the owner first');
    // the streak restarted: the next decision is not a hard stop and nothing is capped once 24 h passed
    await advanceTicks(t, DAY + 60 * 60_000);
    expect(t.s.proactivePolicy.decide(u.id, t.clock.now()).reason).not.toBe('hard_stop');
  }, 120_000);

  it('"don\'t write to me first" → proactive off → nothing, ever', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    scriptSends(t, 6);
    // what settings_update {proactive:'off'} does (set P): the level, and the 'stop' feedback signal
    t.s.repos.users.update(u.id, { proactiveLevel: 'off' });
    t.s.signals.feedback(u.id, { at: t.clock.now(), kind: 'stop' });
    await advanceTicks(t, 7 * DAY);
    expect(proactiveSends(t, u)).toHaveLength(0);
    expect(composeCalls(t)).toHaveLength(0);
    expect(t.s.proactivePolicy.canSendNow(u.id, t.clock.now())).toBe(false);
  }, 120_000);

  it('a 403 blocks: status blocked, no sends; the owner writes again → active', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tgUserId: 1001, tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    scriptSends(t, 6);
    t.tg.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 5);
    let guard = 0;
    while (t.s.repos.users.getById(u.id)!.status !== 'blocked' && guard++ < 4 * 48) await advanceTicks(t, 30 * 60_000);
    expect(t.s.repos.users.getById(u.id)).toMatchObject({ status: 'blocked', botBlocked: true });
    const composed = composeCalls(t).length;
    await advanceTicks(t, 4 * DAY);
    expect(composeCalls(t).length).toBe(composed); // blocked users are never considered
    expect(proactiveSends(t, u)).toHaveLength(0);
    t.tg.reset();
    t.llm.push(say('Welcome back!'));
    await t.userSends('hi again', { user: owner(t, u) });
    expect(t.s.repos.users.getById(u.id)).toMatchObject({ status: 'active', botBlocked: false });
  }, 120_000);

  it('the friend check can veto: nothing is sent, the row is logged with sent=0 and the arms are unchanged', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    scriptSends(t, 1, { send: false, reason: 'needy' });
    let guard = 0;
    while (logRows(t, u.id).length === 0 && guard++ < 3 * 48) await advanceTicks(t, 30 * 60_000);
    expect(logRows(t, u.id)).toEqual([expect.objectContaining({ sent: 0, reward: null })]);
    expect(proactiveSends(t, u)).toHaveLength(0);
    expect(t.s.db.prepare(`SELECT COUNT(*) AS n FROM proactive_arms WHERE user_id = ?`).get<{ n: number }>(u.id)!.n).toBe(0);
    expect(t.s.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE ref_kind = 'proactive'`).get<{ n: number }>()!.n).toBe(0);
    expect(t.s.proactivePolicy.explain(logRows(t, u.id)[0]!.id)).toMatchObject({ reason: 'needy', sentAt: null });
  }, 120_000);

  it('the budget gate (≥ 85%) pauses it: no compose / judge and no send; allowed again → it resumes', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    scriptSends(t, 3);
    t.budget.blocked.add('proactive');
    await advanceTicks(t, 3 * DAY);
    expect(composeCalls(t)).toHaveLength(0);
    expect(proactiveSends(t, u)).toHaveLength(0);
    t.budget.blocked.delete('proactive');
    await advanceTicks(t, 2 * DAY);
    expect(proactiveSends(t, u).length).toBeGreaterThanOrEqual(1);
    expect(composeCalls(t).map((r) => r.purpose).slice(0, 2)).toEqual(['compose', 'judge']);
    expect(composeCalls(t).map((r) => r.role ?? 'fast').slice(0, 2)).toEqual(['main', 'fast']);
  }, 120_000);
});
