// s07 red team — GROUPS: the rolling summary carries member messages past the 14-day retention forever.
// summary.ts folds the previous summary into each new one (withSummary(prev, lines)); the groups retentionSweep
// (groups/index.ts) deletes only group_messages older than 14 days and never ages or rebuilds group_summaries. So what
// members wrote months ago stays in the sealed summary and is still handed to the model (recentContext "Summary of
// earlier messages", the judge, catch-up) after the messages themselves are gone (spec 07 C3: rolling 14-day retention).
import { afterEach, describe, expect, it } from 'vitest';
import type { TestUser } from '../../harness/updates.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { GR, grRows } from '../../harness/s07-gr.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, TEST_GROUP_ID, TEST_USER } from '../../harness/updates.ts';

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

describe('s07 red team: group summary outlives the 14-day retention', () => {
  it('after a 15-day sweep the messages are gone but their summary still reaches the model context', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    member(t, TEST_USER);
    member(t, OTHER_USER);
    await t.send(GR.text('встречаемся у Лены OLD-LINE', { user: OTHER_USER, at: t.clock.now() }));
    t.llm.pushParse('group_summary', { summary: 'Anna said they meet at Lena OLD-LINE.' });
    t.llm.pushParse('group_facts', { facts: [] });
    await t.advance(11 * 60_000);
    expect(grRows.summaries(t.s)).toBe(1);

    const hook = t.s.privacyHooks.find((h) => h.name === 'groups')!;
    await hook.retentionSweep!(t.clock.now() + 15 * DAY);
    expect(grRows.messages(t.s)).toBe(0);
    const ctx = (t.s.groupAgent as unknown as { recentContext(chatId: number, o: object): string | null }).recentContext(TEST_GROUP_ID, {});
    // FAILS: the 15-day-old content is still model context
    expect(ctx ?? '').not.toContain('OLD-LINE');
  });
});
