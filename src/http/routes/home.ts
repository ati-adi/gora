// http/routes/home.ts (WP8) — GET /api/home (read): pending approvals count, active missions, the next 3 reminders,
// today's usage meter, the Pause / Incognito state (01 §12 Home) and, per 03 R8, the LLM provider and today's LLM budget
// (`services.llmBudget.snapshot()`).
import type { JobKind, QuotaKind, Services } from '../../contracts/index.ts';
import { auth, safely, userScope, type Api } from '../util.ts';

const REMINDER_JOBS: JobKind[] = ['reminder_fire', 'checkin_fire', 'followup_due'];
const METER_KINDS: QuotaKind[] = ['turn', 'web_search', 'stt_seconds', 'file', 'guest_answer'];

export function registerHome(api: Api, s: Services): void {
  api.get('/home', (c) => {
    const { user: u } = auth(c);
    const now = s.clock.now();
    const scope = userScope(u);
    const pending = safely(s, 'approvals.listPending', () => s.approvals.listPending(u.id), []);
    const missions = safely(s, 'missions.list', () => s.missions.list(u.id, { active: true }), []);
    const jobs = safely(s, 'scheduler.list', () => s.scheduler.list({ userId: u.id, kinds: REMINDER_JOBS, limit: 50 }), []);
    const nextAt = new Map<string, number>();
    for (const j of jobs) if (j.refId && !nextAt.has(j.refId)) nextAt.set(j.refId, j.runAt);
    const reminders = safely(s, 'reminders.list', () => s.reminders.list(scope, false), [])
      .filter((r) => r.status === 'scheduled' || r.status === 'snoozed' || nextAt.has(r.id))
      .slice(0, 3)
      .map((r) => ({ id: r.id, kind: r.kind, text: r.text, display: r.display, at: nextAt.get(r.id) ?? null, recurring: r.cron !== null }));
    const view = safely(s, 'quotas.view', () => s.quotas.view(u.id), null);
    const usage = view ? METER_KINDS.map((k) => ({ kind: k, used: view[k].used, limit: view[k].limit })) : [];
    const todosOpen = safely(s, 'todos.list', () => s.todos.apply(scope, u.id, { action: 'list' }).filter((t) => !t.done).length, 0);
    const budget = safely(s, 'llmBudget.snapshot', () => s.llmBudget.snapshot(), {});
    return c.json({
      pendingApprovals: pending.length,
      approvals: pending.slice(0, 3).map((p) => ({ id: p.id, title: p.title, summary: p.summary, expiresAt: p.expiresAt })),
      missions: missions.map((m) => ({ id: m.id, title: m.title, status: m.status, spentUsd: m.spentUsd, budgetUsd: m.budgetUsd, deadlineAt: m.deadlineAt })),
      reminders,
      todosOpen,
      usage,
      plan: u.plan,
      paused: u.status === 'paused',
      incognitoUntil: u.incognitoUntil !== null && u.incognitoUntil > now ? u.incognitoUntil : null,
      llm: {
        provider: s.profile.provider,
        profile: s.profile.id,
        transport: s.config.llm.transport,
        model: s.profile.models.main,
        budget: Object.entries(budget).map(([model, b]) => ({ model, rpdUsed: b.rpdUsed, rpdLimit: b.rpdLimit, tpmRemaining: b.tpmRemaining })),
      },
      now,
    });
  });
}
