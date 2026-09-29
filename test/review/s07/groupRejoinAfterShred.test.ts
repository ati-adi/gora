// Review s07 (skeptic, GR). Gora is re-added to a group it left more than 7 days ago. The surfaces retention sweep has
// destroyed every 'grp:<chatId>' DEK (surfaces/index.ts destroyOwner), including 'g:<chatId>', which src/groups/repo.ts
// uses for EVERY group_messages / group_summaries row. After the re-add:
//  - observe → repo.insertMessage → crypto.seal('g:<chatId>') throws DekDestroyedError, swallowed by observe: nothing is
//    stored ever again (no context for addressed replies, no summary, no catch-up, no chime-ins);
//  - the groups retention sweep sees isDestroyed('g:<chatId>') and purges the chat 'left' on EVERY run, deleting the new
//    group_policy row (chattiness set by "Гора, тише" is silently reset).
// The same bug was fixed for group to-dos (reminders/repo.ts continues under 'g:<chatId>:<n>'; test/review/memory/group-rejoin).
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_BOT_INFO_READS_ALL } from '../../harness/fakeTelegram.ts';
import { GR, grRows } from '../../harness/s07-gr.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, RU_USER, TEST_GROUP_ID, TEST_USER, U } from '../../harness/updates.ts';

const DAY = 86_400_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function sweepAll(t: TestApp, now: number): Promise<void> {
  for (const h of t.s.privacyHooks) await h.retentionSweep?.(now);
}

describe('s07 GR review: re-added group after the 7-day shred', () => {
  it('stores messages again and keeps its chattiness after the bot is re-added', async () => {
    t = await createTestApp({ botInfo: TEST_BOT_INFO_READS_ALL });
    await t.send(U.myChatMember('member', { user: RU_USER, title: 'Друзья' }));
    await t.send(GR.text('первое сообщение', { user: OTHER_USER, at: t.clock.now() }));
    expect(grRows.messages(t.s)).toBe(1);

    // the bot is removed; 8 days later the retention sweeps run (surfaces shreds grp:<chatId>, groups purges 'left')
    await t.send(U.myChatMember('left', { user: RU_USER, title: 'Друзья' }));
    await sweepAll(t, t.clock.now() + 8 * DAY);
    await sweepAll(t, t.clock.now() + 8 * DAY + 60_000); // the groups hook runs before the surfaces shred: one sweep late (GR deviation 4)
    expect(grRows.messages(t.s)).toBe(0);

    // re-added; members talk again
    await t.send(U.myChatMember('member', { user: RU_USER, title: 'Друзья' }));
    await t.send(GR.text('встречаемся в пятницу у Лены', { user: TEST_USER, at: t.clock.now() }));
    await t.send(GR.text('ок, я приду', { user: OTHER_USER, at: t.clock.now() + 1000 }));
    // FAILS today: DekDestroyedError inside observe → nothing stored
    expect(grRows.messages(t.s)).toBe(2);

    t.s.groupAgent.setChattiness(TEST_GROUP_ID, 'less', { reason: 'settings' });
    await sweepAll(t, t.clock.now() + 8 * DAY + 120_000);
    // FAILS today too: the sweep purges the re-added chat as 'left' on every run
    expect(t.s.groupAgent.policy(TEST_GROUP_ID).chattiness).toBe('less');
  });
});
