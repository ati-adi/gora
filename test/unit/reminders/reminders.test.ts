// WP6a reminders + to-dos (01 F6, §8.1–8.3): validation in the owner's zone, DST, firing (deterministic, quiet hours
// ignored, late/missed), rm:/td: callbacks, cron recurrences in tz, tz change, check-ins, tools with Undo, scoping.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler, ToolSpec } from '../../../src/contracts/index.ts';
import { createJobsRepo } from '../../../src/scheduler/repo.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createReminderModule } from '../../../src/reminders/index.ts';
import { TOOLS } from '../../../src/reminders/tools.ts';
import { ReminderError, resolveAtLocal, type ReminderServiceImpl } from '../../../src/reminders/service.ts';
import type { TodoServiceImpl } from '../../../src/reminders/todos.ts';
import { tomorrowAt } from '../../../src/reminders/callbacks.ts';
import { lateness } from '../../../src/reminders/fire.ts';
import { makeEnv, toolCtx, type TestEnv } from '../memory/env.ts';

const MIN = 60_000;
const H = 3_600_000;
let env: TestEnv;
let sch: Scheduler;
let mod: { reminders: ReminderServiceImpl; todos: TodoServiceImpl };

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s, { random: () => 0.5 });
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  mod = createReminderModule(env.s) as typeof mod;
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

const tool = (name: string) => TOOLS.find((t) => t.name === name) as ToolSpec;
const job = (id: string) => createJobsRepo(env.db).byDedupe(`rem:${id}`);
const run = async (ms: number) => {
  await env.clock.advance(ms);
  await sch.tick();
};

describe('ReminderService.create', () => {
  it('resolves at_local in the zone, schedules a deduped job and formats the display', () => {
    const u = env.user({ tz: 'Asia/Almaty' });
    const r = mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'reminder', text: 'Call mom', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: u.dmChatId! });
    expect(r.display).toBe('Mon 28 Sep, 15:00 (Asia/Almaty)');
    expect(r.unixSec * 1000).toBe(Date.UTC(2026, 8, 28, 10, 0));
    expect(r.adjusted).toBe('none');
    const j = job(r.id)!;
    expect(j.kind).toBe('reminder_fire');
    expect(j.runAt).toBe(r.unixSec * 1000);
    expect(j.refId).toBe(r.id);
    expect(j.payload).toEqual({}); // ids and enums only, never the text
  });

  it('rejects past times, malformed input and both/neither schedule fields', () => {
    const u = env.user();
    const base = { scope: { kind: 'user' as const, userId: u.id }, userId: u.id, kind: 'reminder' as const, text: 'x', tz: 'Asia/Almaty', chatId: 1 };
    expect(() => mod.reminders.create({ ...base, atLocal: '2026-09-28T13:59' })).toThrow(/past/);
    expect(() => mod.reminders.create({ ...base, atLocal: '2026-02-30T10:00' })).toThrow(ReminderError);
    expect(() => mod.reminders.create({ ...base })).toThrow(/exactly one/);
    expect(() => mod.reminders.create({ ...base, atLocal: '2026-10-01T10:00', cron: '0 9 * * *' })).toThrow(/exactly one/);
    expect(() => mod.reminders.create({ ...base, cron: '* * * * *' })).toThrow(/15 minutes/);
    expect(() => mod.reminders.create({ ...base, cron: '0 9 * *' })).toThrow(/5 fields/);
    expect(() => mod.reminders.create({ ...base, tz: 'Mars/Base', atLocal: '2026-10-01T10:00' })).toThrow(/time zone/);
  });

  it('DST in Kyiv: a gap time is shifted forward and reported; an overlap picks the earlier instant', () => {
    const now = env.clock.now();
    const gap = resolveAtLocal('2027-03-28T03:30', 'Europe/Kyiv', now);
    expect(gap.adjusted).toBe('gap_shifted');
    expect(gap.instant).toBe(Date.UTC(2027, 2, 28, 1, 30)); // 04:30 EEST
    const ov = resolveAtLocal('2026-10-25T03:30', 'Europe/Kyiv', now);
    expect(ov.adjusted).toBe('overlap_earlier');
    expect(ov.instant).toBe(Date.UTC(2026, 9, 25, 0, 30)); // 03:30 EEST (+03), not EET
  });

  it('rate limits creation and caps active reminders', () => {
    const u = env.user();
    const mk = (i: number) => mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'reminder', text: `r${i}`, atLocal: '2026-10-01T10:00', tz: 'Asia/Almaty', chatId: 1 });
    for (let i = 0; i < 20; i++) mk(i);
    expect(() => mk(21)).toThrow(/too many reminders created/);
  });

  it('is idempotent per source tool use', () => {
    const u = env.user();
    const p = { scope: { kind: 'user' as const, userId: u.id }, userId: u.id, kind: 'reminder' as const, text: 'x', atLocal: '2026-10-01T10:00', tz: 'Asia/Almaty', chatId: 1, sourceToolUseId: 'toolu_a' };
    expect(mod.reminders.create(p).id).toBe(mod.reminders.create(p).id);
    expect(mod.reminders.list({ kind: 'user', userId: u.id }, false)).toHaveLength(1);
  });
});

describe('firing', () => {
  it('fires deterministic text with <tg-time> and the four buttons, ignoring quiet hours', async () => {
    const u = env.user();
    env.repos.users.updateSettings(u.id, { quietStart: '00:00', quietEnd: '23:59' });
    const r = mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'reminder', text: 'Call *mom*', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: u.dmChatId!, threadId: 77 });
    await run(59 * MIN);
    expect(env.outbox.queued).toHaveLength(0);
    await run(MIN);
    expect(env.outbox.queued).toHaveLength(1);
    const m = env.outbox.queued[0]!;
    expect(m.method).toBe('sendRichMessage');
    expect(m.chatId).toBe(u.dmChatId);
    expect(m.threadId).toBe(77);
    expect(m.markdown).toContain('⏰ Call \\*mom\\*');
    expect(m.markdown).toContain(`<tg-time unix="${r.unixSec}" format="wDT">Mon 28 Sep, 15:00 (Asia/Almaty)</tg-time>`);
    expect(m.markdown).not.toContain('late');
    const kb = (m.payload['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(kb[0]!.map((b) => b.text)).toEqual(['done_button', 'snooze_10m_button', 'snooze_1h_button', 'tomorrow_button']);
    expect(kb[0]!.map((b) => b.callback_data)).toEqual([`rm:${r.id}:d|${u.tgUserId}`, `rm:${r.id}:10|${u.tgUserId}`, `rm:${r.id}:60|${u.tgUserId}`, `rm:${r.id}:tm|${u.tgUserId}`]);
    expect(mod.reminders.list({ kind: 'user', userId: u.id }, true)[0]!.status).toBe('fired');
    await run(H);
    expect(env.outbox.queued).toHaveLength(1); // once
  });

  it('marks a late reminder "(late)" and a day-late one "(missed)"', async () => {
    expect(lateness(0, 60_000)).toBe('on_time');
    expect(lateness(0, 3 * MIN)).toBe('late');
    expect(lateness(0, 25 * H)).toBe('missed');
    const u = env.user();
    mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'reminder', text: 'a', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: 1 });
    mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'reminder', text: 'b', atLocal: '2026-09-28T14:30', tz: 'Asia/Almaty', chatId: 1 });
    await env.clock.advance(3 * H); // the process was down
    await sch.tick();
    expect(env.outbox.queued.map((q) => q.markdown!.split('\n')[1]!.endsWith('late'))).toEqual([true, true]);
    const u2 = env.user();
    mod.reminders.create({ scope: { kind: 'user', userId: u2.id }, userId: u2.id, kind: 'reminder', text: 'c', atLocal: '2026-09-28T18:00', tz: 'Asia/Almaty', chatId: 2 });
    await env.clock.advance(30 * H);
    await sch.tick();
    expect(env.outbox.queued.at(-1)!.markdown).toContain('missed');
  });

  it('does not fire cancelled or paused reminders, nor for a deleting user', async () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    const a = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'a', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: 1 });
    const b = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'b', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: 1 });
    mod.reminders.manage(a.id, sc, 'cancel');
    mod.reminders.manage(b.id, sc, 'pause');
    expect(job(a.id)!.status).toBe('cancelled');
    await run(2 * H);
    expect(env.outbox.queued).toHaveLength(0);
    mod.reminders.manage(b.id, sc, 'resume');
    await run(MIN);
    expect(env.outbox.queued).toHaveLength(1); // resumed past its time → fires now (late)
    const u2 = env.user();
    mod.reminders.create({ scope: { kind: 'user', userId: u2.id }, userId: u2.id, kind: 'reminder', text: 'z', atLocal: '2026-09-28T18:00', tz: 'Asia/Almaty', chatId: 9 });
    env.repos.users.update(u2.id, { status: 'deleting' });
    await run(5 * H);
    expect(env.outbox.queued.filter((q) => q.chatId === 9)).toHaveLength(0);
  });

  it('rm: callbacks snooze (10 min / 1 h / tomorrow) and done; only the owner can tap', async () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    const r = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'Pay rent', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: u.dmChatId! });
    await run(H);
    expect(env.outbox.queued).toHaveLength(1);
    const msg = { chatId: u.dmChatId!, messageId: 900 };
    const other = env.user();
    expect(await env.tap('rm', [r.id, '10'], other.tgUserId, msg)).toMatchObject({ alert: true });
    const ans = await env.tap('rm', [r.id, '10'], u.tgUserId, msg);
    expect((ans as { text: string }).text).toContain('Snoozed until Mon 28 Sep, 15:10');
    expect(env.outbox.queued.at(-1)!.method).toBe('editMessageReplyMarkup');
    await run(10 * MIN);
    expect(env.outbox.queued.filter((q) => q.method === 'sendRichMessage')).toHaveLength(2);
    // Tomorrow: the same local time of day as the reminder's latest firing (15:10 after the snooze), on the next local day
    await env.tap('rm', [r.id, 'tm'], u.tgUserId, msg);
    expect(job(r.id)!.runAt).toBe(Date.UTC(2026, 8, 29, 10, 10));
    await env.tap('rm', [r.id, 'd'], u.tgUserId, msg);
    expect(mod.reminders.list(sc, true)[0]!.status).toBe('done');
    expect(job(r.id)!.status).toBe('cancelled');
    expect(tomorrowAt(Date.UTC(2026, 8, 28, 10), Date.UTC(2026, 8, 28, 19, 30), 'Asia/Almaty')).toBe(Date.UTC(2026, 8, 30, 10)); // already the 29th locally
  });
});

describe('recurrences and zones', () => {
  it('cron in the zone: Mon/Wed/Fri 07:00 Almaty; stays scheduled after firing; a snooze is an extra one-off', async () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    const r = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'Gym', cron: '0 7 * * 1,3,5', tz: 'Asia/Almaty', chatId: 1 });
    expect(r.unixSec * 1000).toBe(Date.UTC(2026, 8, 30, 2, 0)); // Wed 07:00 +05
    const j = job(r.id)!;
    expect(j.cron).toBe('0 7 * * 1,3,5');
    expect(j.tz).toBe('Asia/Almaty');
    await env.clock.set(Date.UTC(2026, 8, 30, 2, 0));
    await sch.tick();
    expect(env.outbox.queued).toHaveLength(1);
    expect(job(r.id)!.runAt).toBe(Date.UTC(2026, 9, 2, 2, 0)); // Fri
    expect(mod.reminders.list(sc, false)[0]!.status).toBe('scheduled');
    mod.reminders.manage(r.id, sc, 'snooze', { snoozeMin: 30 });
    expect(job(r.id)!.runAt).toBe(Date.UTC(2026, 9, 2, 2, 0)); // the series is untouched
    await run(30 * MIN);
    expect(env.outbox.queued).toHaveLength(2);
  });

  it('rescheduleForTz recomputes recurrences; one-offs keep their instant', () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    const c = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'Gym', cron: '0 7 * * *', tz: 'Asia/Almaty', chatId: 1 });
    const o = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'Call', atLocal: '2026-10-01T10:00', tz: 'Asia/Almaty', chatId: 1 });
    const before = job(o.id)!.runAt;
    expect(mod.reminders.rescheduleForTz(u.id, 'Europe/Kyiv')).toBe(1);
    expect(job(c.id)!.runAt).toBe(Date.UTC(2026, 8, 29, 4, 0)); // 07:00 EEST
    expect(job(c.id)!.tz).toBe('Europe/Kyiv');
    expect(job(o.id)!.runAt).toBe(before);
  });

  it('checkin_fire starts a notify event run with priority reminder in the originating conversation', async () => {
    const u = env.user();
    mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'checkin', text: 'How was the workout?', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: u.dmChatId! });
    await run(H);
    expect(env.runner.events).toEqual([{ conversationId: expect.any(String), type: 'checkin', priority: 'reminder' }]);
    expect(env.outbox.queued).toHaveLength(0);
  });

  it('checkin_fire is paused by the LLM budget gate while reminder_fire is not', async () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    env.llmBudget.blocked.add('reminder');
    const ci = mod.reminders.create({ scope: sc, userId: u.id, kind: 'checkin', text: 'c', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: 1 });
    mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'r', atLocal: '2026-09-28T15:00', tz: 'Asia/Almaty', chatId: 1 });
    await run(H);
    expect(env.outbox.queued).toHaveLength(1);
    expect(env.runner.events).toHaveLength(0);
    expect(job(ci.id)!.runAt).toBeGreaterThan(env.clock.now());
  });
});

describe('scoping and Undo', () => {
  it('another scope cannot see or manage a reminder', () => {
    const a = env.user();
    const b = env.user();
    const r = mod.reminders.create({ scope: { kind: 'user', userId: a.id }, userId: a.id, kind: 'reminder', text: 'secret', atLocal: '2026-10-01T10:00', tz: 'Asia/Almaty', chatId: 1 });
    expect(mod.reminders.list({ kind: 'user', userId: b.id }, true)).toEqual([]);
    expect(() => mod.reminders.manage(r.id, { kind: 'user', userId: b.id }, 'cancel')).toThrow(/No reminder/);
    expect(() => mod.reminders.manage(r.id, { kind: 'group', chatId: -100 }, 'cancel')).toThrow(/No reminder/);
  });

  it('reminder_create tool: effect line via undo, idempotent per idemKey, Undo cancels; a default (guessed) zone no longer blocks (05 A6)', async () => {
    const u = env.user();
    const ctx = toolCtx(env, { userId: u.id, tgUserId: u.tgUserId, chatId: u.dmChatId!, toolUseId: 'toolu_1' });
    const out = await tool('reminder_create').execute({ text: 'Pay rent', kind: 'reminder', at_local: '2026-10-01T10:00', target: 'me' }, ctx);
    expect(out.isError).toBeFalsy();
    const data = JSON.parse(out.content) as { id: string; first_at: string };
    expect(data.first_at).toBe('Thu 1 Oct, 10:00 (Asia/Almaty)');
    expect(out.undo!.line).toContain('<tg-time unix="');
    expect(out.undo!.line).toContain('format="wDT">Thu 1 Oct, 10:00 (Asia/Almaty)</tg-time>');
    const again = await tool('reminder_create').execute({ text: 'Pay rent', kind: 'reminder', at_local: '2026-10-01T10:00', target: 'me' }, ctx);
    expect(JSON.parse(again.content).id).toBe(data.id);
    await tool('reminder_create').undo!(out.undo!.payload, ctx);
    expect(job(data.id)!.status).toBe('cancelled');
    const d = env.user({ tzSource: 'default', tz: 'UTC' });
    const o2 = await tool('reminder_create').execute({ text: 'x', kind: 'reminder', at_local: '2026-10-01T10:00', target: 'me' }, toolCtx(env, { userId: d.id }));
    expect(o2.isError).toBeFalsy();
    expect(o2.content).toContain('best guess');
    const o3 = await tool('reminder_create').execute({ text: 'x', kind: 'reminder', at_local: '2020-10-01T10:00', target: 'me' }, toolCtx(env, { userId: u.id }));
    expect(o3.content).toContain('PAST');
  });

  it('reminder_manage Undo restores the previous schedule; this_group only in groups; group reminders fire into the group', async () => {
    const u = env.user();
    const ctx = toolCtx(env, { userId: u.id, chatId: u.dmChatId! });
    const c = await tool('reminder_create').execute({ text: 'Standup', kind: 'reminder', cron: '0 10 * * 1-5', target: 'me' }, ctx);
    const id = (JSON.parse(c.content) as { id: string }).id;
    const runAt = job(id)!.runAt;
    const m = await tool('reminder_manage').execute({ id, action: 'pause' }, ctx);
    expect(job(id)!.status).toBe('cancelled');
    await tool('reminder_manage').undo!(m.undo!.payload, ctx);
    expect(job(id)!.status).toBe('scheduled');
    expect(job(id)!.runAt).toBe(runAt);
    expect((await tool('reminder_create').execute({ text: 'x', kind: 'reminder', at_local: '2026-10-01T10:00', target: 'this_group' }, ctx)).content).toContain('NOT_IN_GROUP');
    const gctx = toolCtx(env, { userId: u.id, surface: 'group', scope: { kind: 'group', chatId: -100500 }, chatId: -100500 });
    const g = await tool('reminder_create').execute({ text: 'Team lunch', kind: 'reminder', at_local: '2026-09-28T15:00', target: 'this_group' }, gctx);
    expect(g.isError).toBeFalsy();
    const mine = await tool('reminder_create').execute({ text: 'Private', kind: 'reminder', at_local: '2026-09-28T15:00', target: 'me' }, gctx);
    expect(mine.isError).toBeFalsy();
    const listed = await tool('reminder_list').execute({ limit: 10 }, gctx);
    expect(listed.content).toContain('Team lunch');
    expect(listed.content).not.toContain('Private');
    await run(H);
    const sends = env.outbox.queued.filter((q) => q.method === 'sendRichMessage');
    expect(sends.map((q) => q.chatId).sort()).toEqual([-100500, u.dmChatId!].sort());
  });
});

describe('to-dos', () => {
  it('add / complete / reopen / remove / list with positions; idempotent add; render as a task list with td: buttons', () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    mod.todos.apply(sc, u.id, { action: 'add', text: 'milk' });
    mod.todos.apply(sc, u.id, { action: 'add', text: 'bread' });
    mod.todos.apply(sc, u.id, { action: 'add', text: 'Milk' });
    let l = mod.todos.apply(sc, u.id, { action: 'complete', id: '1' });
    expect(l.map((t) => [t.text, t.done, t.position])).toEqual([['bread', false, 1], ['milk', true, 2]]);
    l = mod.todos.setDone(l[1]!.id, sc, true);
    expect(l[1]!.done).toBe(true);
    l = mod.todos.apply(sc, u.id, { action: 'reopen', id: l[1]!.id });
    expect(l.every((t) => !t.done)).toBe(true);
    const r = mod.todos.render(sc, 'en');
    expect(r.markdown).toContain('- [ ] bread');
    expect(r.buttons[0]!.map((b) => (b as { callback_data: string }).callback_data)).toEqual(l.map((t) => `td:${t.id}|${u.tgUserId}`));
    l = mod.todos.apply(sc, u.id, { action: 'remove', id: l.find((t) => t.text === 'bread')!.id });
    expect(l.map((t) => t.text)).toEqual(['milk']);
    expect(() => mod.todos.apply(sc, u.id, { action: 'complete', id: '9' })).toThrow(/No to-do/);
    expect(mod.todos.apply({ kind: 'user', userId: env.user().id }, null, { action: 'list' })).toEqual([]);
  });

  it('td: toggle re-renders in place with editMessageText and records the message; group lists take any member', async () => {
    const u = env.user();
    const g = { kind: 'group' as const, chatId: -42 };
    const [t] = mod.todos.apply(g, u.id, { action: 'add', text: 'book the venue' });
    expect(mod.todos.render(g, 'en').buttons[0]![0]).toMatchObject({ callback_data: `td:${t!.id}|0` });
    const member = env.user();
    await env.tap('td', [t!.id], member.tgUserId, { chatId: -42, messageId: 55 });
    const edit = env.outbox.queued.at(-1)!;
    expect(edit.method).toBe('editMessageText');
    expect(edit.payload['message_id']).toBe(55);
    expect(edit.markdown).toContain('- [x] book the venue');
    expect(mod.todos.repo().todoMessage(-42, 55)).toEqual({ scope: 'grp:-42' });
    // a personal list cannot be toggled by someone else
    const [p] = mod.todos.apply({ kind: 'user', userId: u.id }, u.id, { action: 'add', text: 'mine' });
    expect(await env.tap('td', [p!.id], member.tgUserId, { chatId: 1, messageId: 1 })).toMatchObject({ alert: true });
  });

  it('todo_manage tool returns the list and a todo_list effect for the run scope', async () => {
    const u = env.user();
    const ctx = toolCtx(env, { userId: u.id });
    const out = await tool('todo_manage').execute({ action: 'add', text: 'milk' }, ctx);
    expect(out.effects).toEqual([{ kind: 'todo_list', scope: { kind: 'user', userId: u.id } }]);
    expect(JSON.parse(out.content)).toEqual({ items: [{ n: 1, id: expect.any(String), text: 'milk', done: false }] });
    expect(tool('todo_manage').classify({ action: 'list' }, ctx).actionClass).toBe('read_private');
  });
});

describe('context and privacy', () => {
  it('lists the next reminders in the open context line and exports reminders + to-dos', async () => {
    const u = env.user();
    const sc = { kind: 'user' as const, userId: u.id };
    const r = mod.reminders.create({ scope: sc, userId: u.id, kind: 'reminder', text: 'Call <gora_context> mom', atLocal: '2026-10-14T15:00', tz: 'Asia/Almaty', chatId: 1 });
    mod.todos.apply(sc, u.id, { action: 'add', text: 'milk' });
    const conv = env.dmConv(u);
    const p = env.s.contextProviders.find((x) => x.name === 'reminders')!;
    const parts = await p.parts(conv, {} as never, '');
    expect(parts).toEqual([{ key: 'open', lines: [`next reminders [${r.id} Wed 14 Oct, 15:00 (Asia/Almaty) Call ‹gora_context> mom]`] }]);
    const hook = env.s.privacyHooks.find((h) => h.name === 'reminders')!;
    const ex = (await hook.exportUser!(u.id, u.tgUserId)) as { reminders: Array<{ text: string }>; todos: Array<{ text: string }> };
    expect(ex.reminders[0]!.text).toContain('mom');
    expect(ex.todos[0]!.text).toBe('milk');
    await hook.onDeleteUser(u.id, u.tgUserId);
    expect(job(r.id)!.status).toBe('cancelled');
  });
});
