// s07 red team — GROUPS: automatic group facts about a member can be neither forgotten by that member nor escape the
// 14-day window, and any member can list them.
//
// groups/summary.ts saves the extracted facts with authorUserId: null. memory/index.ts `authorize` lets only the fact's
// author or a chat admin forget a group fact, so for automatic facts ONLY admins can. surfaces/group.ts onForgetAll
// purges group_messages + summary, silently skips the facts it may not forget, and still replies
// "Готово — забыла всё, что сохранила из этого чата." The fact (about the member who asked) then stays in group memory
// with no expiry (the 14-day retention covers group_messages only) and /groupmemory shows it to every member.
import { afterEach, describe, expect, it } from 'vitest';
import type { TestUser } from '../../harness/updates.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { GR } from '../../harness/s07-gr.ts';
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
const groupTexts = (app: TestApp) =>
  app.tg.calls.filter((c) => ['sendMessage', 'sendRichMessage'].includes(c.method) && c.payload.chat_id === TEST_GROUP_ID).map((c) => String(c.payload.rich_message?.markdown ?? c.payload.text ?? ''));

describe('s07 red team: automatic group facts survive the member\'s /forget всё', () => {
  it('the member is told "forgot everything", but the fact about them stays and is listed to others', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await t.send(GR.text('я в мае переезжаю в Берлин, FACT-B', { user: OTHER_USER, at: t.clock.now() }));
    t.llm.pushParse('group_summary', { summary: 'Anna is moving.' });
    t.llm.pushParse('group_facts', { facts: [{ text: 'Anna moves to Berlin in May FACT-B', kind: 'fact', source_message_id: null, sensitive: false }] });
    await t.advance(11 * 60_000); // 10 idle minutes → group_summarize
    const facts = async () => (await t!.s.memory.list({ kind: 'group', chatId: TEST_GROUP_ID }, { limit: 50 })).items.map((f) => f.text);
    expect(await facts()).toEqual(['Anna moves to Berlin in May FACT-B']);

    // Anna (a regular member; FakeTelegram getChatMember → 'member') asks Gora to forget everything
    await t.send(U.groupCommand('forget', 'всё', { user: OTHER_USER }));
    expect(groupTexts(t).at(-1)).toMatch(/forgotten what I stored|забыла всё/);
    // FAILS: the fact about her is still in group memory …
    expect(await facts()).toEqual([]);
  });
});
