// 01 §15.2 WP6 reminders e2e: create → fire → snooze → Undo; DST in Kyiv; reminders ignore quiet hours
// (+ the reminder survives a restart). Real scheduler / reminders / memory factories; every other WP pinned to fakes.
import { afterEach, describe, expect, it } from 'vitest';
import type { CallbackCtx, ReplyChannel, ToolCtx, ToolSpec, UserRow } from '../../src/contracts/index.ts';
import type { TestApp } from '../harness/testApp.ts';
import { addUser, dm, newShared, wp6App, type WpShared } from '../unit/memory/e2eHarness.ts';

const MIN = 60_000;
let t: TestApp;
let sh: WpShared;
afterEach(async () => {
  await t?.close();
});

async function create(u: UserRow, input: Record<string, unknown>, id = `toolu_${Math.random().toString(36).slice(2, 9)}`) {
  const conv = dm(t, u);
  const run = t.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.dmChatId!, triggerMessageId: 3 }, maxTokens: 1000 });
  const r = await t.s.executor.processRound(run, conv, 1, [{ type: 'tool_use', id, name: 'reminder_create', input }], null as unknown as ReplyChannel, new AbortController().signal);
  return JSON.parse(String(r.results[0]!.content)) as { id: string; first_at: string; unix: number; adjusted: string; error?: string };
}
function toolCtx(u: UserRow, idemKey: string): ToolCtx {
  return {
    toolUseId: idemKey, runId: 'r', conversationId: dm(t, u).id, epoch: 1, userId: u.id, tgUserId: u.tgUserId, surface: 'dm', scope: { kind: 'user', userId: u.id },
    tz: u.tz, lang: 'en', now: t.clock.now(), chat: { chatId: u.dmChatId! }, taint: new Set(), signal: new AbortController().signal, effects: { push() {} },
    services: t.s, log: t.s.log, idemKey, priority: 'interactive',
  };
}
const tap = (u: UserRow, parts: string[], messageId: number) =>
  t.s.telegram.callbacks.dispatch({ kind: 'rm', parts, fromTgId: u.tgUserId, user: u, callbackQueryId: `cq${messageId}${parts.join('')}`, message: { chatId: u.dmChatId!, messageId } } satisfies CallbackCtx);
const reminders = () => t.tg.calls.filter((c) => c.method === 'sendRichMessage' && String(c.payload.rich_message?.markdown ?? '').startsWith('⏰'));

describe('reminders e2e', () => {
  it('create → fire (inside quiet hours) → snooze → fire again → Done; Undo cancels before firing', async () => {
    sh = newShared();
    t = await wp6App(sh);
    const u = addUser(t, { tgUserId: 7001, tz: 'Europe/Kyiv' });
    t.s.repos.users.updateSettings(u.id, { quietStart: '00:00', quietEnd: '23:59' }); // quiet all day: reminders ignore it
    const r = await create(u, { text: 'Pay rent', kind: 'reminder', at_local: '2026-09-28T15:00', target: 'me' });
    expect(r.first_at).toBe('Mon 28 Sep, 15:00 (Europe/Kyiv)');
    expect(r.unix * 1000).toBe(Date.UTC(2026, 8, 28, 12, 0));
    await t.advance(2 * 60 * MIN);
    expect(reminders()).toHaveLength(0);
    await t.advance(60 * MIN);
    expect(reminders()).toHaveLength(1);
    const fired = reminders()[0]!;
    expect(fired.payload.chat_id).toBe(u.dmChatId);
    expect(fired.payload.rich_message.markdown).toContain(`<tg-time unix="${r.unix}" format="wDT">Mon 28 Sep, 15:00 (Europe/Kyiv)</tg-time>`);
    const kb = fired.payload.reply_markup.inline_keyboard[0] as Array<{ callback_data: string }>;
    expect(kb.map((b) => b.callback_data.split('|')[0])).toEqual([`rm:${r.id}:d`, `rm:${r.id}:10`, `rm:${r.id}:60`, `rm:${r.id}:tm`]);
    expect(t.llm.requests).toHaveLength(0); // deterministic: no LLM call

    const msgId = Number((fired.result as { message_id: number }).message_id);
    const ans = await tap(u, [r.id, '10'], msgId);
    expect((ans as { text: string }).text).toContain('15:10');
    await t.settle();
    expect(t.tg.byMethod('editMessageReplyMarkup').at(-1)).toMatchObject({ message_id: msgId, reply_markup: { inline_keyboard: [] } });
    await t.advance(10 * MIN);
    expect(reminders()).toHaveLength(2);
    await tap(u, [r.id, 'd'], msgId + 1);
    expect(t.s.reminders.list({ kind: 'user', userId: u.id }, true)[0]!.status).toBe('done');

    // Undo (the executor's ↩ calls spec.undo with the payload the tool returned)
    const spec = t.s.registry.get('reminder_create') as ToolSpec;
    const ctx = toolCtx(u, 'toolu_undo');
    const out = await spec.execute({ text: 'Call mom', kind: 'reminder', at_local: '2026-09-28T20:00', target: 'me' }, ctx);
    expect(out.undo!.line).toContain('<tg-time');
    await spec.undo!(out.undo!.payload, ctx);
    await t.advance(6 * 60 * MIN);
    expect(reminders()).toHaveLength(2);
    expect(t.s.reminders.list({ kind: 'user', userId: u.id }, true).find((x) => x.text === 'Call mom')!.status).toBe('cancelled');
  });

  it('DST in Kyiv: a gap time is shifted and reported; a daily 07:00 recurrence stays at 07:00 local across the October switch', async () => {
    sh = newShared();
    t = await wp6App(sh);
    const u = addUser(t, { tgUserId: 7002, tz: 'Europe/Kyiv' });
    const gap = await create(u, { text: 'Spring forward', kind: 'reminder', at_local: '2027-03-28T03:30', target: 'me' });
    expect(gap.adjusted).toBe('gap_shifted');
    expect(gap.unix * 1000).toBe(Date.UTC(2027, 2, 28, 1, 30)); // 04:30 EEST
    const overlap = await create(u, { text: 'Fall back', kind: 'reminder', at_local: '2026-10-25T03:30', target: 'me' });
    expect(overlap.adjusted).toBe('overlap_earlier');
    expect(overlap.unix * 1000).toBe(Date.UTC(2026, 9, 25, 0, 30));

    const daily = await create(u, { text: 'Stretch', kind: 'reminder', cron: '0 7 * * *', target: 'me' });
    expect(daily.unix * 1000).toBe(Date.UTC(2026, 8, 29, 4, 0)); // 07:00 EEST
    // drive time by hand: the background loop would otherwise tick through every simulated second of the jump
    await t.s.scheduler.stop();
    await t.clock.set(Date.UTC(2026, 9, 24, 4, 0) - MIN);
    // the process "slept" for weeks: the missed occurrences are coalesced into one late run
    await t.advance(MIN);
    const stretch = () => reminders().filter((c) => String(c.payload.rich_message.markdown).includes('Stretch'));
    expect(stretch()).toHaveLength(1);
    const job = () => t.s.scheduler.list({ userId: u.id, limit: 50 }).find((j) => j.refId === daily.id)!;
    expect(job().runAt).toBe(Date.UTC(2026, 9, 25, 5, 0)); // 07:00 EET, after the switch at 04:00 local
    await t.advance(Date.UTC(2026, 9, 25, 5, 0) - t.clock.now());
    expect(stretch()).toHaveLength(2);
    expect(String(stretch().at(-1)!.payload.rich_message.markdown)).toContain('Sun 25 Oct, 07:00 (Europe/Kyiv)');
    expect(job().runAt).toBe(Date.UTC(2026, 9, 26, 5, 0));
  });

  it('a scheduled reminder survives a restart and fires from the new process', async () => {
    sh = newShared();
    t = await wp6App(sh);
    const u = addUser(t, { tgUserId: 7003 });
    const r = await create(u, { text: 'Water plants', kind: 'reminder', at_local: '2026-09-28T16:00', target: 'me' });
    const t2 = await t.restart();
    t = t2;
    await t.advance(2 * 60 * MIN);
    const fired = reminders();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload.rich_message.markdown).toContain('⏰ Water plants');
    expect(r.id).toMatch(/^R/);
  });

  it('a default (best-guess) zone no longer blocks: the reminder is created in the guessed zone (05 A6)', async () => {
    sh = newShared();
    t = await wp6App(sh);
    const u = addUser(t, { tgUserId: 7004 });
    t.s.repos.users.update(u.id, { tzSource: 'default', tz: 'UTC' });
    const r = await create(u, { text: 'x', kind: 'reminder', at_local: '2026-10-01T10:00', target: 'me' });
    expect(r.error).toBeUndefined();
    expect(t.s.reminders.list({ kind: 'user', userId: u.id }, true)).toHaveLength(1);
  });
});
