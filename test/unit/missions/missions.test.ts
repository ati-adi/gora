// WP6b — MissionService / tools: tool metadata, 3 s card coalescing, 1/h report posts, quota, budget caps, context, export.
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCtx, UserRow } from '../../../src/contracts/index.ts';
import { TOOL_OWNERS } from '../../../src/contracts/index.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { deterministicId } from '../../../src/missions/internal.ts';
import { TOOLS } from '../../../src/missions/tools.ts';
import { createWp6bApp, type Wp6bApp } from '../proactive/wp6bHarness.ts';

const MIN = 60_000;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const ctx = (t: Wp6bApp, u: UserRow, idemKey: string, missionId?: string): ToolCtx => ({
  toolUseId: idemKey, runId: 'r', conversationId: 'c', epoch: 1, userId: u.id, tgUserId: u.tgUserId, surface: missionId ? 'mission' : 'dm', scope: { kind: 'user', userId: u.id },
  tz: 'UTC', lang: 'en', now: t.clock.now(), chat: { chatId: u.tgUserId }, ...(missionId ? { missionId } : {}), taint: new Set(), signal: new AbortController().signal,
  effects: { push() {} }, services: t.s, log: nullLogger, idemKey, priority: 'interactive',
});
const exec = async (t: Wp6bApp, name: string, input: unknown, c: ToolCtx): Promise<Record<string, unknown>> => {
  const spec = TOOLS.find((x) => x.name === name)!;
  const out = await spec.execute(spec.input.parse(input), c);
  await t.settle();
  return { ...(JSON.parse(out.content) as Record<string, unknown>), isError: !!out.isError };
};
const cardEdits = (t: Wp6bApp) => t.tg.callsOf('editMessageText').filter((c) => JSON.stringify(c.payload).includes('🎯'));
const mdOf = (c: { payload: Record<string, unknown> }) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, '');
const start = (t: Wp6bApp, u: UserRow, key = 'k1', extra: Record<string, unknown> = {}) =>
  exec(t, 'mission_start', { title: 'Find a flat', goal: 'Two rooms near the office', success_criteria: ['3 options'], ...extra }, ctx(t, u, key));

describe('mission tools', () => {
  it('exports the 5 WP6b tools, control · 0, with quota kinds on the creating tools', () => {
    expect(TOOLS.map((x) => x.name).sort()).toEqual(['mission_finish', 'mission_report', 'mission_start', 'watcher_create', 'watcher_manage']);
    for (const x of TOOLS) expect(TOOL_OWNERS[x.name]).toBe('WP6b');
    const cls = (n: string) => TOOLS.find((x) => x.name === n)!.classify({} as never, {} as ToolCtx);
    expect(cls('mission_start')).toEqual({ actionClass: 'control', risk: 0, quotaKind: 'mission' });
    expect(cls('watcher_create')).toEqual({ actionClass: 'control', risk: 0, quotaKind: 'watcher' });
    expect(cls('mission_finish')).toEqual({ actionClass: 'control', risk: 0 });
    expect(TOOLS.find((x) => x.name === 'mission_start')!.surfaces).toEqual(['dm', 'topic']);
    expect(deterministicId('M', 'u1', 'toolu_1')).toBe(deterministicId('M', 'u1', 'toolu_1'));
    expect(deterministicId('M', 'u1', 'toolu_1')).not.toBe(deterministicId('M', 'u2', 'toolu_1'));
    expect(TOOLS.find((x) => x.name === 'watcher_create')!.input.safeParse({ kind: 'page', target: 'https://x.com', condition: { type: 'number_below', near_text: 'x' }, interval_min: 60 }).success).toBe(false);
  });

  it('mission quota (free: 1 active) and budget capped at the plan maximum', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.quotas.limits.mission = 1;
    const a = await start(t, u, 'k1', { budget_usd: 99 });
    expect(a.budget_capped).toBe(true);
    expect(a.budget_usd).toBeCloseTo(t.s.config.plans.free.missionBudgetMicros / 1e6);
    const b = await start(t, u, 'k2');
    expect(b).toMatchObject({ isError: true, error: 'QUOTA' });
    // at the cap, ➕ Budget is a no-op
    await t.s.missions.addBudget(String(a.mission_id), 1);
    expect(t.s.missions.get(String(a.mission_id))!.budgetUsd).toBeCloseTo(t.s.config.plans.free.missionBudgetMicros / 1e6);
  });

  it('another owner cannot report on or finish my mission', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const other = t.user({ id: 2002 });
    const a = await start(t, u);
    const r = await exec(t, 'mission_finish', { mission_id: a.mission_id, outcome: 'done', summary: 'x' }, ctx(t, other, 'k9'));
    expect(r).toMatchObject({ isError: true, error: 'NOT_FOUND' });
    expect(t.s.missions.get(String(a.mission_id))!.status).toBe('active');
  });
});

describe('status card', () => {
  it('status labels are coalesced to at most one edit per 3 s, showing the latest', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const a = await start(t, u);
    const id = String(a.mission_id);
    const conv = t.s.missions.get(id)!.conversationId;
    // a live run so labels are shown
    const run = t.s.repos.runs.create({ conversationId: conv, userId: u.id, epoch: 1, trigger: 'mission_start', triggerRef: null, channel: 'notify', replyRef: { chatId: 1001 }, maxTokens: 100 });
    t.s.repos.runs.update(run.id, { state: 'running' });
    t.s.repos.conversations.casActiveRun(conv, null, run.id);
    for (const l of ['Searching…', 'Reading krisha.kz…', 'Comparing…']) await t.s.missions.setStatusLine(id, l);
    await t.advance(1_000);
    expect(cardEdits(t)).toHaveLength(0);
    await t.advance(2_000);
    expect(cardEdits(t)).toHaveLength(1);
    expect(mdOf(cardEdits(t)[0]!)).toContain('Comparing…');
    await t.s.missions.setStatusLine(id, 'Writing up…');
    await t.advance(1_000);
    expect(cardEdits(t)).toHaveLength(1);
    await t.advance(2_000);
    expect(cardEdits(t)).toHaveLength(2);
    expect(cardEdits(t)[1]!.payload.message_id).toBe(cardEdits(t)[0]!.payload.message_id);
  });

  it('mission_report edits the card every time but posts at most once per hour', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const a = await start(t, u);
    const id = String(a.mission_id);
    const posts = () => t!.tg.callsOf('sendRichMessage').filter((c) => mdOf(c).startsWith('📝'));
    await exec(t, 'mission_report', { mission_id: id, note: 'Found 1 option' }, ctx(t, u, 'r1', id));
    await exec(t, 'mission_report', { mission_id: id, note: 'Found 2 options' }, ctx(t, u, 'r2', id));
    await t.advance(3_000);
    expect(posts()).toHaveLength(1);
    expect(mdOf(cardEdits(t).at(-1)!)).toContain('Found 2 options');
    await t.advance(60 * MIN);
    await exec(t, 'mission_report', { mission_id: id, note: 'Found 3 options' }, ctx(t, u, 'r3', id));
    expect(posts()).toHaveLength(2);
  });
});

describe('context, export', () => {
  it('mission context in the mission conversation; open missions/watchers in the DM; export lists them', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const a = await start(t, u);
    const id = String(a.mission_id);
    const m = t.s.missions.get(id)!;
    t.parkRun(m.conversationId, ['user_input']);
    const provider = t.s.contextProviders.find((p) => p.name === 'missions')!;
    const mconv = t.s.repos.conversations.get(m.conversationId)!;
    const parts = await provider.parts(mconv, {} as never, '');
    expect(parts[0]!.key).toBe('mission');
    expect(parts[0]!.lines[0]).toBe(`mission ${id} "Find a flat" — status parked (waiting on user_input)`);
    const dm = t.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: u.tgUserId });
    const open = await provider.parts(dm, {} as never, '');
    expect(open).toEqual([{ key: 'open', lines: [`missions [${id} "Find a flat" parked on user_input]`] }]);
    const hook = t.s.privacyHooks.find((h) => h.name === 'missions')!;
    const ex = (await hook.exportUser!(u.id, u.tgUserId)) as { missions: Array<{ id: string; goal: string }> };
    expect(ex.missions).toEqual([expect.objectContaining({ id, goal: 'Two rooms near the office' })]);
  });
});
