// WP6b — 01 §15.2 missions.e2e: topic and status card; task_wait on an approval → wake → mission_finish renames with ✅;
// budget exhaustion card; Stop cancels a parked mission; a watcher hit wakes it; no-topics fallback.
// WP3/WP4 are replaced by pinned fakes (wp6bHarness): parked runs live in the REAL runs repo and the fake runner wakes
// them by token exactly like runner.wake (§5.6).
import { afterEach, describe, expect, it } from 'vitest';
import type { Surface, TaintSource, ToolCtx, ToolSpec, UserRow } from '../../src/contracts/index.ts';
import { nullLogger } from '../../src/kernel/log.ts';
import { TOOLS } from '../../src/missions/tools.ts';
import { createWp6bApp, tapButton, type Wp6bApp } from '../unit/proactive/wp6bHarness.ts';

let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const tool = (name: string): ToolSpec => TOOLS.find((x) => x.name === name)!;
function ctx(t: Wp6bApp, u: UserRow, o: { idemKey: string; surface?: Surface; missionId?: string; taint?: TaintSource[]; threadId?: number }): ToolCtx {
  return {
    toolUseId: o.idemKey, runId: 'run_x', conversationId: 'conv_x', epoch: 1, userId: u.id, tgUserId: u.tgUserId, surface: o.surface ?? 'dm',
    scope: { kind: 'user', userId: u.id }, tz: u.tz, lang: 'en', now: t.clock.now(), chat: { chatId: u.tgUserId, ...(o.threadId ? { threadId: o.threadId } : {}) },
    ...(o.missionId ? { missionId: o.missionId } : {}), taint: new Set(o.taint ?? []), signal: new AbortController().signal, effects: { push() {} },
    services: t.s, log: nullLogger, idemKey: o.idemKey, priority: 'interactive',
  };
}
async function run(t: Wp6bApp, name: string, input: unknown, c: ToolCtx): Promise<Record<string, unknown>> {
  const spec = tool(name);
  const parsed = spec.input.parse(input);
  const out = await spec.execute(parsed, c);
  await t.settle();
  return { ...(JSON.parse(out.content) as Record<string, unknown>), isError: !!out.isError };
}
const cards = (t: Wp6bApp) => t.tg.callsOf('sendRichMessage', 'editMessageText').filter((c) => JSON.stringify(c.payload).includes('🎯'));
const mdOf = (c: { payload: Record<string, unknown> }) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, '');
const buttonsOf = (c: { payload: Record<string, unknown> }) =>
  ((c.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat();

async function startMission(t: Wp6bApp, u: UserRow, idemKey = 'toolu_start', extra: Record<string, unknown> = {}) {
  const r = await run(t, 'mission_start', { title: 'ALA→IST fares', goal: 'Watch fares for Oct 20–27 under $250.', success_criteria: ['fare under $250 found', 'held in calendar'], ...extra }, ctx(t, u, { idemKey, taint: ['web'] }));
  expect(r.isError).toBe(false);
  return String(r.mission_id);
}

describe('missions (e2e)', () => {
  it('mission_start: private topic, status card with Stop, mission_start event run (background, taint inherited); idempotent per tool_use', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const id = await startMission(t, u);
    expect(id).toMatch(/^M[0-9A-Z]{6}$/);
    expect(t.topics.created).toEqual([{ missionId: id, title: 'ALA→IST fares', threadId: expect.any(Number) }]);
    const thread = t.topics.created[0]!.threadId;
    const card = cards(t)[0]!;
    expect(card.method).toBe('sendRichMessage');
    expect(card.payload.message_thread_id).toBe(thread);
    expect(mdOf(card)).toContain('🎯 **ALA→IST fares**');
    expect(mdOf(card)).toContain('- [ ] fare under $250 found');
    expect(buttonsOf(card).map((b) => b.text)).toEqual(['mission_stop_button']);
    expect(t.topics.statuses).toContainEqual({ threadId: thread, s: 'working' });
    const ev = t.runner.events.find((e) => e.type === 'mission_start')!;
    expect(ev.channel).toBe('notify');
    expect(ev.priority).toBe('background');
    expect(ev.body).toContain('Watch fares');
    const m = t.s.missions.get(id)!;
    expect(m.conversationId).toBe(ev.conversationId);
    expect(m.budgetUsd).toBeCloseTo(t.s.config.plans.free.missionBudgetMicros / 2 / 1e6);
    // a re-executed tool call (same idemKey) does not open a second mission
    const again = await run(t, 'mission_start', { title: 'ALA→IST fares', goal: 'x', success_criteria: ['y'] }, ctx(t, u, { idemKey: 'toolu_start' }));
    expect(again.status).toBe('already_started');
    expect(again.mission_id).toBe(id);
    expect(t.topics.created).toHaveLength(1);
    expect(t.runner.events.filter((e) => e.type === 'mission_start')).toHaveLength(1);
    // quota counter: the free plan allows 1 active mission
    expect(t.s.quotas.check(u.id, 'mission').used).toBe(1);
  });

  it('task_wait on an approval parks (⏸ card), the approval wakes it, mission_finish renames with ✅', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const id = await startMission(t, u);
    const thread = t.topics.created[0]!.threadId;
    const m = t.s.missions.get(id)!;
    // WP3 parks the run on task_wait(on:["approval:A7K2QX"]); the notify channel clears its status label.
    t.parkRun(m.conversationId, ['approval:A7K2QX']);
    await t.s.missions.setStatusLine(id, null);
    await t.advance(3_000);
    expect(t.s.missions.get(id)!.status).toBe('parked');
    expect(t.topics.statuses.at(-1)).toEqual({ threadId: thread, s: 'waiting' });
    expect(mdOf(cards(t).at(-1)!)).toContain('Waiting on approval:A7K2QX');
    // the owner approves → WP4 wakes the parked run
    expect(await t.s.runner.wake('approval:A7K2QX', { reason: 'approval', approvalId: 'A7K2QX', decision: 'approved', executed: true })).toBe(1);
    await t.s.missions.setStatusLine(id, 'Adding the fare to your calendar…');
    await t.advance(3_000);
    expect(t.s.missions.get(id)!.status).toBe('active');
    expect(t.topics.statuses.at(-1)).toEqual({ threadId: thread, s: 'working' });
    expect(mdOf(cards(t).at(-1)!)).toContain('Adding the fare to your calendar');
    // progress report edits the card (checklist) and posts once
    await run(t, 'mission_report', { mission_id: id, note: 'Found $231 on Oct 21.', checklist: [{ text: 'fare under $250 found', done: true }, { text: 'held in calendar', done: false }] }, ctx(t, u, { idemKey: 'toolu_r1', surface: 'mission', missionId: id }));
    await t.advance(3_000);
    expect(mdOf(cards(t).at(-1)!)).toContain('- [x] fare under $250 found');
    // finish
    const fin = await run(t, 'mission_finish', { mission_id: id, outcome: 'done', summary: 'Held the $231 fare on Oct 21.' }, ctx(t, u, { idemKey: 'toolu_f', surface: 'mission', missionId: id }));
    expect(fin.status).toBe('done');
    expect(t.s.missions.get(id)!.status).toBe('done');
    expect(t.topics.statuses.at(-1)).toEqual({ threadId: thread, s: 'done' });
    const posts = t.tg.callsOf('sendRichMessage').map((c) => ({ thread: c.payload.message_thread_id, md: mdOf(c) }));
    expect(posts.some((p) => p.thread === thread && p.md.includes('Held the $231 fare'))).toBe(true);
    expect(posts.some((p) => p.thread === undefined && p.md.includes('ALA→IST fares'))).toBe(true); // short DM notice
    expect(buttonsOf(cards(t).at(-1)!)).toEqual([]); // no Stop on a finished card
    expect(t.s.quotas.check(u.id, 'mission').used).toBe(0);
  });

  it('budget exhaustion: card offers [➕ Budget] [⏹ Stop]; ➕ Budget raises it and wakes the budget park', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const id = await startMission(t, u, 'toolu_b', { budget_usd: 0.1 });
    expect(t.s.missions.chargeCost(id, 60_000).exhausted).toBe(false);
    expect(t.s.missions.chargeCost(id, 50_000).exhausted).toBe(true);
    const m = t.s.missions.get(id)!;
    expect(m.status).toBe('budget_exhausted');
    // WP3 parks the run on the budget token
    t.parkRun(m.conversationId, [`budget:${id}`]);
    await t.advance(3_000);
    const msg = t.tg.callsOf('sendRichMessage').find((c) => mdOf(c).includes('mission_budget_exhausted'))!;
    expect(mdOf(msg)).toContain('mission_budget_exhausted(budget=$0.10,spent=$0.11)');
    const btns = buttonsOf(msg);
    expect(btns.map((b) => b.text)).toEqual(['➕ Budget', 'mission_stop_button']);
    expect(buttonsOf(cards(t).at(-1)!).map((b) => b.text)).toEqual(['➕ Budget', 'mission_stop_button']);
    const ans = await tapButton(t, btns[0]!.callback_data);
    expect(ans).toEqual({ text: expect.stringMatching(/Budget raised to \$0\.23/) });
    expect(t.runner.wakes.at(-1)).toMatchObject({ token: `budget:${id}`, p: { reason: 'budget' }, woke: 1 });
    expect(t.s.missions.get(id)!.status).toBe('active');
  });

  it('Stop cancels a parked mission: wake(cancelled), ⛔ topic, no model call, watchers stop', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const id = await startMission(t, u);
    const thread = t.topics.created[0]!.threadId;
    t.caps.safeFetch.set('https://fares.example.com/ala-ist', '<p>Best fare: $310</p>');
    const w = await run(t, 'watcher_create', { kind: 'page', target: 'https://fares.example.com/ala-ist', condition: { type: 'number_below', near_text: 'Best fare', threshold: 250 }, interval_min: 360 }, ctx(t, u, { idemKey: 'toolu_w', surface: 'mission', missionId: id }));
    expect(w.status).toBe('created');
    const m = t.s.missions.get(id)!;
    t.parkRun(m.conversationId, [`watcher:${String(w.watcher_id)}`, 'user_input']);
    await t.advance(3_000);
    const stop = buttonsOf(cards(t).at(-1)!).find((b) => b.text === 'mission_stop_button')!;
    const eventsBefore = t.runner.events.length;
    expect(await tapButton(t, stop.callback_data)).toEqual({ text: 'Mission stopped.' });
    // one of the run's wait tokens is woken with `cancelled` (exactly one wake reaches the run)
    expect(t.runner.wakes.filter((x) => x.p.reason === 'cancelled' && x.woke === 1)).toHaveLength(1);
    expect(t.s.missions.get(id)!.status).toBe('cancelled');
    expect(t.topics.statuses.at(-1)).toEqual({ threadId: thread, s: 'failed' });
    expect(t.runner.events.length).toBe(eventsBefore);
    expect(t.s.watchers.list(u.id)[0]!.status).toBe('done');
    expect(await tapButton(t, stop.callback_data)).toEqual({ text: 'This mission is no longer active.' });
  });

  it('a watcher hit wakes the mission waiting on watcher:<id> (hash first; baseline never fires)', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const id = await startMission(t, u);
    const url = 'https://fares.example.com/ala-ist';
    t.caps.safeFetch.set(url, '<p>Best fare: $310</p>');
    const w = await run(t, 'watcher_create', { kind: 'page', target: url, condition: { type: 'number_below', near_text: 'Best fare', threshold: 250 }, interval_min: 360 }, ctx(t, u, { idemKey: 'toolu_w', surface: 'mission', missionId: id }));
    const wid = String(w.watcher_id);
    expect(w.next).toContain(`watcher:${wid}`);
    const m = t.s.missions.get(id)!;
    t.parkRun(m.conversationId, [`watcher:${wid}`]);
    // unchanged page → hash equal → nothing
    await t.advance(360 * 60_000);
    expect(t.runner.wakes).toHaveLength(0);
    // the fare drops
    t.caps.safeFetch.set(url, '<p>Best fare: $231</p>');
    await t.advance(360 * 60_000);
    expect(t.runner.wakes).toEqual([{ token: `watcher:${wid}`, p: { reason: 'watcher', watcherId: wid, summary: 'Best fare 231 < 250' }, woke: 1 }]);
    expect(t.caps.safeFetch.calls.length).toBe(3);
  });

  it('no-topics fallback: the mission lives in the main DM with an [M…] prefix', async () => {
    t = await createWp6bApp({ topics: false });
    const u = t.user();
    const id = await startMission(t, u);
    const card = cards(t)[0]!;
    expect(card.payload.message_thread_id).toBeUndefined();
    expect(mdOf(card)).toContain(`🎯 **[${id}] ALA→IST fares**`);
    expect(t.s.missions.get(id)!.threadId).toBeNull();
    expect(t.topics.statuses).toEqual([]);
    const ev = t.runner.events.find((e) => e.type === 'mission_start')!;
    expect(ev.replyRef).toEqual({ chatId: u.tgUserId, missionId: id });
  });
});
