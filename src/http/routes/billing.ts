// http/routes/billing.ts (WP8) — Plan screen (01 §12, F16, §13):
//   GET  /api/billing                      read   plan, subscription state, usage against limits, plan cards (Stars)
//   POST /api/billing/invoice {plan}       write  → {url} for WebApp.openInvoice
//   POST /api/billing/cancel               write  cancel renewal (editUserStarSubscription, WP7a)
import { z } from 'zod';
import type { PlanId, QuotaKind, Services } from '../../contracts/index.ts';
import { auth, body, err, fresh, safely, type Api } from '../util.ts';

const Invoice = z.object({ plan: z.enum(['plus', 'pro']) });
const PLAN_IDS: readonly PlanId[] = ['free', 'plus', 'pro'];
const USAGE_KINDS: readonly QuotaKind[] = ['turn', 'web_search', 'stt_seconds', 'file', 'guest_answer', 'mission', 'watcher'];

export function registerBilling(api: Api, s: Services): void {
  api.get('/billing', (c) => {
    const { user } = auth(c);
    const status = safely(s, 'payments.status', () => s.payments.status(user.id), { plan: user.plan, state: null, periodEnd: null, graceUntil: null });
    const view = safely(s, 'quotas.view', () => s.quotas.view(user.id), null);
    return c.json({
      plan: status.plan,
      state: status.state,
      periodEnd: status.periodEnd,
      graceUntil: status.graceUntil,
      usage: view ? USAGE_KINDS.map((k) => ({ kind: k, used: view[k].used, limit: view[k].limit })) : [],
      plans: PLAN_IDS.map((id) => {
        const l = s.config.plans[id];
        return {
          id, priceXtr: l.priceXtr, turnsPerDay: l.turnsPerDay, webSearchesPerDay: l.webSearchesPerDay, sttMinutesPerDay: Math.round(l.sttSecondsPerDay / 60),
          filesPerDay: l.filesPerDay, activeMissions: l.activeMissions, watchers: l.watchers, nudgeBudgetMax: l.nudgeBudgetMax,
        };
      }),
    });
  });

  api.post('/billing/invoice', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Invoice);
    if (!b.ok) return b.res;
    if (user.plan === b.data.plan) return err(c, 409, 'already_on_plan');
    const url = await s.payments.invoiceLink(user.id, b.data.plan);
    return c.json({ url });
  });

  api.post('/billing/cancel', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    if (user.plan === 'free') return err(c, 409, 'nothing_to_cancel');
    await s.payments.cancel(user.id);
    return c.json({ ok: true, status: safely(s, 'payments.status', () => s.payments.status(user.id), null) });
  });
}
