// Skeptic proof (spec 05 C1 "a Telegram 403 'bot was blocked' → the user's status becomes `blocked`, which stops all
// proactive sends until they write again"): set B now writes users.status = 'blocked' on a DM 403 (before 003 nothing
// ever set that status). Two older consumers treat 'blocked' as far more than "no proactive sends":
//   - trust/sentinel.ts maps any non-'active' status to userStatus 'paused' → rule S01 denies every non-read action
//     (e.g. a reminder the owner asks for in a GROUP while their DM with Gora is still blocked / not yet re-opened);
//   - http/auth.ts rejects status 'blocked' with 403, so the Mini App (/memory "see, correct and erase what Gora knows")
//     is locked.
// Unblocking the bot in Telegram (my_chat_member 'member' in the private chat) only clears users.bot_blocked; the
// status stays 'blocked' until the owner writes a DM message.
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_BOT_INFO } from '../../harness/fakeTelegram.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { nextUpdateId, TEST_USER } from '../../harness/updates.ts';
import type { ProposedAction } from '../../../src/contracts/index.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('skeptic: users.status = blocked outlives the block', () => {
  it('after a 403 and an unblock in Telegram, the Mini App is 403 and the sentinel treats the owner as paused', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    // outbox 403 in the owner's private chat → telegram/index.ts onBlocked → signals.blocked
    t.s.signals.blocked(u.id, t.clock.now());
    // the owner unblocks Gora in Telegram (no message yet)
    const bot = { id: TEST_BOT_INFO.id, is_bot: true, first_name: TEST_BOT_INFO.first_name, username: TEST_BOT_INFO.username };
    const from = { id: TEST_USER.id, is_bot: false, first_name: TEST_USER.first_name };
    await t.send({
      update_id: nextUpdateId(),
      my_chat_member: {
        chat: { id: TEST_USER.id, type: 'private', first_name: TEST_USER.first_name }, from, date: Math.floor(t.clock.now() / 1000),
        old_chat_member: { user: bot, status: 'kicked', until_date: 0 }, new_chat_member: { user: bot, status: 'member' },
      },
    } as never);
    const after = t.s.repos.users.getById(u.id)!;
    expect(after.botBlocked).toBe(false); // the unblock was seen …
    const state = { status: after.status, miniApp: (await t.api('GET', '/api/me')).status, sentinel: '' };
    const a = { toolName: 'reminder_create', surface: 'group', cls: { actionClass: 'reminder_write', integration: null }, targets: [] } as unknown as ProposedAction;
    state.sentinel = t.s.sentinel.snapshot(u.id, null, a).userStatus;
    // … but the status, the Mini App and the sentinel still say "blocked / paused"
    // FAILS: { status: 'blocked', miniApp: 403, sentinel: 'paused' }
    expect(state).toEqual({ status: 'active', miniApp: 200, sentinel: 'active' });
  });
});
