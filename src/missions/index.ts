// missions/index.ts (WP6b) — createMissionModule: missions (topics, status cards, budgets, Stop) and watchers.
// Factory-time registrations only (04 §3): the watcher_check job, the `ms:` / `wt:` callbacks, the mission/open context
// provider, a run hook (mission run ended → card refresh), the mission/watcher quota counters and the privacy hook.
import type { CallbackAnswer, CallbackCtx, ContextPart, MissionModule, Services } from '../contracts/index.ts';
import { registerNamed } from '../kernel/registries.ts';
import { formatDisplay } from '../kernel/timeMath.ts';
import { clipText, langOf } from '../proactive/util.ts';
import { registerInternals } from './internal.ts';
import { createMissionCore, usd } from './missions.ts';
import { createMissionRepo, OPEN_MISSION_STATUSES } from './repo.ts';
import { createWatcherCore, WatcherError } from './watchers.ts';

const CB = {
  en: { stopped: 'Mission stopped.', budget: (v: string) => `Budget raised to ${v}.`, atMax: 'The budget is already at your plan’s maximum.', gone: 'This mission is no longer active.', notOwner: 'Only the owner can do that.', resumed: 'Watcher resumed.', paused: 'Watcher paused.', cancelled: 'Watcher cancelled.' },
  ru: { stopped: 'Миссия остановлена.', budget: (v: string) => `Бюджет увеличен до ${v}.`, atMax: 'Бюджет уже на максимуме тарифа.', gone: 'Эта миссия уже неактивна.', notOwner: 'Это может сделать только владелец.', resumed: 'Наблюдение возобновлено.', paused: 'Наблюдение на паузе.', cancelled: 'Наблюдение удалено.' },
} as const;

export function createMissionModule(s: Services): MissionModule {
  const repo = createMissionRepo(() => s.db, () => s.crypto);
  const watchers = createWatcherCore(s, repo);
  const core = createMissionCore(s, repo, {
    onFinished: (id, status) => {
      watchers.finishForMission(id);
      // s07: s.missionHooks (BR closes the task's browser context). Fire-and-forget; errors never fail the mission.
      for (const h of s.missionHooks ?? []) {
        try {
          void Promise.resolve(h.onMissionEnded(id, status)).catch((e: unknown) => s.log.warn({ hook: h.name, err: String(e) }, 'mission hook failed'));
        } catch (e) {
          s.log.warn({ hook: h.name, err: String(e) }, 'mission hook failed');
        }
      }
    },
  });
  registerInternals(s, { ...core.internals, ...watchers.internals });

  s.scheduler.register('watcher_check', (job) => watchers.job(job));
  s.quotas.registerCounter('mission', (userId) => repo.countOpenMissions(userId));
  s.quotas.registerCounter('watcher', (userId) => repo.countLiveWatchers(userId));

  s.telegram.callbacks.register('ms', async (c: CallbackCtx): Promise<CallbackAnswer> => {
    const L = CB[langOf(c.user)];
    const [id, action] = c.parts;
    const m = id ? repo.getMission(id) : undefined;
    if (!m || !c.user) return { text: L.gone };
    if (m.userId !== c.user.id) return { text: L.notOwner };
    if (!OPEN_MISSION_STATUSES.includes(m.status)) return { text: L.gone };
    if (action === 'stop') {
      await core.service.stop(m.id, c.fromTgId);
      return { text: L.stopped };
    }
    if (action === 'budget') {
      await core.service.addBudget(m.id, core.budgetStepUsd(m.userId));
      const after = repo.getMission(m.id);
      return { text: after && after.budgetMicros > m.budgetMicros ? L.budget(usd(after.budgetMicros)) : L.atMax };
    }
    return { text: L.gone };
  });

  s.telegram.callbacks.register('wt', async (c: CallbackCtx): Promise<CallbackAnswer> => {
    const L = CB[langOf(c.user)];
    const [id, action] = c.parts;
    if (!c.user || !id || (action !== 'resume' && action !== 'pause' && action !== 'cancel')) return { text: L.gone };
    try {
      watchers.service.manage(id, c.user.id, action);
    } catch (e) {
      if (e instanceof WatcherError) return { text: L.notOwner };
      throw e;
    }
    if (c.message) {
      s.telegram.outbox.enqueue({
        idempotencyKey: `wt:${id}:${action}:${c.message.messageId}`, userId: c.user.id, chatId: c.message.chatId, method: 'editMessageReplyMarkup',
        payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: [] } }, priority: 1,
      });
    }
    return { text: action === 'resume' ? L.resumed : action === 'pause' ? L.paused : L.cancelled };
  });

  registerNamed(s.contextProviders, {
    name: 'missions',
    surfaces: ['dm', 'topic', 'mission'],
    async parts(conv) {
      if (!conv.userId) return [];
      const u = s.repos.users.getById(conv.userId);
      if (!u) return [];
      const out: ContextPart[] = [];
      if (conv.kind === 'mission') {
        const m = repo.missionByConversation(conv.id);
        if (m) {
          const e = core.effective(m);
          const ws = repo.watchersOfMission(m.id).filter((w) => w.status === 'active' || w.status === 'paused');
          out.push({
            key: 'mission',
            lines: [
              `mission ${m.id} "${clipText(m.title, 60)}" — status ${e.status}${e.waitingOn ? ` (waiting on ${e.waitingOn.join(', ')})` : ''}`,
              `goal: ${clipText(m.goal, 600)}`,
              `success criteria: ${m.criteria.map((c) => clipText(c, 120)).join('; ')}`,
              ...(m.checklist.length ? [`checklist: ${m.checklist.map((c) => `[${c.done ? 'x' : ' '}] ${clipText(c.text, 80)}`).join('; ')}`] : []),
              `budget: ${usd(m.spentMicros)} of ${usd(m.budgetMicros)} spent`,
              ...(m.deadlineAt !== null ? [`deadline: ${formatDisplay(m.deadlineAt, u.tz, langOf(u))}`] : []),
              ...(ws.length ? [`watchers: ${ws.map((w) => `${w.id} ${w.kind} every ${w.intervalMin} min, ${w.status}`).join('; ')}`] : []),
            ],
          });
        }
        return out;
      }
      const open = repo.listMissions(u.id, { open: true, limit: 10 });
      const ws = repo.listWatchers(u.id).filter((w) => w.status === 'active' || w.status === 'paused').slice(0, 10);
      const lines: string[] = [];
      if (open.length) {
        lines.push(`missions [${open.map((m) => {
          const e = core.effective(m);
          return `${m.id} "${clipText(m.title, 40)}" ${e.status}${e.waitingOn ? ` on ${e.waitingOn.join(', ')}` : ''}`;
        }).join(' · ')}]`);
      }
      if (ws.length) lines.push(`watchers [${ws.map((w) => `${w.id} ${w.kind} ${w.status}${w.missionId ? ` for ${w.missionId}` : ''}`).join(' · ')}]`);
      if (lines.length) out.push({ key: 'open', lines });
      return out;
    },
  });

  s.runHooks.push({
    name: 'missions',
    onRunFinished(_run, conv) {
      if (conv.kind === 'mission') core.onRunEnded(conv.id);
    },
  });

  s.privacyHooks.push({
    name: 'missions',
    async onDeleteUser(userId) {
      for (const key of repo.watcherJobIds(userId)) s.scheduler.cancel(key);
      core.stopTimers(repo.listMissionsForExport(userId).map((m) => m.id));
    },
    async exportUser(userId) {
      return {
        missions: repo.listMissionsForExport(userId).map((m) => ({
          id: m.id, title: m.title, goal: m.goal, criteria: m.criteria, checklist: m.checklist, note: m.note, status: m.status,
          budgetUsd: m.budgetMicros / 1_000_000, spentUsd: m.spentMicros / 1_000_000, deadlineAt: m.deadlineAt, createdAt: m.createdAt, finishedAt: m.finishedAt,
        })),
        watchers: repo.listWatchers(userId).map((w) => ({ id: w.id, missionId: w.missionId, kind: w.kind, target: w.target, condition: w.condition, intervalMin: w.intervalMin, status: w.status, createdAt: w.createdAt })),
      };
    },
  });

  return { missions: core.service, watchers: watchers.service };
}
