// s07 red team — GROUPS (fixed at the s07 gate: purge('forget') shreds the group conversations, and the groups
// retention rotates/shreds reads-all group transcripts within the window; these are now regression tests):
// "/forget всё" and the 14-day retention did not reach the copies of member messages that every
// addressed reply writes into the GROUP CONVERSATION transcript.
//
// surfaces/group.ts, onGroupMessage (reads-all mode): for each mention / reply / "Гора, …" the recent group lines
// (recentContext, up to groupContextMaxTokens) are added as ONE untrusted conversation_inputs row (≤ 12,000 chars) of
// the group conversation `grp:<chatId>`. That row is consumed into the conversation's transcript (messages table) and
// replayed as history in every later run of that conversation.
// GROUP_DATA_TABLES (contracts/storage.ts) only lists group_messages / group_summaries / group_policy, so:
//   (a) /forget всё purges group_messages + summary, but the next addressed reply still sends the "forgotten" lines to
//       the model (from the transcript);
//   (b) the 14-day groups retentionSweep deletes group_messages, but the transcript copies live until the generic epoch
//       retention (closed epoch + 90 days) or the bot leaving.
import { afterEach, describe, expect, it } from 'vitest';
import type { TestUser } from '../../harness/updates.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { GR, grRows } from '../../harness/s07-gr.ts';
import { say } from '../../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, TEST_GROUP_ID, TEST_USER, U } from '../../harness/updates.ts';

const DAY = 86_400_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function member(app: TestApp, u: TestUser) {
  const row = app.s.repos.users.upsertFromTelegram({ id: u.id, first_name: u.first_name, ...(u.language_code ? { language_code: u.language_code } : {}) }, { dmChatId: u.id });
  app.s.repos.users.update(row.id, { tz: 'Asia/Almaty', tzSource: 'manual' });
}
const lastReq = (app: TestApp) => JSON.stringify(app.llm.requests.at(-1));

describe('s07 red team: group forget / retention miss the group conversation transcript', () => {
  it('(a) after /forget всё the purged member line still reaches the model on the next mention', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await t.send(GR.text('мой новый номер квартиры FORGET-ME-7731', { user: OTHER_USER, at: t.clock.now() }));
    t.llm.push(say('Ок!'));
    await t.send(U.groupMention('что думаешь?', { user: TEST_USER }));
    expect(lastReq(t)).toContain('FORGET-ME-7731'); // the recent lines went in (expected behaviour)

    await t.send(U.groupCommand('forget', 'всё', { user: OTHER_USER }));
    expect(grRows.messages(t.s)).toBe(0); // group_messages purged …
    expect(grRows.summaries(t.s)).toBe(0);

    t.llm.push(say('Привет!'));
    await t.send(U.groupMention('привет', { user: TEST_USER }));
    // … but the forgotten line is still sent to the LLM from the group transcript
    expect(lastReq(t)).not.toContain('FORGET-ME-7731');
  });

  it('(b) the 14-day group retention sweep removes group_messages, but the lines stay in the group transcript', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await t.send(GR.text('RETAIN-ME-5519 встречаемся у меня на даче', { user: OTHER_USER, at: t.clock.now() }));
    t.llm.push(say('Ок!'));
    await t.send(U.groupMention('ну что?', { user: TEST_USER }));
    expect(lastReq(t)).toContain('RETAIN-ME-5519');

    // the groups privacy hook's retention with a clock 15 days ahead (no running-app day advance needed)
    const hook = t.s.privacyHooks.find((h) => h.name === 'groups')!;
    await hook.retentionSweep!(t.clock.now() + 15 * DAY);
    expect(grRows.messages(t.s)).toBe(0);

    const conv = t.s.repos.conversations.byScopeKey(`grp:${TEST_GROUP_ID}`)!;
    const rows = t.s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get<{ n: number }>(conv.id)!.n
      + t.s.db.prepare('SELECT COUNT(*) AS n FROM conversation_inputs WHERE conversation_id = ?').get<{ n: number }>(conv.id)!.n;
    // s07 lead fix: the transcript of a reads-all group rotates and is shredded within the 14-day window too
    expect(Number(rows)).toBe(0);
    t.llm.push(say('Привет!'));
    await t.send(U.groupMention('привет', { user: TEST_USER }));
    expect(lastReq(t)).not.toContain('RETAIN-ME-5519');
  });
});
