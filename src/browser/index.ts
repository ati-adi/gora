// browser/index.ts (s07 BR, spec 07 §A) — createBrowserModule(s): browse tasks (table browser_tasks) run as missions.
// Factory-time registrations only (04 §3 timing rule): the 'browser_sweep' job + its 'sys:browser_sweep' cron (every
// minute, no LLM), a mission hook (s.missionHooks: close the task's context and mark the row when the mission ends or is
// stopped), the privacy hook (deletion / export / retention) and the mission context provider 'browser'.
import type { BrowserModule, ContextPart, Services } from '../contracts/index.ts';
import { registerNamed } from '../kernel/registries.ts';
import { registerBrowserInternals } from './internal.ts';
import { ACTIVE, createTaskCore, createTaskRepo } from './tasks.ts';

export const SWEEP_CRON = '* * * * *';
const DAY = 86_400_000;

export function createBrowserModule(s: Services): BrowserModule {
  const repo = createTaskRepo(() => s.db, () => s.crypto);
  const core = createTaskCore(s, repo);
  registerBrowserInternals(s, core);

  s.scheduler.register('browser_sweep', async () => {
    await core.sweep();
    return { status: 'done' };
  });
  s.scheduler.schedule({ kind: 'browser_sweep', runAt: s.clock.now() + 60_000, cron: SWEEP_CRON, tz: 'UTC', dedupeKey: 'sys:browser_sweep', maxAttempts: 3 });

  s.missionHooks.push({
    name: 'browser',
    async onMissionEnded(missionId, status) {
      const t = repo.byMission(missionId);
      if (!t) return;
      await core.end(t.id, status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'cancelled');
    },
  });

  registerNamed(s.contextProviders, {
    name: 'browser',
    surfaces: ['mission'],
    async parts(conv): Promise<ContextPart[]> {
      if (conv.kind !== 'mission' || !conv.userId) return [];
      const t = repo.list(conv.userId, 5).find((x) => x.conversationId === conv.id);
      if (!t) return [];
      const lim = s.config.limits;
      const left = t.deadlineAt !== null ? Math.max(0, Math.round((t.deadlineAt - s.clock.now()) / 60_000)) : null;
      const status = t.status === 'parked' ? `parked (${t.parkReason ?? 'user'})` : t.status;
      return [{
        key: 'mission',
        lines: [`browser task ${t.id}: ${status}, step ${t.steps}/${lim.browserMaxSteps}${t.currentHost ? `, on ${t.currentHost}` : ''}${left !== null && ACTIVE.includes(t.status) ? `, ${left} min left` : ''}`],
      }];
    },
  });

  s.privacyHooks.push({
    name: 'browser',
    async onDeleteUser(userId) {
      for (const t of repo.list(userId, 100)) if (ACTIVE.includes(t.status)) await core.closeSession(t.id);
      repo.deleteForUser(userId);
    },
    async exportUser(userId) {
      // The owner's own text (goal, constraints) and metadata; never screenshots, page text or typed field values.
      return {
        browser_tasks: repo.list(userId, 100).map((t) => ({
          id: t.id, goal: t.goal, constraints: t.constraints, status: t.status, parkReason: t.parkReason, host: t.currentHost, steps: t.steps,
          startedAt: t.startedAt, finishedAt: t.finishedAt, createdAt: t.createdAt,
        })),
      };
    },
    async retentionSweep(now) {
      repo.deleteFinishedBefore(now - s.config.limits.browserTaskRetentionDays * DAY);
    },
  });

  return { tasks: core.service };
}
