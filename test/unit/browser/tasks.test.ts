// s07 BR — browse task lifecycle (spec 07 A2/A4): one active task per user; the 40-step limit parks with step_limit; the
// 15-min wall clock parks with time_limit (FakeClock); a parked task resumes after the owner writes; the mission hook
// closes the context; the sweep ends tasks whose mission ended; execute-time re-checks (RECHECK, NO_CREDENTIALS);
// idempotency per idemKey; privacy (export without page data, deletion, retention).
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCtx, ToolOutput, ToolSpec } from '../../../src/contracts/index.ts';
import { browserInternals } from '../../../src/browser/internal.ts';
import { TOOLS } from '../../../src/browser/tools.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { BOOKING_ORIGIN, bookingSite } from '../../harness/fakeBrowser.ts';
import { say } from '../../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { RU_USER } from '../../harness/updates.ts';
import { RoutedTransport } from '../../harness/s07-br.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const tool = (n: string): ToolSpec => TOOLS.find((x) => x.name === n)!;
let seq = 0;

async function setup(config: Record<string, unknown> = {}) {
  const llm = new RoutedTransport();
  t = await createTestApp({ llm, config: config as never });
  t.browser.addSite(bookingSite());
  llm.push(say('Привет!'));
  await t.userSends('привет', { user: RU_USER });
  const u = t.s.repos.users.getByTg(RU_USER.id)!;
  const core = browserInternals(t.s)!;
  const start = async (idemKey = `k${++seq}`) => {
    llm.pushMission(say('ok')); // the mission's first run just ends; the tests drive the tools directly
    const r = await core.start({ userId: u.id, tgUserId: u.tgUserId, idemKey, goal: 'Забронировать столик на имя Adi', ownerMessages: 'Забронируй столик на имя Adi', taint: [], lang: 'ru' });
    await t!.settle();
    return r;
  };
  const ctxFor = (missionId: string, o: { idemKey?: string } = {}): ToolCtx => {
    const m = t!.s.missions.get(missionId)!;
    const id = o.idemKey ?? `toolu_${++seq}`;
    return {
      toolUseId: id, runId: '', conversationId: m.conversationId, epoch: 1, userId: u.id, tgUserId: u.tgUserId, surface: 'mission', scope: { kind: 'user', userId: u.id },
      tz: u.tz, lang: 'ru', now: t!.clock.now(), chat: { chatId: u.tgUserId, ...(m.threadId !== null ? { threadId: m.threadId } : {}) }, missionId,
      taint: new Set(['web']), signal: new AbortController().signal, effects: { push() {} }, services: t!.s, log: nullLogger, idemKey: id, priority: 'background', ...(id.startsWith('pa:') ? { approvedAction: { pendingActionId: id.slice(3) } } : {}),
    };
  };
  const call = async (missionId: string, name: string, input: unknown, o: { idemKey?: string } = {}): Promise<ToolOutput & { json?: Record<string, unknown> }> => {
    const spec = tool(name);
    const out = await spec.execute(spec.input.parse(input), ctxFor(missionId, o));
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(out.content) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { ...out, ...(json ? { json } : {}) };
  };
  return { llm, u, core, start, call, ctxFor };
}

describe('browse tasks (A2/A4)', () => {
  it('one active task per user; the second start is refused as busy', async () => {
    const { start, u } = await setup();
    const a = await start();
    expect(a.ok).toBe(true);
    const again = await start('same-key-different');
    expect(again).toMatchObject({ ok: false, code: 'BUSY' });
    expect(t!.s.browserTasks.active(u.id)?.status).toBe('running');
  });

  it('is idempotent per idemKey: the same browse_task call returns the same mission', async () => {
    const { start } = await setup();
    const a = await start('dup');
    const b = await start('dup');
    expect(a.ok && b.ok && a.missionId === b.missionId).toBe(true);
    expect(b.ok && b.created).toBe(false);
  });

  it('the step limit parks with step_limit and a [▶ Продолжить] offer; the owner reply resumes with a fresh step budget', async () => {
    const { start, call, u } = await setup({ limits: { browserMaxSteps: 3 } });
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` });
    await call(r.missionId, 'browser_scroll', { direction: 'down' });
    await call(r.missionId, 'browser_scroll', { direction: 'up' });
    const parked = await call(r.missionId, 'browser_snapshot', {});
    expect(parked.json).toMatchObject({ status: 'parked', reason: 'step_limit' });
    expect(t!.s.browserTasks.active(u.id)).toMatchObject({ status: 'parked', parkReason: 'step_limit' });
    await t!.settle();
    expect(t!.tg.calls.some((c) => JSON.stringify(c.payload?.reply_markup ?? {}).includes('▶ Продолжить'))).toBe(true);
    // still parked without an owner reply
    expect((await call(r.missionId, 'browser_snapshot', {})).json).toMatchObject({ status: 'parked' });
    await t!.clock.advance(1_000);
    const m = t!.s.missions.get(r.missionId)!;
    t!.s.repos.inputs.add({ conversationId: m.conversationId, kind: 'choice', author: 'owner', untrusted: false, content: [{ type: 'text', text: '▶ Продолжить' }], tgUpdateId: null, tgChatId: u.tgUserId, tgMessageId: null, fromTgUserId: u.tgUserId, replyToCardId: null });
    const resumed = await call(r.missionId, 'browser_snapshot', {});
    expect(resumed.content).toContain('Title: Tables');
    expect(t!.s.browserTasks.active(u.id)).toMatchObject({ status: 'running', steps: 1 });
  });

  it('the wall clock parks with time_limit (FakeClock) and closes the context', async () => {
    const { start, call, u } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` });
    expect(t!.browser.opened[0]!.closed).toBe(false);
    await t!.clock.advance(t!.s.config.limits.browserMaxWallMs + 1);
    const out = await call(r.missionId, 'browser_snapshot', {});
    expect(out.json).toMatchObject({ status: 'parked', reason: 'time_limit' });
    expect(t!.s.browserTasks.active(u.id)?.parkReason).toBe('time_limit');
    expect(t!.browser.opened[0]!.closed).toBe(true);
  });

  it('the sweep parks a running task past its wall clock, and ends tasks whose mission ended (after a missed hook)', async () => {
    const { start, call, core, u } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` });
    await t!.clock.advance(t!.s.config.limits.browserMaxWallMs + 1);
    await core.sweep();
    expect(t!.s.browserTasks.active(u.id)).toMatchObject({ status: 'parked', parkReason: 'time_limit' });
    expect(t!.browser.opened[0]!.closed).toBe(true);
    // a restart lost the mission hook: the mission is cancelled (Stop) but the row still says parked → 'cancelled'
    // (s07 lead fix: a Stop is reported as cancelled, not interrupted)
    const hooks = t!.s.missionHooks.splice(0);
    await t!.s.missions.stop(r.missionId, u.tgUserId);
    t!.s.missionHooks.push(...hooks);
    await core.sweep();
    expect(t!.s.browserTasks.list(u.id)[0]!.status).toBe('cancelled');
    expect(t!.s.browserTasks.active(u.id)).toBeNull();
  });

  it('a stale "starting" row (crash between insert and mission start) is failed by the sweep', async () => {
    const { core, u } = await setup();
    core.repo.insert({ id: 'bt_stale', userId: u.id, goal: 'x', ownerText: 'x', startUrl: null, constraints: null, now: t!.clock.now() });
    await t!.clock.advance(3 * 60_000);
    await core.sweep();
    expect(core.repo.get('bt_stale')!.status).toBe('failed');
  });

  it('the mission hook closes the context and marks the task when the mission finishes', async () => {
    const { start, call, u } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` });
    await t!.s.missions.finish(r.missionId, 'failed', 'gave up');
    await t!.settle();
    expect(t!.browser.opened[0]!.closed).toBe(true);
    expect(t!.s.browserTasks.list(u.id)[0]!.status).toBe('failed');
    expect((await call(r.missionId, 'browser_snapshot', {})).json).toMatchObject({ error: 'TASK_ENDED' });
  });

  it('execute re-checks against a fresh page: an unapproved submit is refused (RECHECK); passwords are never typed', async () => {
    const { start, call, u } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/book?r=alma` });
    // called directly (as if the Sentinel had been bypassed): the fresh classification says "commit" → no click
    const out = await call(r.missionId, 'browser_click', { ref: 'e6' });
    expect(out.json).toMatchObject({ error: 'RECHECK' });
    expect(t!.browser.events.some((e) => e.op === 'click' && e.ref === 'e6')).toBe(false);
    // an approved execution (ctx.approvedAction, set only by the executor's approval path) clicks
    const ok = await call(r.missionId, 'browser_click', { ref: 'e6' }, { idemKey: 'pa:ABC123' });
    expect(ok.content).toContain('Booking confirmed');
    // login wall: parked once; after the owner's reply a password is still never typed
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/login` });
    expect(t!.s.browserTasks.active(u.id)?.parkReason).toBe('login');
    await t!.clock.advance(1_000);
    const m = t!.s.missions.get(r.missionId)!;
    t!.s.repos.inputs.add({ conversationId: m.conversationId, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'пароль hunter2' }], tgUpdateId: null, tgChatId: u.tgUserId, tgMessageId: null, fromTgUserId: u.tgUserId, replyToCardId: null });
    const pw = await call(r.missionId, 'browser_type', { ref: 'e3', text: 'hunter2' });
    expect(pw.json).toMatchObject({ error: 'NO_CREDENTIALS' });
    expect(t!.browser.events.some((e) => e.op === 'type')).toBe(false);
  });

  it('the same idemKey never acts twice', async () => {
    const { start, call } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` }, { idemKey: 'toolu_same' });
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` }, { idemKey: 'toolu_same' });
    expect(t!.browser.events.filter((e) => e.op === 'open')).toHaveLength(1);
  });

  it('browser tools outside a browse task are refused; browse_task is not a mission tool', async () => {
    const { call, u, ctxFor, start } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    const spec = tool('browser_open');
    const out = await spec.execute({ url: `${BOOKING_ORIGIN}/` }, { ...ctxFor(r.missionId), missionId: 'MNOPE01' });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'NO_TASK' });
    expect(tool('browse_task').surfaces).toEqual(['dm', 'topic']);
    for (const s of TOOLS.filter((x) => x.name !== 'browse_task')) expect(s.surfaces).toEqual(['mission']);
    void call;
    void u;
  });

  it('privacy: export has the goal and metadata only; deletion removes rows and closes contexts; retention drops old finished rows', async () => {
    const { start, call, u } = await setup();
    const r = await start();
    if (!r.ok) throw new Error('start failed');
    await call(r.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/book?r=alma` });
    await call(r.missionId, 'browser_type', { ref: 'e3', text: 'Adi' });
    const hook = t!.s.privacyHooks.find((h) => h.name === 'browser')!;
    const exp = await hook.exportUser!(u.id, u.tgUserId);
    expect(exp).toMatchObject({ browser_tasks: [expect.objectContaining({ goal: 'Забронировать столик на имя Adi', host: 'tables.example', status: 'running' })] });
    expect(JSON.stringify(exp)).not.toContain('screenshot');
    expect(Object.keys((exp['browser_tasks'] as Array<Record<string, unknown>>)[0]!)).not.toContain('currentUrl');
    // retention: a finished task older than 30 days goes
    await call(r.missionId, 'browser_done', { summary: 'ok' });
    await hook.retentionSweep!(t!.clock.now() + 86_400_000); // not yet
    expect(t!.s.browserTasks.list(u.id)).toHaveLength(1);
    await hook.retentionSweep!(t!.clock.now() + (t!.s.config.limits.browserTaskRetentionDays + 1) * 86_400_000);
    expect(t!.s.browserTasks.list(u.id)).toEqual([]);
    // deletion
    const r2 = await start();
    if (!r2.ok) throw new Error('start failed');
    await call(r2.missionId, 'browser_open', { url: `${BOOKING_ORIGIN}/` });
    await hook.onDeleteUser(u.id, u.tgUserId);
    expect(t!.browser.opened.at(-1)!.closed).toBe(true);
    expect(t!.s.browserTasks.list(u.id)).toEqual([]);
  });
});
