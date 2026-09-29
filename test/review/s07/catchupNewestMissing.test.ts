// Review s07 (skeptic, GR, C5 scope). src/groups/catchup.ts reads `repo.after(chatId, since, 2_000, …)` — the OLDEST 2,000
// messages after the member's last message (ORDER BY at ASC LIMIT 2000) — and then keeps `slice(-150)` of those. With
// more than 2,000 messages since the member last wrote (≈ 140/day over the 14-day retention), the catch-up is built from
// messages 1,851–2,000 and never sees the newest ones: "what did I miss" omits exactly the most recent part of the chat.
import { afterEach, describe, expect, it } from 'vitest';
import { createGroupRepo } from '../../../src/groups/repo.ts';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, TEST_GROUP_ID, TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('s07 GR review: /catchup scope with many messages', () => {
  it('the catch-up request contains the newest message since the member last wrote', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    const repo = createGroupRepo(t.s.db, t.s.crypto, t.clock);
    const t0 = t.clock.now() - 5 * 86_400_000;
    const base = { chatId: TEST_GROUP_ID, threadId: null, kind: 'text' as const, addressed: null, replyToTgMessageId: null };
    repo.insertMessage({ ...base, tgMessageId: 1, fromTgId: TEST_USER.id, text: 'моё последнее сообщение', senderName: 'Me', at: t0 });
    const N = 2_100;
    t.s.db.tx(() => {
      for (let i = 0; i < N; i++) {
        repo.insertMessage({ ...base, tgMessageId: 10 + i, fromTgId: OTHER_USER.id, text: `MSG-${i}`, senderName: 'Anna', at: t0 + 60_000 * (i + 1) });
      }
    });
    t.llm.pushParse('group_catchup', { lines: ['…'] });
    await t.s.groupAgent.catchup(TEST_GROUP_ID, TEST_USER.id, { lang: 'ru', threadId: null });
    const req = JSON.stringify(t.llm.parseRequests.filter((r) => r.purpose === 'group_catchup').at(-1));
    // FAILS today: the newest line is MSG-2099, but the prompt ends at MSG-1999
    expect(req).toContain(`MSG-${N - 1}`);
  });
});
