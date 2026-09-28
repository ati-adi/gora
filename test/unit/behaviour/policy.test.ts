// Friend set B — SignalsService (C1–C3) and the ProactivePolicy (C4) on the real app with fakes around it: features
// only in user_signals, rewards and penalties on the arms, blocked / unblocked, the shared 24 h cap (brief at 08:00),
// eligibility, τ scaling by level, the hard stop, content availability (first_hint, follow_up, sensitive filter, memory
// off), seeded determinism of decide(), the style context line, /why explain, export and retention.
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileCard, UserRow } from '../../../src/contracts/index.ts';
import { seededRandom } from '../../../src/kernel/random.ts';
import { createFakeGovernance, createFakeProfileService } from '../../harness/fakes.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { addUser, advanceTicks, createFriendApp, DAY, HOUR, localAt, proactiveSends, scriptSends, seedHistory, type FriendApp } from '../../harness/friend-B.ts';
import { createSignals } from '../../../src/behaviour/signals.ts';
import { createPolicy } from '../../../src/behaviour/policy.ts';
import { createBehaviourRepo } from '../../../src/behaviour/repo.ts';
import { createProactiveRepo } from '../../../src/proactive/repo.ts';
import { buildContextText } from '../../../src/agent/context.ts';

let t: TestApp | FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';
const q = <T>(t: TestApp, sql: string, ...p: Array<string | number>) => t.s.db.prepare(sql).all<T>(...p);
/** A private policy instance over the app's services (evaluate() without the daily slot). */
const internals = (t: TestApp) => {
  const repo = createBehaviourRepo(() => t.s.db, () => t.s.crypto);
  const sig = createSignals(t.s, repo);
  return { repo, sig, pol: createPolicy(t.s, repo, sig, createProactiveRepo(() => t.s.db, () => t.s.crypto)) };
};
/** Seeds one sent proactive message the way the send job records it. */
function seedSent(t: TestApp, u: UserRow, at: number, id = `pl_${at}`) {
  const { repo } = internals(t);
  repo.insertLog({ id, userId: u.id, arm: 'checkin|1-2d', contentType: 'checkin', gapBucket: '1-2d', score: 0.4, sent: true, reason: 'ok', text: 'Hey, how are you?', now: at });
  t.s.signals.goraSent(u.id, { at, source: 'proactive', arm: 'checkin|1-2d', refId: id });
  return id;
}
const arm = (t: TestApp, u: UserRow, a: string) => q<{ alpha: number; beta: number }>(t, `SELECT alpha, beta FROM proactive_arms WHERE user_id = ? AND arm = ?`, u.id, a)[0];

describe('SignalsService (C1–C3)', () => {
  it('stores features only, never text; learns rhythm and style; lastInboundAt', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    expect(t.s.signals.lastInboundAt(u.id)).toBeNull();
    const at = t.clock.now();
    for (let i = 0; i < 5; i++) t.s.signals.inbound(u.id, { at: at + i * 1000, text: 'Слушай, какая погода завтра в Алматы? 🙂' });
    const rows = q<Record<string, unknown>>(t, `SELECT * FROM user_signals WHERE user_id = ?`, u.id);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ kind: 'inbound', length: 39, emoji: 1, lang: 'ru', question: 1, register: 'informal', local_hour: 5 });
    const dump = JSON.stringify(q(t, `SELECT * FROM user_signals`)) + JSON.stringify(q(t, `SELECT style_json FROM user_rhythm`));
    expect(dump).not.toMatch(/погода|Алматы|Слушай/);
    expect(t.s.signals.lastInboundAt(u.id)).toBe(at + 4000);
    expect(t.s.signals.styleHints(u.id)).toEqual({ replyLength: 'short', emoji: 'light', register: 'informal', languages: ['ru'] });
    expect(t.s.signals.pActive(u.id, at)).toBeGreaterThan(t.s.signals.pActive(u.id, at + 12 * HOUR));
  });

  it('incognito: timing is kept (no pings at the wrong hour) but no style features', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    t.s.repos.users.update(u.id, { incognitoUntil: t.clock.now() + HOUR });
    t.s.signals.inbound(u.id, { at: t.clock.now(), text: 'secret plans 😀' });
    expect(q(t, `SELECT length, emoji, lang FROM user_signals WHERE user_id = ?`, u.id)).toEqual([{ length: null, emoji: null, lang: null }]);
    expect(t.s.signals.lastInboundAt(u.id)).toBe(t.clock.now());
  });

  it('reply ≤ 24 h → reward 1 (α += 1 on both arms, a reply signal with latency); later → no reward', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const id = seedSent(t, u, t.clock.now());
    t.s.signals.inbound(u.id, { at: t.clock.now() + 2 * HOUR, text: 'хорошо!' });
    expect(q(t, `SELECT reward, replied_at FROM proactive_log WHERE id = ?`, id)).toEqual([{ reward: 1, replied_at: t.clock.now() + 2 * HOUR }]);
    expect(arm(t, u, 'type:checkin')).toEqual({ alpha: 1, beta: 0 });
    expect(arm(t, u, 'gap:1-2d')).toEqual({ alpha: 1, beta: 0 });
    expect(q(t, `SELECT latency_ms FROM user_signals WHERE kind = 'reply'`)).toEqual([{ latency_ms: 2 * HOUR }]);
    // a second message does not reward twice; a message after the window rewards nothing
    t.s.signals.inbound(u.id, { at: t.clock.now() + 3 * HOUR, text: 'ещё' });
    const id2 = seedSent(t, u, t.clock.now() + 4 * HOUR);
    t.s.signals.inbound(u.id, { at: t.clock.now() + 4 * HOUR + 25 * HOUR, text: 'late' });
    expect(q(t, `SELECT reward FROM proactive_log WHERE id = ?`, id2)).toEqual([{ reward: null }]);
    expect(arm(t, u, 'type:checkin')).toEqual({ alpha: 1, beta: 0 });
  });

  it('a 👍 on the proactive message is an answer; 👎 is a miss', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const id = seedSent(t, u, t.clock.now());
    internals(t).repo.setLogMessage(id, u.tgUserId, 555, t.clock.now());
    t.s.signals.reaction(u.id, { at: t.clock.now() + HOUR, emoji: '👎', tgMessageId: 555 });
    expect(q(t, `SELECT reward FROM proactive_log WHERE id = ?`, id)).toEqual([{ reward: 0 }]);
    expect(arm(t, u, 'type:checkin')).toEqual({ alpha: 0, beta: 1 });
    const id2 = seedSent(t, u, t.clock.now() + 2 * HOUR);
    internals(t).repo.setLogMessage(id2, u.tgUserId, 556, t.clock.now());
    t.s.signals.reaction(u.id, { at: t.clock.now() + 3 * HOUR, emoji: '❤', tgMessageId: 556 });
    expect(q(t, `SELECT reward FROM proactive_log WHERE id = ?`, id2)).toEqual([{ reward: 1 }]);
  });

  it('"stop": proactive off, β += 5 on the last message\'s arms, and a reply that said stop is no reward', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const id = seedSent(t, u, t.clock.now());
    t.s.signals.inbound(u.id, { at: t.clock.now() + HOUR, text: 'не пиши мне первым' }); // reply (reward 1) ...
    t.s.signals.feedback(u.id, { at: t.clock.now() + HOUR, kind: 'stop' }); // ... that was "stop" (settings_update)
    expect(t.s.repos.users.getById(u.id)!.proactiveLevel).toBe('off');
    expect(q(t, `SELECT reward FROM proactive_log WHERE id = ?`, id)).toEqual([{ reward: 0 }]);
    expect(arm(t, u, 'type:checkin')).toEqual({ alpha: 0, beta: 5 });
    expect(arm(t, u, 'gap:1-2d')).toEqual({ alpha: 0, beta: 5 });
    expect(q(t, `SELECT value FROM user_signals WHERE kind = 'feedback'`)).toEqual([{ value: 'stop' }]);
    t.s.signals.feedback(u.id, { at: t.clock.now() + 2 * HOUR, kind: 'less' });
    expect(t.s.repos.users.getById(u.id)!.proactiveLevel).toBe('off'); // 'less' is P's settings_update write, not ours
  });

  it('blocked (403) → status blocked; the owner writes again → active', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    t.s.signals.blocked(u.id, t.clock.now());
    expect(t.s.repos.users.getById(u.id)).toMatchObject({ status: 'blocked', botBlocked: true });
    expect(t.s.proactivePolicy.canSendNow(u.id, t.clock.now())).toBe(false);
    t.s.signals.inbound(u.id, { at: t.clock.now() + HOUR, text: 'hi' });
    expect(t.s.repos.users.getById(u.id)).toMatchObject({ status: 'active', botBlocked: false });
    expect(q(t, `SELECT kind FROM user_signals WHERE kind IN ('blocked','unblocked') ORDER BY id`)).toEqual([{ kind: 'blocked' }, { kind: 'unblocked' }]);
    // a paused owner stays paused when they write
    t.s.repos.users.update(u.id, { status: 'paused' });
    t.s.signals.inbound(u.id, { at: t.clock.now() + 2 * HOUR, text: 'hi' });
    expect(t.s.repos.users.getById(u.id)!.status).toBe('paused');
  });

  it('never throws to its caller (unknown user, deleted DB state)', async () => {
    t = await createFriendApp();
    expect(() => t!.s.signals.inbound('nobody', { at: 1, text: 'x' })).not.toThrow();
    expect(() => t!.s.signals.feedback('nobody', { at: 1, kind: 'stop' })).not.toThrow();
    expect(t.s.signals.pActive('nobody', 1)).toBe(0);
    expect(t.s.signals.styleHints('nobody')).toBeNull();
  });
});

describe('ProactivePolicy (C4)', () => {
  it('cap sharing: a brief sent at 08:00 → nothing Gora-first until 08:00 the next day', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const eight = localAt(t, TZ, 1, 8);
    t.s.signals.goraSent(u.id, { at: eight, source: 'brief' });
    expect(t.s.proactivePolicy.canSendNow(u.id, eight + 23 * HOUR + 59 * 60_000)).toBe(false);
    expect(t.s.proactivePolicy.canSendNow(u.id, eight + DAY)).toBe(true);
    const { pol } = internals(t);
    const user = t.s.repos.users.getById(u.id)!;
    expect(pol.evaluate(user, localAt(t, TZ, 1, 20)).reason).toBe('cap_24h');
    // a reminder the owner asked for does not count
    t.s.signals.goraSent(u.id, { at: eight + 2 * DAY, source: 'reminder' });
    expect(t.s.proactivePolicy.canSendNow(u.id, eight + 2 * DAY + HOUR)).toBe(true);
  });

  it('eligibility: paused, blocked, off, quiet hours, budget; then the hard stop after 4 unanswered', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    const { pol } = internals(t);
    const at20 = localAt(t, TZ, 0, 20, 10);
    const ev = (patch: Partial<UserRow> = {}, at = at20) => pol.evaluate({ ...t!.s.repos.users.getById(u.id)!, ...patch }, at).reason;
    expect(ev()).toMatch(/^(above_tau|below_tau)$/);
    expect(ev({ status: 'paused' })).toBe('not_eligible:paused');
    expect(ev({ botBlocked: true })).toBe('not_eligible:blocked');
    expect(ev({ dmChatId: null })).toBe('not_eligible:no_dm'); // known only from a group / guest query
    expect(ev({ proactiveLevel: 'off' })).toBe('not_eligible:off');
    expect(ev({}, localAt(t, TZ, 0, 23))).toBe('not_eligible:quiet');
    expect(ev({}, localAt(t, TZ, 0, 12))).toBe('off_peak');
    (t as FriendApp).budget.blocked.add('proactive');
    expect(ev()).toBe('not_eligible:budget');
    (t as FriendApp).budget.blocked.delete('proactive');
    for (let i = 0; i < 4; i++) t.s.signals.goraSent(u.id, { at: at20 - (4 - i) * HOUR, source: i % 2 ? 'nudge' : 'proactive' });
    expect(ev()).toBe('hard_stop');
    t.s.signals.inbound(u.id, { at: at20 - HOUR, text: 'hey' }); // the owner wrote: the streak is over
    expect(ev()).not.toBe('hard_stop');
  });

  it('τ scales with the level: "more" sends where "less" does not (same draws)', async () => {
    const decide = async (level: UserRow['proactiveLevel']) => {
      const app = await createFriendApp();
      const u = addUser(app, { tz: TZ });
      seedHistory(app, u, { days: 14, hour: 20 });
      const pol = internals(app).pol;
      const out = [];
      // three quiet days after the last message: gap bucket 3-5d
      for (let i = 0; i < 60; i++) out.push(pol.evaluate({ ...app.s.repos.users.getById(u.id)!, proactiveLevel: level }, localAt(app, TZ, 3, 20, 10)));
      await app.close();
      return out;
    };
    const more = await decide('more');
    const less = await decide('less');
    expect(more.map((d) => d.score)).toEqual(less.map((d) => d.score)); // same seeded draws
    const sent = (ds: typeof more) => ds.filter((d) => d.send).length;
    expect(sent(more)).toBeGreaterThan(sent(less));
    for (const d of more) expect(d.send).toBe((d.score ?? 0) > 0.3 * 0.7);
    for (const d of less) expect(d.send).toBe((d.score ?? 0) > 0.3 * 1.5);
  });

  it('seeded RNG: the same seed gives the same decide() results', async () => {
    const run = async () => {
      const app = await createTestApp({ now: Date.UTC(2026, 9, 5), random: seededRandom(1), factories: { createLlmGovernance: () => createFakeGovernance() } });
      const u = addUser(app, { tz: TZ });
      seedHistory(app, u, { days: 14, hour: 20 });
      const out = [];
      for (let h = 0; h < 24 * 6; h++) {
        const { userId: _, ...d } = app.s.proactivePolicy.decide(u.id, localAt(app, TZ, Math.floor(h / 24), h % 24, 5));
        out.push(d);
      }
      await app.close();
      return out;
    };
    const a = await run();
    expect(await run()).toEqual(a);
    expect(a.some((d) => d.reason === 'not_slot')).toBe(true);
    expect(a.some((d) => d.reason === 'above_tau' || d.reason === 'below_tau')).toBe(true);
    expect(a.every((d) => d.reason !== 'above_tau' || d.contentType === 'checkin')).toBe(true);
  });

  it('content: first_hint only for owners who never wrote (at most 2 of them); memory off → checkin only', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const { pol, repo } = internals(t);
    const at = localAt(t, TZ, 0, 19, 10);
    const types = (patch: Partial<UserRow> = {}) => {
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const d = pol.evaluate({ ...t!.s.repos.users.getById(u.id)!, ...patch }, at);
        if (d.contentType) seen.add(d.contentType);
      }
      return [...seen].sort();
    };
    expect(types()).toEqual(['first_hint']);
    for (let i = 0; i < 2; i++) repo.insertLog({ id: `pl_h${i}`, userId: u.id, arm: 'first_hint|<1d', contentType: 'first_hint', gapBucket: '<1d', score: 1, sent: true, reason: 'ok', text: 'x', now: at - (10 + i) * DAY });
    expect(pol.evaluate(t.s.repos.users.getById(u.id)!, at).reason).toBe('no_content');
    t.s.signals.inbound(u.id, { at: at - 3 * DAY, text: 'hi' });
    expect(types()).toEqual(['checkin']);
    expect(types({ memoryConsent: false })).toEqual(['checkin']);
  });

  it('content: follow_up from due profile threads (never sensitive, never twice); useful for an upcoming plan', async () => {
    const profile = createFakeProfileService(() => Date.UTC(2026, 9, 5));
    t = await createTestApp({ now: Date.UTC(2026, 9, 5), factories: { createProfileService: () => profile, createLlmGovernance: () => createFakeGovernance() } });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 19 });
    const card = (threads: ProfileCard['open_threads']) => profile.put(u.id, { summary: 'Aigerim, product manager in Almaty', open_threads: threads });
    const { pol } = internals(t);
    const at = localAt(t, TZ, 0, 19, 10);
    const types = () => {
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) {
        const d = pol.evaluate(t!.s.repos.users.getById(u.id)!, at);
        if (d.contentType) seen.add(d.contentType);
      }
      return [...seen].sort();
    };
    card([{ what: 'job interview at Kaspi', when_local: '2026-10-02', follow_up_after_local: '2026-10-03' }]);
    expect(types()).toContain('follow_up');
    card([{ what: 'appointment with the doctor about the diagnosis', when_local: '2026-10-02', follow_up_after_local: '2026-10-03' }]);
    expect(types()).not.toContain('follow_up');
    card([{ what: 'job interview at Kaspi', when_local: '2026-10-02', follow_up_after_local: '2026-09-01' }]); // stale
    expect(types()).not.toContain('follow_up');
    card([{ what: 'flight to Istanbul', when_local: '2026-10-06T09:00', follow_up_after_local: null }]);
    expect(types()).toContain('useful');
    // an item already used in a Gora-first message is not used again
    card([{ what: 'job interview at Kaspi', when_local: '2026-10-02', follow_up_after_local: '2026-10-03' }]);
    const fp = t.s.crypto.hmac('content', `beh-item:${u.id}:job interview at kaspi (2026-10-02)`).slice(0, 16);
    internals(t).repo.addSignal(u.id, { kind: 'gora_sent', at: at - DAY - 5 * HOUR, source: 'proactive', value: fp });
    expect(types()).not.toContain('follow_up');
  });

  it('the send job composes (main) and judges (fast) with the item, then sends plain text into the DM; /why explains', async () => {
    const profile = createFakeProfileService(() => Date.UTC(2026, 9, 5));
    const gov = createFakeGovernance();
    t = await createTestApp({ now: Date.UTC(2026, 9, 5), config: { proactive: { tau: 0.001 } }, factories: { createProfileService: () => profile, createLlmGovernance: () => gov } });
    await t.app.tg.dispatcher.stop();
    await t.s.scheduler.stop();
    await t.s.telegram.outbox.stop();
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    profile.put(u.id, { summary: 'Aigerim, PM in Almaty', open_threads: [{ what: 'job interview at Kaspi', when_local: '2026-10-02', follow_up_after_local: '2026-10-03' }] });
    scriptSends(t, 3, { text: 'Ну что, как прошло собеседование в Kaspi?' });
    let guard = 0;
    while (proactiveSends(t, u).length === 0 && guard++ < 48) await advanceTicks(t, HOUR);
    const [m] = proactiveSends(t, u);
    expect(m?.text).toBe('Ну что, как прошло собеседование в Kaspi?');
    const [compose, judge] = t.llm.parseRequests.filter((r) => r.purpose === 'compose' || r.purpose === 'judge');
    expect(compose).toMatchObject({ purpose: 'compose', role: 'main' });
    expect(judge!.role ?? 'fast').toBe('fast');
    expect(compose!.user).toContain('job interview at Kaspi');
    expect(compose!.user).toContain('about_owner: Aigerim, PM in Almaty');
    expect(compose!.user).toContain('<data>');
    expect(judge!.user).toContain('<draft>\nНу что, как прошло собеседование в Kaspi?\n</draft>');
    const [row] = q<{ id: string; content_type: string }>(t, `SELECT id, content_type FROM proactive_log`);
    expect(row!.content_type).toBe('follow_up');
    expect(t.s.proactivePolicy.explain(row!.id)).toMatchObject({ contentType: 'follow_up', reason: 'natural and light' });
    expect(t.s.telegram.links.lookup(u.tgUserId, m!.messageId)).toMatchObject({ kind: 'nudge', nudgeId: row!.id, userId: u.id });
  });

  it('style context line: learned hints, explicit settings.style wins; private surfaces only', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tgUserId: 1001, tz: TZ });
    for (let i = 0; i < 6; i++) t.s.signals.inbound(u.id, { at: t.clock.now() + i, text: 'короче скажи погоду 🙂🙂🙂' });
    t.s.repos.users.updateSettings(u.id, { style: { length: 'medium' } });
    const conv = t.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: u.tgUserId });
    const run = { id: 'r1', userId: u.id } as never;
    const text = await buildContextText(t.s, conv, run, { events: [], replyToCard: null, previousStopped: false, query: 'hi' });
    expect(text).toContain('<user_model>');
    expect(text).toContain('style: reply_length=medium emoji=lots register=informal lang=ru set_by_owner=length');
  });

  it('privacy: export has the arms and messages; retention drops signals and settled logs after 90 days', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    seedSent(t, u, t.clock.now());
    t.s.signals.inbound(u.id, { at: t.clock.now() + HOUR, text: 'ok' });
    const hook = t.s.privacyHooks.find((h) => h.name === 'behaviour')!;
    const ex = (await hook.exportUser!(u.id, u.tgUserId)) as { proactiveMessages: Array<{ text: string; reward: number }>; proactiveArms: unknown[]; signals: Record<string, number> };
    expect(ex.proactiveMessages).toEqual([expect.objectContaining({ text: 'Hey, how are you?', reward: 1 })]);
    expect(ex.proactiveArms).toHaveLength(2);
    expect(ex.signals).toMatchObject({ inbound: 1, gora_sent: 1, reply: 1 });
    await hook.retentionSweep!(t.clock.now() + 91 * DAY);
    expect(q(t, `SELECT COUNT(*) AS n FROM user_signals`)).toEqual([{ n: 0 }]);
    expect(q(t, `SELECT COUNT(*) AS n FROM proactive_log`)).toEqual([{ n: 0 }]);
    expect(q(t, `SELECT COUNT(*) AS n FROM proactive_arms`)).toEqual([{ n: 2 }]); // aggregates stay (deleted with the user)
  });
});
