// WP2 — the notify, group, guest and biz_owner channels (01 §5.5, F13, F14, ⚠U1, ⚠U2).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MissionService, Services } from '../../../src/contracts/index.ts';
import { TEST_GROUP_ID } from '../../harness/updates.ts';
import { makeConv, makeEnv, makeRun, makeUser, step, type Env } from './helpers.ts';

let e: Env;
const statusLines: Array<{ at: number; label: string | null }> = [];
const noDraft: string[] = [];
beforeEach(async () => {
  statusLines.length = 0;
  noDraft.length = 0;
  e = await makeEnv({
    services: {
      missions: { setStatusLine: async (_id: string, label: string | null) => void statusLines.push({ at: e.clock.now(), label }) } as unknown as MissionService,
      business: { noteNoDraft: async (id: string) => void noDraft.push(id) } as unknown as Services['business'],
    },
  });
});
afterEach(async () => {
  await e.close();
});
const fin = { footerLines: [], effects: [], allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };

describe('notify channel', () => {
  it('coalesces status labels onto the mission status card at most once per 3 s; no drafts', async () => {
    const ch = e.mod.channels.forRun(makeRun({ channel: 'notify', replyRef: { chatId: 1001, threadId: 9, missionId: 'ms_1' } }), makeConv({ kind: 'mission' }), () => {});
    await ch.begin();
    for (const l of ['Searching…', 'Comparing…', 'Checking prices…']) {
      ch.status(l);
      await step(e.clock, 500, 100);
    }
    await step(e.clock, 4000, 250);
    expect(statusLines.map((s) => s.label)).toEqual(['Searching…', 'Checking prices…']);
    expect(statusLines[1]!.at - statusLines[0]!.at).toBeGreaterThanOrEqual(3000);
    ch.text('Found 3 fares.');
    const refs = await ch.finalize(fin);
    expect(statusLines.at(-1)!.label).toBeNull();
    expect(e.tg.callsOf('sendRichMessageDraft', 'sendMessageDraft')).toHaveLength(0);
    expect(e.tg.byMethod('sendRichMessage').at(-1)).toMatchObject({ chat_id: 1001, message_thread_id: 9, rich_message: { markdown: 'Found 3 fares.' } });
    expect(refs).toHaveLength(1);
  });

  it('sends low-priority runs and messages during quiet hours without notification', async () => {
    const u = makeUser(e.s);
    const quiet = e.mod.channels.forRun(makeRun({ id: 'r_q', channel: 'notify', priority: 'proactive', userId: u.id }), makeConv({ userId: u.id }), () => {});
    quiet.text('Brief');
    await quiet.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).disable_notification).toBe(true);

    const loud = e.mod.channels.forRun(makeRun({ id: 'r_l', channel: 'notify', priority: 'interactive', userId: u.id }), makeConv({ userId: u.id }), () => {});
    loud.text('Now');
    await loud.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).disable_notification).toBeUndefined();

    e.s.repos.users.updateSettings(u.id, { quietStart: '08:00', quietEnd: '10:00' }); // the FakeClock is 09:00 UTC
    const night = e.mod.channels.forRun(makeRun({ id: 'r_n', channel: 'notify', priority: 'reminder', userId: u.id }), makeConv({ userId: u.id }), () => {});
    night.text('Shh');
    await night.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).disable_notification).toBe(true);
  });

  it('recovery-safe: the final parts use idempotency keys run:<id>:final:<i>', async () => {
    const run = makeRun({ id: 'r_rec', channel: 'notify' });
    const a = e.mod.channels.forRun(run, makeConv(), () => {});
    a.text('Once');
    await a.finalize(fin);
    const b = e.mod.channels.forRun(run, makeConv(), () => {});
    b.text('Once');
    await b.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage')).toHaveLength(1);
  });
});

describe('group channel', () => {
  const groupRun = (o: Parameters<typeof makeRun>[0] = {}) => makeRun({ channel: 'group', replyRef: { chatId: TEST_GROUP_ID, triggerMessageId: 31 }, ...o });
  const groupConv = makeConv({ kind: 'group', tgChatId: TEST_GROUP_ID });

  it('👀 on the trigger, typing every 4.5 s, a reply to the trigger, 👀 cleared; the first reply of the day has [🔒 Use Gora privately]', async () => {
    const ch = e.mod.channels.forRun(groupRun(), groupConv, () => {});
    await ch.begin();
    await step(e.clock, 10_000, 500);
    expect(e.tg.byMethod('setMessageReaction')[0]).toEqual({ chat_id: TEST_GROUP_ID, message_id: 31, reaction: [{ type: 'emoji', emoji: '👀' }] });
    const typing = e.tg.callsOf('sendChatAction');
    expect(typing.length).toBe(3);
    expect(typing[1]!.at - typing[0]!.at).toBe(4500);
    ch.text('Split it 3 ways: 40 each.');
    await ch.finalize(fin);
    const sent = e.tg.byMethod('sendRichMessage').at(-1);
    expect(sent).toMatchObject({ chat_id: TEST_GROUP_ID, reply_parameters: { message_id: 31, allow_sending_without_reply: true } });
    expect(sent.reply_markup.inline_keyboard[0][0].text).toBe('use_privately_button');
    expect(sent.reply_markup.inline_keyboard[0][0].url).toMatch(/^https:\/\/t\.me\/gora_test_bot\?start=grp_[0-9a-f]{16}$/);
    expect(e.tg.byMethod('setMessageReaction').at(-1)).toEqual({ chat_id: TEST_GROUP_ID, message_id: 31, reaction: [] });
    const n = e.tg.callsOf('sendChatAction').length;
    await step(e.clock, 10_000, 1000);
    expect(e.tg.callsOf('sendChatAction').length).toBe(n);

    const second = e.mod.channels.forRun(groupRun({ id: 'r_2' }), groupConv, () => {});
    await second.begin();
    second.text('Again');
    await second.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).reply_markup).toBeUndefined();
  });

  it('after 12 s posts a placeholder and later edits it with the answer', async () => {
    const ch = e.mod.channels.forRun(groupRun(), groupConv, () => {});
    await ch.begin();
    await step(e.clock, 12_500, 500);
    const ph = e.tg.callsOf('sendMessage').at(-1)!;
    expect(ph.payload).toMatchObject({ chat_id: TEST_GROUP_ID, text: 'guest_placeholder', reply_parameters: { message_id: 31 } });
    ch.text('**Done**');
    await ch.finalize(fin);
    const edit = e.tg.byMethod('editMessageText').at(-1);
    expect(edit).toMatchObject({ chat_id: TEST_GROUP_ID, message_id: (ph.result as { message_id: number }).message_id, rich_message: { markdown: '**Done**', skip_entity_detection: true } });
    expect(e.tg.byMethod('sendRichMessage')).toHaveLength(0);
  });
});

describe('guest channel (⚠U1, ⚠U2)', () => {
  const guestRun = (o: Parameters<typeof makeRun>[0] = {}) =>
    makeRun({ channel: 'guest', replyRef: { chatId: -100555, guestQueryId: 'gq_1', continueUrl: 'https://t.me/gora_test_bot?start=g_tok' }, ...o });
  const guestConv = makeConv({ kind: 'guest', tgChatId: -100555 });

  it('answers once, directly, when the run finishes within 3 s', async () => {
    const ch = e.mod.channels.forRun(guestRun(), guestConv, () => {});
    await ch.begin();
    await step(e.clock, 1000);
    ch.text('A fair split is 40 each.');
    await ch.finalize(fin);
    await step(e.clock, 5000, 500);
    const calls = e.tg.byMethod('answerGuestQuery');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      guest_query_id: 'gq_1',
      result: { type: 'article', id: 'g1', title: 'Gora', input_message_content: { rich_message: { markdown: 'A fair split is 40 each.', skip_entity_detection: true } }, reply_markup: { inline_keyboard: [[{ text: 'continue_privately_button', url: 'https://t.me/gora_test_bot?start=g_tok' }]] } },
    });
    expect(e.guests.marks).toEqual([{ guestQueryId: 'gq_1', status: 'answered', inlineMessageId: 'im_1' }]);
  });

  it('otherwise sends a placeholder at 3 s and edits it through inline_message_id', async () => {
    const ch = e.mod.channels.forRun(guestRun(), guestConv, () => {});
    await ch.begin();
    await step(e.clock, 3200, 100);
    expect(e.tg.byMethod('answerGuestQuery')).toHaveLength(1);
    expect(e.tg.byMethod('answerGuestQuery')[0].result.input_message_content.message_text).toContain('Continue privately');
    ch.text('Slow answer');
    await ch.finalize(fin);
    expect(e.tg.byMethod('answerGuestQuery')).toHaveLength(1);
    expect(e.tg.byMethod('editMessageText').at(-1)).toMatchObject({ inline_message_id: 'im_1', rich_message: { markdown: 'Slow answer' } });
    expect(e.guests.marks.map((m) => m.status)).toEqual(['placeholder', 'edited']);
  });

  it('⚠U1: a rich edit failure falls back to a plain edit; both failing marks the invocation failed', async () => {
    const ch = e.mod.channels.forRun(guestRun(), guestConv, () => {});
    await ch.begin();
    await step(e.clock, 3200, 100);
    e.tg.failNext('editMessageText', { error_code: 400, description: 'Bad Request: rich messages are not supported here' });
    ch.text('**Plain** fallback');
    await ch.finalize(fin);
    const edits = e.tg.callsOf('editMessageText');
    expect(edits.at(-1)!.payload).toMatchObject({ inline_message_id: 'im_1', text: 'Plain fallback' });
    expect(e.guests.marks.at(-1)!.status).toBe('edited');

    const ch2 = e.mod.channels.forRun(guestRun({ id: 'r_g2', replyRef: { chatId: -100555, guestQueryId: 'gq_2' } }), guestConv, () => {});
    await ch2.begin();
    await step(e.clock, 3200, 100);
    e.tg.failNext('editMessageText', { error_code: 400, description: 'Bad Request: nope' }, 3);
    ch2.text('x');
    await ch2.finalize(fin);
    expect(e.guests.marks.at(-1)).toEqual({ guestQueryId: 'gq_2', status: 'failed', inlineMessageId: 'im_2' });
  });
});

describe('biz_owner channel', () => {
  it('has no text surface and notes "no reply suggested" when business_draft_reply was not called', async () => {
    const run = makeRun({ id: 'r_biz', channel: 'biz_owner' });
    const ch = e.mod.channels.forRun(run, makeConv({ id: 'c_biz', kind: 'biz_draft' }), () => {});
    await ch.begin();
    ch.text('thinking out loud');
    expect(await ch.finalize(fin)).toEqual([]);
    expect(noDraft).toEqual(['c_biz']);
    expect(e.tg.calls.filter((c) => c.method.startsWith('send'))).toHaveLength(0);

    e.s.repos.runs.stageToolCalls([{ toolUseId: 'tu_1', runId: 'r_biz2', conversationId: 'c_biz2', epoch: 1, userId: null, assistantSeq: 1, ordinal: 0, name: 'business_draft_reply', input: {} }]);
    const ch2 = e.mod.channels.forRun(makeRun({ id: 'r_biz2', channel: 'biz_owner' }), makeConv({ id: 'c_biz2', kind: 'biz_draft' }), () => {});
    await ch2.finalize(fin);
    expect(noDraft).toEqual(['c_biz']);
  });
});
