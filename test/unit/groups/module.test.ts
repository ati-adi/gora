// GR (spec 07 C3/C4/C8) — the group module over a real app (privacy mode OFF): sealed storage, the 14-day retention,
// /forget and bot-left purges, the Thompson bandit's updates (reaction reward, ignored penalty, "тише" strong penalty,
// chattiness steps) and reproducible draws with a seeded Random.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GroupObservedMessage } from '../../../src/contracts/index.ts';
import type { GroupCtx } from '../../../src/groups/ctx.ts';
import { inferTz } from '../../../src/groups/ctx.ts';
import { createFeedback, drawThetas } from '../../../src/groups/feedback.ts';
import { createGroupRepo, emptyArms } from '../../../src/groups/repo.ts';
import { seededRandom } from '../../../src/kernel/random.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { grRows } from '../../harness/s07-gr.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_GROUP_ID, U } from '../../harness/updates.ts';

const DAY = 86_400_000;
const MIN = 60_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

let mid = 7_000;
const msg = (t: TestApp, text: string, o: Partial<GroupObservedMessage> = {}): GroupObservedMessage => ({
  chatId: TEST_GROUP_ID, threadId: null, tgMessageId: ++mid, fromTgId: 2001, fromName: 'Anna', text, kind: 'text', at: t.clock.now(),
  replyToTgMessageId: null, replyToBot: false, addressed: null, ...o,
});

function ctxOf(t: TestApp): GroupCtx {
  const g: GroupCtx = {
    s: t.s, repo: () => createGroupRepo(t.s.db, t.s.crypto, t.s.clock), log: () => t.s.log, L: () => t.s.config.limits, readsAll: () => true,
    tzOf: (chatId) => inferTz(g, chatId), langOf: () => 'ru',
  };
  return g;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('group repo (C3)', () => {
  it('stores text sealed: no plaintext anywhere in the data dir; 14-day retention', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const CANARY = 'CANARY-GROUP-LINE-7Q';
    await t.s.groupAgent.observe(msg(t, `встречаемся в пятницу ${CANARY}`));
    expect(grRows.messages(t.s)).toBe(1);
    await t.settle();
    for (const f of filesUnder(t.config.dataDir)) expect(readFileSync(f).includes(Buffer.from(CANARY)), f).toBe(false);
    const repo = createGroupRepo(t.s.db, t.s.crypto, t.s.clock);
    expect(repo.recent(TEST_GROUP_ID, { limit: 5 })[0]!.text).toContain(CANARY);
    // re-delivery is a no-op
    const again = repo.recent(TEST_GROUP_ID, { limit: 5 })[0]!;
    await t.s.groupAgent.observe(msg(t, 'x', { tgMessageId: again.tgMessageId }));
    expect(grRows.messages(t.s)).toBe(1);
    // 14 days later the rolling retention removes it
    await t.s.privacy.retentionSweep(t.clock.now() + 13 * DAY);
    expect(grRows.messages(t.s)).toBe(1);
    await t.s.privacy.retentionSweep(t.clock.now() + 15 * DAY);
    expect(grRows.messages(t.s)).toBe(0);
  });

  it("purge('forget') keeps chattiness and resets the counters; purge('left') removes every row", async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const ga = t.s.groupAgent;
    await ga.observe(msg(t, 'привет всем'));
    ga.setChattiness(TEST_GROUP_ID, 'less', { reason: 'settings' });
    const repo = createGroupRepo(t.s.db, t.s.crypto, t.s.clock);
    repo.updatePolicy(TEST_GROUP_ID, { lastChimeAt: t.clock.now(), chimesDay: '2026-09-28', chimesToday: 3 });
    repo.setSummary(TEST_GROUP_ID, { summary: 'plans for Friday', coveredUntilAt: t.clock.now(), covered: 1 });
    const chimedAt = t.clock.now();
    await ga.purge(TEST_GROUP_ID, 'forget');
    expect(grRows.messages(t.s)).toBe(0);
    expect(grRows.summaries(t.s)).toBe(0);
    // s07 lead fix (red team "caps reset"): the rate-limit counters are not member content and survive /forget всё
    expect(ga.policy(TEST_GROUP_ID)).toMatchObject({ chattiness: 'less', chimesToday: 3, lastChimeAt: chimedAt });
    await ga.observe(msg(t, 'снова привет'));
    await ga.purge(TEST_GROUP_ID, 'left');
    expect(grRows.messages(t.s)).toBe(0);
    expect(grRows.policy(t.s)).toBeUndefined();
  });

  it('bot left + the 7-day grace (the surfaces sweep destroys grp:<chatId>) → the next sweep purges everything', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    await t.send(U.myChatMember('member', { title: 'Друзья' }));
    await t.s.groupAgent.observe(msg(t, 'где встречаемся?'));
    expect(grRows.messages(t.s)).toBe(1);
    await t.send(U.myChatMember('left', { title: 'Друзья' }));
    await t.s.privacy.retentionSweep(t.clock.now() + 8 * 86_400_000);
    expect(grRows.messages(t.s)).toBe(0);
    expect(grRows.policy(t.s)).toBeUndefined();
  });

  it('rows sealed under a destroyed generation are purged as orphans; a live generation stays', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    await t.s.groupAgent.observe(msg(t, 'старая строка'));
    t.s.crypto.destroyOwner(`grp:${TEST_GROUP_ID}`);
    await t.s.groupAgent.observe(msg(t, 'новая строка'));
    expect(grRows.messages(t.s)).toBe(2);
    await t.s.privacy.retentionSweep(t.clock.now());
    expect(grRows.messages(t.s)).toBe(1);
    expect(t.s.groupAgent.recentContext(TEST_GROUP_ID, {})).toContain('новая строка');
  });

  it('/export lists the member\'s own group lines as a count only; /deletemydata removes them', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    await t.userSends('hi');
    const u = t.s.repos.users.getByTg(1001)!;
    await t.s.groupAgent.observe(msg(t, 'my own line SECRET-OWN-1', { fromTgId: 1001 }));
    await t.s.groupAgent.observe(msg(t, 'someone else'));
    const hook = t.s.privacyHooks.find((h) => h.name === 'groups')!;
    const exp = await hook.exportUser!(u.id, 1001);
    expect(exp).toEqual({ groupMessages: [{ chatId: TEST_GROUP_ID, messages: 1 }] });
    expect(JSON.stringify(exp)).not.toContain('SECRET-OWN-1');
  });
});

describe('bandit (C4 learning)', () => {
  it('reward on a positive reaction, penalty on ignore, strong penalty on "тише"; chattiness steps', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const g = ctxOf(t);
    const fb = createFeedback(g);
    const ga = t.s.groupAgent;
    g.repo().ensurePolicy(TEST_GROUP_ID);
    const arm = (k: 'answer' | 'plan_help') => ga.policy(TEST_GROUP_ID).arms[k];
    expect(arm('answer')).toEqual({ alpha: 1, beta: 3 }); // the conservative prior Beta(1,3)

    fb.openWindow(TEST_GROUP_ID, 900, 'answer', t.clock.now());
    ga.onReaction({ chatId: TEST_GROUP_ID, tgMessageId: 900, fromTgId: 2001, emoji: ['👍'], at: t.clock.now() });
    expect(arm('answer')).toEqual({ alpha: 2, beta: 3 });
    // the window is closed: a second reaction changes nothing
    ga.onReaction({ chatId: TEST_GROUP_ID, tgMessageId: 900, fromTgId: 2002, emoji: ['🔥'], at: t.clock.now() });
    expect(arm('answer')).toEqual({ alpha: 2, beta: 3 });

    // ignored for 10 min → β+1 (the group_feedback job)
    fb.openWindow(TEST_GROUP_ID, 901, 'plan_help', t.clock.now());
    await t.advance(10 * MIN + 1_000);
    expect(arm('plan_help')).toEqual({ alpha: 1, beta: 4 });

    // a reply engaging Gora within the window → reward
    fb.openWindow(TEST_GROUP_ID, 902, 'plan_help', t.clock.now());
    await ga.observe(msg(t, 'о, спасибо!', { replyToBot: true, replyToTgMessageId: 902, addressed: 'reply' }));
    expect(arm('plan_help')).toEqual({ alpha: 2, beta: 4 });

    // "тише" right after a chime-in → β += 3 for it, one step quieter
    fb.openWindow(TEST_GROUP_ID, 903, 'answer', t.clock.now());
    expect(ga.setChattiness(TEST_GROUP_ID, 'less', { reason: 'words' })).toBe('less');
    expect(arm('answer')).toEqual({ alpha: 2, beta: 6 });
    expect(ga.policy(TEST_GROUP_ID).chattiness).toBe('less');
    expect(ga.policy(TEST_GROUP_ID).threshold).toBeGreaterThan(0.7);
    expect(ga.setChattiness(TEST_GROUP_ID, 'more', { reason: 'words' })).toBe('more');
    expect(ga.policy(TEST_GROUP_ID).threshold).toBeLessThan(0.5);
  });

  it('a negative reaction is a penalty; reactions on other messages are ignored', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const g = ctxOf(t);
    const fb = createFeedback(g);
    fb.openWindow(TEST_GROUP_ID, 910, 'fun', t.clock.now());
    t.s.groupAgent.onReaction({ chatId: TEST_GROUP_ID, tgMessageId: 999, fromTgId: 2001, emoji: ['👎'], at: t.clock.now() });
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).arms.fun).toEqual({ alpha: 1, beta: 3 });
    t.s.groupAgent.onReaction({ chatId: TEST_GROUP_ID, tgMessageId: 910, fromTgId: 2001, emoji: ['👎'], at: t.clock.now() });
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).arms.fun).toEqual({ alpha: 1, beta: 4 });
  });

  it('with a seeded Random, the same draws every time (fixed arm order)', () => {
    const own = { ...emptyArms(), answer: [5, 1] as [number, number] };
    const a = drawThetas(seededRandom(7), own, emptyArms(), { alpha: 1, beta: 3 });
    const b = drawThetas(seededRandom(7), own, emptyArms(), { alpha: 1, beta: 3 });
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(['answer', 'fact_check', 'plan_help', 'summary', 'fun']);
  });
});
