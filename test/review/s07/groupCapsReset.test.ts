// s07 red team — GROUPS: any member resets the chime-in caps with "/forget всё".
// groups/repo.ts purge(chatId,'forget') sets last_chime_at = NULL, chimes_day = NULL, chimes_today = 0 (and the open
// reward window). capsCheck (groups/chime.ts) reads exactly those columns, so right after a chime-in a member can clear
// the "≤ 1 per 30 min" and "≤ 6 per day" caps (spec 07 C4) and Gora chimes in again within minutes. /forget всё needs no
// admin right (surfaces/group.ts onForgetAll).
import { afterEach, describe, expect, it } from 'vitest';
import type { TestUser } from '../../harness/updates.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { GR, grRows } from '../../harness/s07-gr.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, TEST_GROUP_ID, TEST_USER, U } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function member(app: TestApp, u: TestUser) {
  const row = app.s.repos.users.upsertFromTelegram({ id: u.id, first_name: u.first_name, ...(u.language_code ? { language_code: u.language_code } : {}) }, { dmChatId: u.id });
  app.s.repos.users.update(row.id, { tz: 'Asia/Almaty', tzSource: 'manual' });
}
const say2 = (app: TestApp, text: string, u: TestUser) => app.send(GR.text(text, { user: u, at: app.clock.now() }));
const chimes = (app: TestApp) =>
  app.tg.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === TEST_GROUP_ID && String(c.payload.text ?? '').startsWith('CHIME'));

async function openQuestion(app: TestApp, q: string, n: number) {
  app.llm.pushParse('group_judge', { should_speak: true, kind: 'answer', value: 'answer' });
  app.llm.pushParse('group_compose', { text: `CHIME ${n}.` });
  await say2(app, 'привет всем', OTHER_USER);
  await say2(app, q, TEST_USER);
  await app.advance(45_000);
  await app.advance(80_000);
}

describe('s07 red team: chime caps reset by /forget всё', () => {
  it('two chime-ins ~5 minutes apart (cap: 1 per 30 min)', async () => {
    // noon in Almaty (not night)
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL, now: Date.parse('2026-09-29T07:00:00Z') });
    member(t, TEST_USER);
    member(t, OTHER_USER);
    grRows.setArms(t.s, { answer: [30, 0] });
    await openQuestion(t, 'кто-нибудь знает, во сколько закрывается Байтерек?', 1);
    expect(chimes(t)).toHaveLength(1);

    await t.send(U.groupCommand('forget', 'всё', { user: OTHER_USER }));
    await openQuestion(t, 'а кто знает, где купить билеты в Шымкент?', 2);
    // FAILS: a second unprompted message within 30 minutes
    expect(chimes(t)).toHaveLength(1);
  });
});
