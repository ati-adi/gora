// missions/tools.ts (WP6b) — 01 §6: mission_start, mission_report, mission_finish, watcher_create, watcher_manage
// (FULL toolset, class control · risk 0). Every execute is idempotent per ctx.idemKey: mission and watcher ids are
// derived from (owner, idemKey), so a re-executed call returns the same mission/watcher instead of a second one.
import { z } from 'zod';
import type { ToolCtx, ToolOutput, ToolSpec } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import { deterministicId, internalsOf } from './internal.ts';
import { WatcherError } from './watchers.ts';

const FULL_SURFACES = ['dm', 'topic', 'mission'] as const;
const MISSION_ID = z.string().regex(/^M[0-9A-Z]{6}$/);
const WATCHER_ID = z.string().regex(/^W[0-9A-Z]{6}$/);
const LOCAL = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

const err = (code: string, message: string): ToolOutput => ({ content: JSON.stringify({ error: code, message }), isError: true });
const ru = (lang: string) => uiLang(lang) === 'ru';

function owner(ctx: ToolCtx): { userId: string; tgUserId: number } | null {
  return ctx.userId && ctx.tgUserId ? { userId: ctx.userId, tgUserId: ctx.tgUserId } : null;
}

/** The mission the call may touch: the run's own mission, or one the owner owns. */
function ownedMission(ctx: ToolCtx, missionId: string): boolean {
  if (ctx.missionId === missionId) return true;
  const i = internalsOf(ctx.services);
  return !!i && !!ctx.userId && i.ownerOf(missionId) === ctx.userId;
}

// ───────────────────────── mission_start
const startInput = z.object({
  title: z.string().min(1).max(60),
  goal: z.string().min(1).max(2000),
  success_criteria: z.array(z.string().min(1).max(200)).min(1).max(8),
  deadline_local: LOCAL.optional(),
  budget_usd: z.number().positive().max(100).optional(),
});

export const missionStart: ToolSpec<z.infer<typeof startInput>> = {
  name: 'mission_start',
  description:
    'Call for a multi-step goal that takes longer than a few minutes or needs waiting (monitoring prices, waiting for replies, multi-day research). Opens a private mission topic with a live status card and a Stop button, and starts the mission in the background. Do not use for quick questions.',
  input: startInput,
  surfaces: ['dm', 'topic'],
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0, quotaKind: 'mission' }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Запускаю миссию' : 'Starting a mission'),
  async execute(input, ctx) {
    if (!ctx.services.config.features.missions) return err('DISABLED', 'Missions are turned off on this server.');
    const o = owner(ctx);
    const i = internalsOf(ctx.services);
    if (!o || !i) return err('UNAVAILABLE', 'Missions are available only in a private chat with the owner.');
    const cap = i.budgetCapUsd(o.userId);
    const id = deterministicId('M', o.userId, ctx.idemKey);
    try {
      const r = await i.startWithId(id, {
        userId: o.userId, tgUserId: o.tgUserId, title: input.title, goal: input.goal, criteria: input.success_criteria,
        ...(input.deadline_local ? { deadlineLocal: input.deadline_local } : {}),
        ...(input.budget_usd !== undefined ? { budgetUsd: Math.min(input.budget_usd, cap) } : {}),
        taint: [...ctx.taint],
      });
      const m = ctx.services.missions.get(r.missionId);
      return {
        content: JSON.stringify({
          status: r.created ? 'started' : 'already_started', mission_id: r.missionId, where: r.threadId !== null ? 'private topic' : `main chat, prefixed [${r.missionId}]`,
          budget_usd: m?.budgetUsd ?? null, budget_capped: input.budget_usd !== undefined && input.budget_usd > cap,
          note: 'The mission now runs in the background and reports in its own thread. Tell the owner in one short line; do not do the mission work here.',
        }),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      return err(/quota/.test(msg) ? 'QUOTA' : 'FAILED', msg);
    }
  },
};

// ───────────────────────── mission_report
const reportInput = z.object({
  mission_id: MISSION_ID,
  note: z.string().min(1).max(500),
  checklist: z.array(z.object({ text: z.string().min(1).max(100), done: z.boolean() })).max(15).optional(),
});

export const missionReport: ToolSpec<z.infer<typeof reportInput>> = {
  name: 'mission_report',
  description:
    'Call inside a mission to record progress: updates the status card (note and checklist). At most one notifying post per hour; other reports only edit the card silently.',
  input: reportInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Обновляю статус' : 'Updating the status'),
  async execute(input, ctx) {
    if (!ownedMission(ctx, input.mission_id)) return err('NOT_FOUND', 'No such mission for this owner.');
    const m = ctx.services.missions.get(input.mission_id);
    if (!m) return err('NOT_FOUND', 'No such mission.');
    if (m.status === 'done' || m.status === 'failed' || m.status === 'cancelled') return err('FINISHED', `Mission ${m.id} is already ${m.status}.`);
    await ctx.services.missions.report(input.mission_id, input.note, input.checklist);
    return { content: JSON.stringify({ ok: true, mission_id: input.mission_id }) };
  },
};

// ───────────────────────── mission_finish
const finishInput = z.object({
  mission_id: MISSION_ID,
  outcome: z.enum(['done', 'failed', 'cancelled']),
  summary: z.string().min(1).max(2000),
});

export const missionFinish: ToolSpec<z.infer<typeof finishInput>> = {
  name: 'mission_finish',
  description:
    'Call once when a mission is complete, has failed, or should stop: posts the summary in the mission thread, marks the topic ✅ or ⛔ and sends a short notice to the main chat. Its watchers stop.',
  input: finishInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Завершаю миссию' : 'Finishing the mission'),
  async execute(input, ctx) {
    if (!ownedMission(ctx, input.mission_id)) return err('NOT_FOUND', 'No such mission for this owner.');
    const before = ctx.services.missions.get(input.mission_id);
    if (!before) return err('NOT_FOUND', 'No such mission.');
    if (before.status === 'done' || before.status === 'failed' || before.status === 'cancelled') {
      return { content: JSON.stringify({ ok: true, mission_id: before.id, status: before.status, note: 'Already finished.' }) };
    }
    await ctx.services.missions.finish(input.mission_id, input.outcome, input.summary);
    return { content: JSON.stringify({ ok: true, mission_id: input.mission_id, status: input.outcome, note: 'The summary was posted. End your turn with one short line.' }) };
  },
};

// ───────────────────────── watcher_create
const conditionInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('changed') }),
  z.object({ type: z.literal('contains'), text: z.string().min(1).max(200) }),
  z.object({ type: z.literal('absent'), text: z.string().min(1).max(200) }),
  z.object({ type: z.literal('number_below'), near_text: z.string().min(1).max(100), threshold: z.number() }),
  z.object({ type: z.literal('semantic'), description: z.string().min(1).max(300) }),
]);
const watcherInput = z.object({
  kind: z.enum(['page', 'inbox']),
  target: z.string().min(1).max(500),
  condition: conditionInput,
  interval_min: z.number().int().min(5).max(10_080),
  mission_id: MISSION_ID.optional(),
});

export const watcherCreate: ToolSpec<z.infer<typeof watcherInput>> = {
  name: 'watcher_create',
  description:
    'Call to watch a web page (kind page, target = URL) or the Gmail inbox (kind inbox, target = Gmail search query) on a schedule. Checks are deterministic (hash first); a hit wakes the mission waiting with task_wait on "watcher:<id>" or notifies the owner. Use condition number_below for prices, contains/absent for text, semantic only when nothing simpler fits.',
  input: watcherInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0, quotaKind: 'watcher' }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Настраиваю наблюдение' : 'Setting up a watcher'),
  async execute(input, ctx) {
    const o = owner(ctx);
    const i = internalsOf(ctx.services);
    if (!o || !i) return err('UNAVAILABLE', 'Watchers are available only in a private chat with the owner.');
    const missionId = input.mission_id ?? ctx.missionId;
    if (missionId && !ownedMission(ctx, missionId)) return err('NOT_FOUND', 'No such mission for this owner.');
    const min = i.watcherMinInterval(o.userId);
    if (input.interval_min < min) return err('INTERVAL', `The minimum interval on the owner's plan is ${min} minutes. Retry with interval_min ≥ ${min}.`);
    const id = deterministicId('W', o.userId, ctx.idemKey);
    try {
      const r = await i.createWatcherWithId(id, {
        userId: o.userId, kind: input.kind, target: input.target, condition: input.condition, intervalMin: input.interval_min,
        ...(missionId ? { missionId } : {}), ...(ctx.chat.threadId !== undefined ? { threadId: ctx.chat.threadId } : {}),
      });
      return {
        content: JSON.stringify({
          status: r.created ? 'created' : 'already_created', watcher_id: r.id, interval_min: input.interval_min,
          ...(r.note ? { note: r.note } : {}),
          next: missionId ? `To wait for a hit, call task_wait with on:["watcher:${r.id}"].` : 'The owner is notified when the condition is met.',
        }),
      };
    } catch (e) {
      if (e instanceof WatcherError) return err(e.code.toUpperCase(), e.message);
      return err('FAILED', e instanceof Error ? e.message : 'failed');
    }
  },
};

// ───────────────────────── watcher_manage
const manageInput = z.object({ id: WATCHER_ID, action: z.enum(['pause', 'resume', 'cancel']) });

export const watcherManage: ToolSpec<z.infer<typeof manageInput>> = {
  name: 'watcher_manage',
  description: "Call to pause, resume or cancel one of the owner's watchers by id.",
  input: manageInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Меняю наблюдение' : 'Updating the watcher'),
  async execute(input, ctx) {
    if (!ctx.userId) return err('UNAVAILABLE', 'Watchers are available only in a private chat with the owner.');
    try {
      ctx.services.watchers.manage(input.id, ctx.userId, input.action);
    } catch (e) {
      if (e instanceof WatcherError) return err(e.code.toUpperCase(), e.message);
      throw e;
    }
    const w = ctx.services.watchers.list(ctx.userId).find((x) => x.id === input.id);
    return { content: JSON.stringify({ ok: true, watcher_id: input.id, status: w?.status ?? null }) };
  },
};

export const TOOLS: readonly ToolSpec[] = [missionStart, missionReport, missionFinish, watcherCreate, watcherManage];
