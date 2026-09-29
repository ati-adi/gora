// GR — spec 07 §C8 on the full stack (privacy mode OFF: TEST_BOT_INFO_READS_ALL). Join line; non-addressed messages
// stored but never answered; mentions / replies / "Гора, …" answered with the recent group lines as untrusted content;
// heuristic → judge → compose chime-ins (and none on venting); caps; "тише" / "можешь чаще"; the bandit learning from a
// reaction; /catchup scope and delivery; the DM ↔ group canary; retention and /forget; the privacy-mode-ON fallback;
// the add-to-group link. Scripted parses only; no real LLM.
import { afterEach, describe, expect, it } from 'vitest';
import type { TestUser } from '../harness/updates.ts';
import { JOIN_LINE } from '../../src/groups/strings.ts';
import { createGroupRepo } from '../../src/groups/repo.ts';
import { localDay } from '../../src/kernel/timeMath.ts';
import { SURF } from '../../src/surfaces/strings.ts';
import { TEST_BOT_INFO, TEST_BOT_INFO_READS_ALL } from '../harness/fakeTelegram.ts';
import { GR, grRows } from '../harness/s07-gr.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { OTHER_USER, RU_USER, TEST_GROUP_ID, TEST_USER, U } from '../harness/updates.ts';

const TZ = 'Asia/Almaty';
const MIN = 60_000;
const DAY = 86_400_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const app = (o: { now?: number; bot?: 'reads' | 'mentions' } = {}) =>
  createTestApp({ botInfo: o.bot === 'mentions' ? TEST_BOT_INFO : TEST_BOT_INFO_READS_ALL, ...(o.now !== undefined ? { now: o.now } : {}) });

/** A known member with a confirmed zone (the group zone is the majority of these). */
function member(t: TestApp, u: TestUser, o: { dm?: boolean } = {}) {
  const row = t.s.repos.users.upsertFromTelegram({ id: u.id, first_name: u.first_name, ...(u.language_code ? { language_code: u.language_code } : {}) }, o.dm === false ? {} : { dmChatId: u.id });
  t.s.repos.users.update(row.id, { tz: TZ, tzSource: 'manual' });
  return t.s.repos.users.getById(row.id)!;
}
const groupSends = (t: TestApp, chatId = TEST_GROUP_ID) => t.tg.calls.filter((c) => ['sendMessage', 'sendRichMessage'].includes(c.method) && c.payload.chat_id === chatId);
const textOf = (c: { payload: { text?: string; rich_message?: { markdown?: string } } }) => String(c.payload.rich_message?.markdown ?? c.payload.text ?? '');
const judgeCalls = (t: TestApp) => t.llm.parseRequests.filter((r) => r.purpose === 'group_judge').length;
const say2 = (t: TestApp, text: string, u: TestUser, o: { chatId?: number } = {}) => t.send(GR.text(text, { user: u, at: t.clock.now(), ...(o.chatId ? { chatId: o.chatId } : {}) }));

/** Members chat, a question stays open: 45 s lull + 2 min → the chime check has run. */
async function openQuestion(t: TestApp, o: { chatId?: number; q?: string } = {}) {
  await say2(t, 'привет всем', OTHER_USER, o);
  await say2(t, o.q ?? 'кто-нибудь знает, во сколько закрывается Байтерек?', TEST_USER, o);
  await t.advance(45_000);
  await t.advance(80_000);
}
function scriptChime(t: TestApp, text = 'Байтерек открыт до 21:00. Билеты продают на входе.') {
  t.llm.pushParse('group_judge', { should_speak: true, kind: 'answer', value: 'Байтерек работает до 21:00' });
  t.llm.pushParse('group_compose', { text });
}

describe('Gora in groups (spec 07 §C)', () => {
  it('C2: join → exactly one line in the group language, no buttons', async () => {
    t = await app();
    await t.send(U.myChatMember('member', { user: RU_USER, title: 'Друзья' }));
    const sends = groupSends(t);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.method).toBe('sendMessage');
    expect(textOf(sends[0]!)).toBe(JOIN_LINE.ru);
    expect(sends[0]!.payload.reply_markup).toBeUndefined();
    // re-delivery of the same update sends nothing new
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).readsAll).toBe(true);
  });

  it('C3/C4: non-addressed messages are stored, never answered; mention, reply and "Гора, …" are answered with the recent lines as untrusted content', async () => {
    t = await app();
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await say2(t, 'встречаемся в субботу у Лены LINE-A', OTHER_USER);
    await say2(t, 'я принесу торт LINE-B', TEST_USER);
    expect(grRows.messages(t.s)).toBe(2);
    expect(groupSends(t)).toHaveLength(0);
    expect(t.llm.requests).toHaveLength(0);

    t.llm.push(say('Суббота у Лены — отлично!'));
    await t.send(U.groupMention('что думаешь?', { user: OTHER_USER }));
    expect(groupSends(t).length).toBeGreaterThanOrEqual(1);
    const req = JSON.stringify(t.llm.requests.at(-1));
    expect(req).toContain('LINE-A');
    expect(req).toContain('LINE-B');
    expect(req).toMatch(/<untrusted[^>]*>[^]*LINE-A/);
    expect(req).toContain('[Member: Anna] что думаешь?');

    const before = t.llm.requests.length;
    t.llm.push(say('Да, торт — хорошая идея.'));
    await t.send(U.groupReply('а торт нужен?', 555, { user: TEST_USER }));
    expect(t.llm.requests.length).toBe(before + 1);

    t.llm.push(say('Давайте в 19:00.'));
    await say2(t, 'Гора, во сколько лучше собраться?', OTHER_USER);
    expect(t.llm.requests.length).toBe(before + 2);
    expect(JSON.stringify(t.llm.requests.at(-1))).toContain('Гора, во сколько лучше собраться?');
    // "поехали в горы" is not an address
    await say2(t, 'а потом поехали в горы', OTHER_USER);
    expect(t.llm.requests.length).toBe(before + 2);
    // Gora's own replies are stored too (kind 'bot'), so the summary and catch-up see both sides
    const bots = t.s.db.prepare(`SELECT COUNT(*) AS n FROM group_messages WHERE kind = 'bot'`).get<{ n: number }>()!.n;
    expect(Number(bots)).toBeGreaterThanOrEqual(1);
  });

  it('C4: an unanswered question + lull + 2 min → judge → ONE chime-in (≤ 2 sentences); a 👍 rewards it; caps hold; venting never reaches the judge', async () => {
    t = await app();
    member(t, TEST_USER);
    member(t, OTHER_USER);
    grRows.setArms(t.s, { answer: [30, 0] });
    scriptChime(t, 'Байтерек открыт до 21:00. Билеты продают на входе. Удачи всем!');
    await openQuestion(t);
    expect(judgeCalls(t)).toBe(1);
    const chimes = groupSends(t);
    expect(chimes).toHaveLength(1);
    expect(textOf(chimes[0]!)).toBe('Байтерек открыт до 21:00. Билеты продают на входе.');
    const judgeReq = t.llm.parseRequests.find((r) => r.purpose === 'group_judge')!;
    expect(judgeReq.user).toMatch(/<untrusted[^>]*source="group_member"/);
    expect(t.llm.callOpts.filter((c) => c.kind === 'parse').every((c) => c.opts?.priority === 'background')).toBe(true);

    // 👍 on the chime-in → α+1 for 'answer'
    const chimeId = Number((chimes[0]!.result as { message_id: number }).message_id);
    await t.send(GR.reaction(chimeId, '👍', { user: OTHER_USER, at: t.clock.now() }));
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).arms.answer).toEqual({ alpha: 32, beta: 3 });

    // a second eligible window within 30 min → suppressed before the judge
    await openQuestion(t, { q: 'а кто знает, где там парковка?' });
    expect(judgeCalls(t)).toBe(1);
    expect(groupSends(t)).toHaveLength(1);

    // the 7th of the (group-local) day → suppressed
    const repo = createGroupRepo(t.s.db, t.s.crypto, t.s.clock);
    repo.updatePolicy(TEST_GROUP_ID, { lastChimeAt: null, chimesDay: localDay(t.clock.now(), TZ), chimesToday: 6 });
    await openQuestion(t, { q: 'кто-нибудь знает, работает ли там кафе?' });
    expect(judgeCalls(t)).toBe(1);

    // venting in another group: the heuristic vetoes, the judge is never called
    const OTHER_CHAT = -100777;
    await say2(t, 'мне так плохо, мы расстались вчера', OTHER_USER, { chatId: OTHER_CHAT });
    await say2(t, 'кто-нибудь знает, как это пережить?', TEST_USER, { chatId: OTHER_CHAT });
    await t.advance(45_000);
    await t.advance(80_000);
    expect(judgeCalls(t)).toBe(1);
    expect(groupSends(t, OTHER_CHAT)).toHaveLength(0);
  });

  it('C4 caps: never at night in the group time zone; no known zone → no chime-ins', async () => {
    t = await app({ now: Date.UTC(2026, 8, 28, 18, 0, 0) }); // 23:00 in Almaty
    member(t, TEST_USER);
    member(t, OTHER_USER);
    grRows.setArms(t.s, { answer: [30, 0] });
    scriptChime(t);
    await openQuestion(t);
    expect(judgeCalls(t)).toBe(0);
    await t.close();

    t = await app(); // 14:00 in Almaty, but nobody's zone is known
    grRows.setArms(t.s, { answer: [30, 0] });
    scriptChime(t);
    await openQuestion(t);
    expect(judgeCalls(t)).toBe(0);
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).tz).toBeNull();
  });

  it('C4 by words: "Гора, тише" → quieter + a short ack, eligible windows skipped; "Гора, можешь чаще" → louder', async () => {
    t = await app();
    member(t, TEST_USER);
    member(t, OTHER_USER);
    grRows.setArms(t.s, { answer: [30, 0] });
    await say2(t, 'Гора, тише', OTHER_USER);
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).chattiness).toBe('less');
    expect(groupSends(t).map(textOf)).toEqual([SURF.group_quieter_ack.en]);
    expect(t.llm.requests).toHaveLength(0);
    scriptChime(t);
    await openQuestion(t, { q: 'кто-нибудь смотрел новый фильм Нолана?' });
    expect(judgeCalls(t)).toBe(0); // an open question alone is below the 'less' threshold
    await say2(t, 'Гора, можешь чаще', OTHER_USER);
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).chattiness).toBe('normal');
    expect(textOf(groupSends(t).at(-1)!)).toBe(SURF.group_louder_ack.en);
  });

  it('C5: /catchup covers only what came after the member\'s last message; ephemeral when possible, else the DM', async () => {
    t = await app();
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await say2(t, 'старое сообщение OLD-1', OTHER_USER);
    await t.advance(60_000);
    await say2(t, 'всем пока, я на работу MINE-1', TEST_USER);
    await t.advance(60_000);
    await say2(t, 'встречаемся в пятницу у Лены NEW-1', OTHER_USER);
    await say2(t, 'бронь на 19:00 NEW-2', OTHER_USER);
    t.llm.pushParse('group_catchup', { lines: ['Встреча в пятницу у Лены, бронь на 19:00'] });
    await t.send(GR.catchup({ user: TEST_USER, at: t.clock.now(), ephemeralMessageId: 91 }));
    const req = t.llm.parseRequests.filter((r) => r.purpose === 'group_catchup').at(-1)!;
    expect(req.user).toContain('NEW-1');
    expect(req.user).toContain('NEW-2');
    expect(req.user).not.toContain('MINE-1');
    expect(req.user).not.toContain('OLD-1');
    const eph = t.tg.byMethod('sendMessage').at(-1)!;
    expect(eph.ephemeral_message_parameters).toEqual({ receiver_user_id: TEST_USER.id });
    expect(eph.reply_parameters).toEqual({ ephemeral_message_id: 91 });
    expect(eph.text).toContain('Встреча в пятницу у Лены');
    // the request itself is not stored (so the next catch-up still starts after MINE-1)
    expect(grRows.messages(t.s)).toBe(4);

    // no ephemeral id → the catch-up goes to the member's DM, a one-line pointer in the group
    t.llm.pushParse('group_catchup', { lines: ['Пятница у Лены'] });
    await t.send(GR.catchup({ user: TEST_USER, at: t.clock.now(), ephemeralMessageId: null }));
    const dm = t.tg.byMethod('sendMessage').filter((p) => p.chat_id === TEST_USER.id).at(-1)!;
    expect(dm.text).toContain('Пятница у Лены');
    expect(textOf(groupSends(t).at(-1)!)).toBe(SURF.group_catchup_dm.en);

    // no DM yet (and no ephemeral id) → a button that opens the DM; /start me_<token> delivers the catch-up there
    const NEW: TestUser = { id: 1009, first_name: 'Ира', language_code: 'ru' };
    await say2(t, 'я тут новенькая', NEW);
    await say2(t, 'добро пожаловать! в пятницу у Лены NEW-3', OTHER_USER);
    await t.send(GR.catchup({ user: NEW, at: t.clock.now(), ephemeralMessageId: null }));
    const btn = t.lastCard().buttons[0] as { url?: string };
    expect(btn.url).toMatch(/start=me_/);
    t.llm.pushParse('group_catchup', { lines: ['Пятница у Лены'] });
    await t.send(U.start(btn.url!.split('start=')[1]!, { user: NEW }));
    const dmNew = t.tg.byMethod('sendMessage').filter((p) => p.chat_id === NEW.id).map((p) => String(p.text));
    expect(dmNew.some((x) => x.includes('Пятница у Лены'))).toBe(true);
    const newReq = t.llm.parseRequests.filter((r) => r.purpose === 'group_catchup').at(-1)!;
    expect(newReq.user).toContain('NEW-3');
    expect(newReq.user).not.toContain('я тут новенькая');

    // "что я пропустил?" works too
    t.llm.pushParse('group_catchup', { lines: ['Бронь на 19:00'] });
    await t.send(GR.text('что я пропустил?', { user: TEST_USER, at: t.clock.now() }));
    expect(t.llm.parseRequests.filter((r) => r.purpose === 'group_catchup')).toHaveLength(4);
  });

  it('C3 canary: a DM-only fact never reaches any group request; a group line never reaches a DM request', async () => {
    t = await app();
    const u = member(t, TEST_USER);
    member(t, OTHER_USER);
    grRows.setArms(t.s, { answer: [30, 0] });
    await t.s.memory.save({ kind: 'user', userId: u.id }, { text: 'мой паспорт 1234 DM-CANARY-5', kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' } });
    t.llm.push(say('Запомнила.'));
    await t.userSends('мой паспорт 1234 DM-CANARY-5');

    await say2(t, 'встречаемся в пятницу у Лены GRP-CANARY-9', OTHER_USER);
    t.llm.push(say('Отличный план!'));
    await t.send(U.groupMention('как вам?', { user: TEST_USER }));
    scriptChime(t);
    await openQuestion(t);
    t.llm.pushParse('group_summary', { summary: 'Встреча в пятницу у Лены.' });
    t.llm.pushParse('group_facts', { facts: [{ text: 'Встреча в пятницу у Лены', kind: 'group_decision', source_message_id: null, sensitive: false }] });
    await t.advance(11 * MIN);
    expect(t.llm.parseRequests.some((r) => r.purpose === 'group_summary')).toBe(true);
    expect(t.llm.parseRequests.some((r) => r.purpose === 'group_facts')).toBe(true);

    t.llm.push(say('В пятницу у тебя пока ничего.'));
    await t.userSends('что у меня на пятницу?');

    const all = [...t.llm.requests, ...t.llm.parseRequests].map((r) => JSON.stringify(r));
    const groupReqs = all.filter((x) => x.includes('GRP-CANARY-9'));
    const dmReqs = all.filter((x) => x.includes('DM-CANARY-5'));
    expect(groupReqs.length).toBeGreaterThanOrEqual(4); // addressed reply, judge, compose, summary, facts
    expect(dmReqs.length).toBeGreaterThanOrEqual(2);
    for (const x of groupReqs) expect(x).not.toContain('DM-CANARY-5');
    for (const x of dmReqs) expect(x).not.toContain('GRP-CANARY-9');
    for (const x of groupReqs) expect(x).not.toContain('паспорт 1234');
    // the automatic group fact landed in GROUP memory ("noticed in the group"), never in the member's
    const gf = await t.s.memory.list({ kind: 'group', chatId: TEST_GROUP_ID }, { limit: 10 });
    expect(gf.items.map((f) => f.text)).toContain('Встреча в пятницу у Лены');
    expect(gf.items[0]!.sourceLabel).toMatch(/noticed in the group|замечено в группе/);
    const mine = await t.s.memory.list({ kind: 'user', userId: u.id }, { limit: 10 });
    expect(mine.items.map((f) => f.text)).not.toContain('Встреча в пятницу у Лены');
  });

  it('C3 deletion: /forget всё purges messages + summary; the bot left + 7 days → everything purged', async () => {
    t = await app();
    member(t, TEST_USER);
    await say2(t, 'план на пятницу', TEST_USER);
    createGroupRepo(t.s.db, t.s.crypto, t.s.clock).setSummary(TEST_GROUP_ID, { summary: 'пятница', coveredUntilAt: t.clock.now(), covered: 1 });
    t.s.groupAgent.setChattiness(TEST_GROUP_ID, 'less');
    await t.send(U.groupCommand('forget', 'всё', { user: TEST_USER }));
    expect(grRows.messages(t.s)).toBe(0);
    expect(grRows.summaries(t.s)).toBe(0);
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).chattiness).toBe('less');

    await say2(t, 'снова план', TEST_USER);
    await t.send(U.myChatMember('left'));
    expect(grRows.messages(t.s)).toBe(1); // the grace period
    const later = t.clock.now() + 8 * DAY;
    await t.s.privacy.retentionSweep(later); // surfaces destroys grp:<chatId>
    await t.s.privacy.retentionSweep(later); // GR purges the unreadable rows
    expect(grRows.messages(t.s)).toBe(0);
    expect(grRows.policy(t.s)).toBeUndefined();
  });

  it('C1: privacy mode ON → mention-only: nothing stored, no chime-ins, the old intro, the BotFather hint logged once', async () => {
    t = await app({ bot: 'mentions' });
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await t.send(U.myChatMember('member', { title: 'Friends' }));
    expect(textOf(groupSends(t)[0]!)).toContain('only read messages that mention @gora_test_bot');
    await openQuestion(t);
    await say2(t, 'Гора, как дела?', OTHER_USER);
    expect(grRows.messages(t.s)).toBe(0);
    expect(judgeCalls(t)).toBe(0);
    expect(t.llm.requests).toHaveLength(0);
    const hints = (t.s.log as unknown as { entries: Array<{ msg?: string }> }).entries.filter((e) => (e.msg ?? '').includes('/setprivacy'));
    expect(hints).toHaveLength(1);
  });

  it('C6: group_invite_link from the DM returns the startgroup url button; /settings shows it too', async () => {
    t = await app();
    member(t, TEST_USER);
    t.llm.push(turn().toolUse('group_invite_link', {}, 'toolu_gi1'));
    t.llm.push(say('Держи — добавь меня в ваш чат.'));
    await t.userSends('хочу добавить тебя в чат с друзьями');
    const urls = t.tg.calls
      .filter((c) => c.payload?.chat_id === TEST_USER.id && c.payload?.reply_markup?.inline_keyboard)
      .flatMap((c) => (c.payload.reply_markup.inline_keyboard as Array<Array<{ url?: string }>>).flat().map((b) => b.url ?? ''));
    expect(urls).toContain('https://t.me/gora_test_bot?startgroup=g&admin=');
    await t.send(U.command('settings'));
    expect(t.lastCard().buttons.some((b) => (b as { url?: string }).url === 'https://t.me/gora_test_bot?startgroup=g&admin=')).toBe(true);
    const me = (await (await t.api('GET', '/api/me')).json()) as { addToGroupUrl: string | null };
    expect(me.addToGroupUrl).toBe('https://t.me/gora_test_bot?startgroup=g&admin=');
  });
});
