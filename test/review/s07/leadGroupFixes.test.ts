// s07 lead (integration gate) — regression tests for the group findings fixed at the gate (the red-team / skeptic
// proofs in this folder cover the rest: groupForgetTranscript, groupSummaryRetention, groupFactsForget, groupCapsReset,
// groupWords, groupRejoinAfterShred, catchupNewestMissing):
//  - an edited group message replaces the stored copy (and drops a summary that folded the old wording);
//  - a member with no stored message of their own gets only the last hour in /catchup;
//  - a question addressed to Gora is never an "open question to the group" (no double answer on a slow run);
//  - automatic group facts expire with the 14-day retention; "/forget всё" says honestly what stayed.
import type { Update } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { scoreWindow, type WindowMessage } from '../../../src/groups/heuristic.ts';
import { createGroupRepo } from '../../../src/groups/repo.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { GR, grRows } from '../../harness/s07-gr.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { nextUpdateId, OTHER_USER, TEST_GROUP_ID, TEST_USER, U, type TestUser } from '../../harness/updates.ts';

const DAY = 86_400_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const edited = (messageId: number, text: string, o: { user: TestUser; at: number }): Update =>
  ({
    update_id: nextUpdateId(),
    edited_message: {
      message_id: messageId, date: Math.floor(o.at / 1000), edit_date: Math.floor(o.at / 1000) + 30, text,
      chat: { id: TEST_GROUP_ID, type: 'supergroup', title: 'Friends' }, from: { id: o.user.id, is_bot: false, first_name: o.user.first_name },
    },
  }) as unknown as Update;

describe('s07 lead: group edits, catch-up scope, addressed questions, fact expiry', () => {
  it('an edit replaces the stored text; an emptied caption removes it; a summary that folded the old text is dropped', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const now = t.clock.now();
    await t.send(GR.text('мой адрес Абая 10, кв 5 EDIT-OLD', { user: OTHER_USER, at: now, messageId: 7001 }));
    await t.send(GR.text('встречаемся в 7', { user: TEST_USER, at: now + 1_000, messageId: 7002 }));
    const repo = createGroupRepo(t.s.db, t.s.crypto, t.clock);
    repo.setSummary(TEST_GROUP_ID, { summary: 'Anna shared her address EDIT-OLD', coveredUntilAt: now + 1_000, covered: 2, coveredFromAt: now });
    await t.send(edited(7001, 'EDIT-NEW (адрес убрала)', { user: OTHER_USER, at: now }));
    const ctx = t.s.groupAgent.recentContext(TEST_GROUP_ID, {}) ?? '';
    expect(ctx).toContain('EDIT-NEW');
    expect(ctx).not.toContain('EDIT-OLD'); // neither the line nor the summary that quoted it
    // another member cannot edit someone else's line (Telegram only lets the author edit; the store checks it too)
    await t.send(edited(7002, 'SPOOF', { user: OTHER_USER, at: now }));
    expect(t.s.groupAgent.recentContext(TEST_GROUP_ID, {})).not.toContain('SPOOF');
    await t.send(edited(7001, '   ', { user: OTHER_USER, at: now }));
    expect(grRows.messages(t.s)).toBe(1);
  });

  it('/catchup for a member who never wrote covers the last hour only', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const repo = createGroupRepo(t.s.db, t.s.crypto, t.clock);
    const now = t.clock.now();
    const base = { chatId: TEST_GROUP_ID, threadId: null, kind: 'text' as const, addressed: null, replyToTgMessageId: null };
    repo.insertMessage({ ...base, tgMessageId: 1, fromTgId: OTHER_USER.id, text: 'CU-OLD три часа назад', senderName: 'Anna', at: now - 3 * 3_600_000 });
    repo.insertMessage({ ...base, tgMessageId: 2, fromTgId: OTHER_USER.id, text: 'CU-NEW десять минут назад', senderName: 'Anna', at: now - 10 * 60_000 });
    t.llm.pushParse('group_catchup', { lines: ['…'] });
    await t.s.groupAgent.catchup(TEST_GROUP_ID, TEST_USER.id, { lang: 'ru', threadId: null });
    const req = JSON.stringify(t.llm.parseRequests.filter((r) => r.purpose === 'group_catchup').at(-1));
    expect(req).toContain('CU-NEW');
    expect(req).not.toContain('CU-OLD');
  });

  it('a question addressed to Gora is not an open question to the group', () => {
    const q = (o: Partial<WindowMessage>): WindowMessage => ({ tgMessageId: 1, fromTgId: 10, isBot: false, text: 'во сколько открывается музей?', at: 0, replyToTgMessageId: null, ...o });
    const opts = { unansweredMs: 120_000, chattiness: 'normal' as const };
    expect(scoreWindow([q({})], 5 * 60_000, opts as never).reasons).toContain('open_question');
    const addressed = scoreWindow([q({ addressed: true, text: '@gora во сколько открывается музей?' })], 5 * 60_000, opts as never);
    expect(addressed.reasons).not.toContain('open_question');
    expect(addressed.score).toBe(0);
  });

  it('automatic group facts expire with the retention window; /forget всё says what stayed', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    for (const u of [TEST_USER, OTHER_USER]) {
      const row = t.s.repos.users.upsertFromTelegram({ id: u.id, first_name: u.first_name }, { dmChatId: u.id });
      t.s.repos.users.update(row.id, { tz: 'Asia/Almaty', tzSource: 'manual' });
    }
    await t.send(GR.text('в субботу идём в горы, FACT-TTL', { user: OTHER_USER, at: t.clock.now() }));
    t.llm.pushParse('group_summary', { summary: 'Hike on Saturday.' });
    t.llm.pushParse('group_facts', { facts: [{ text: 'Hike on Saturday FACT-TTL', kind: 'fact', source_message_id: null, sensitive: false }] });
    await t.advance(11 * 60_000);
    const row = t.s.db.prepare(`SELECT expires_at, created_by FROM memory_facts WHERE scope = ?`).get<{ expires_at: number | null; created_by: string }>(`grp:${TEST_GROUP_ID}`)!;
    expect(row.created_by).toBe('extractor');
    expect(row.expires_at).not.toBeNull();
    expect(Number(row.expires_at) - t.clock.now()).toBeLessThanOrEqual(t.s.config.limits.groupMessageRetentionDays * DAY);
    // a /remember note of TEST_USER stays when OTHER_USER (a regular member) says "/forget всё" — and the reply says so
    await t.send(U.groupCommand('remember', 'пароль от вайфая на даче — у Димы', { user: TEST_USER }));
    await t.send(U.groupCommand('forget', 'всё', { user: OTHER_USER }));
    const last = t.tg.calls.filter((c) => c.payload.chat_id === TEST_GROUP_ID).map((c) => String(c.payload.rich_message?.markdown ?? c.payload.text ?? '')).at(-1)!;
    const facts = (await t.s.memory.list({ kind: 'group', chatId: TEST_GROUP_ID }, { limit: 50 })).items.map((f) => f.text);
    expect(facts.some((f) => f.includes('FACT-TTL'))).toBe(false);
    expect(facts).toEqual([expect.stringContaining('вайфая')]);
    expect(last).toMatch(/\/remember/);
  });
});
