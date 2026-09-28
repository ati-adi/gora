// webapp/src/screens/Plan.tsx (WP8) — current plan, usage against limits, plan cards in Stars; Upgrade →
// WebApp.openInvoice(url, cb); Cancel renewal (01 §12, F16).
import { useState } from 'react';
import { Badge, Button, Header, Meter, Notice, Section } from '../components/Card.tsx';
import { ErrorState } from '../components/Empty.tsx';
import { Row } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAction } from '../lib/actions.ts';
import { post, useApi } from '../lib/api.ts';
import { fmtDate, tDyn, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { confirm, haptic, openInvoice } from '../lib/tg.ts';

type PlanId = 'free' | 'plus' | 'pro';
interface PlanCard { id: PlanId; priceXtr: number; turnsPerDay: number; webSearchesPerDay: number; sttMinutesPerDay: number; filesPerDay: number; activeMissions: number; watchers: number; nudgeBudgetMax: number }
interface Billing { plan: PlanId; state: 'active' | 'canceled' | 'failed' | 'expired' | null; periodEnd: number | null; graceUntil: number | null; usage: Array<{ kind: string; used: number; limit: number }>; plans: PlanCard[] }

export function Plan() {
  const { t, lang } = useT();
  const { me, refresh } = useMe();
  const q = useApi<Billing>('/billing');
  const act = useAction();
  const [paid, setPaid] = useState(false);

  if (q.loading && !q.data) return <Loading rows={5} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const name = (p: PlanId) => t(p === 'plus' ? 'plan_plus' : p === 'pro' ? 'plan_pro' : 'plan_free');
  const date = (ms: number | null) => (ms ? fmtDate(ms, lang, me.user.tz) : '—');

  const upgrade = (p: PlanId) => act.run(async () => {
    const { url } = await post<{ url: string }>('/billing/invoice', { plan: p });
    const st = await openInvoice(url);
    if (st === 'paid') {
      haptic('success');
      setPaid(true);
      window.setTimeout(() => void q.reload().then(refresh), 1500);
    } else if (st === 'failed') haptic('error');
  });
  const cancel = () => act.run(async () => {
    if (!(await confirm(t('plan_cancel_confirm')))) return;
    await post('/billing/cancel');
    await q.reload();
  });

  const stateLine = d.state === 'active' ? t('plan_state_active', { date: date(d.periodEnd) })
    : d.state === 'canceled' ? t('plan_state_canceled', { date: date(d.periodEnd) })
      : d.state === 'failed' ? t('plan_state_failed', { date: date(d.graceUntil) })
        : d.state === 'expired' ? t('plan_state_expired') : null;

  return (
    <div className="page">
      <Header title={t('plan_title')} />
      {paid ? <Notice tone="ok">{t('plan_paid')}</Notice> : null}
      <Section title={t('plan_current')}>
        <Row icon="⭐" title={name(d.plan)} subtitle={stateLine ?? undefined} right={<Badge tone="accent">{t('plan_this')}</Badge>} />
        {d.plan !== 'free' && d.state === 'active' ? <Row title={t('plan_cancel')} danger chevron={false} onClick={() => void cancel()} /> : null}
      </Section>

      {d.usage.length ? (
        <Section title={t('plan_usage')}>
          <div className="card-pad meters">
            {d.usage.filter((u) => u.limit > 0).map((u) => <Meter key={u.kind} label={tDyn(t, `usage_${u.kind}`, u.kind)} used={u.used} limit={u.limit} />)}
          </div>
        </Section>
      ) : null}

      <div className="plans">
        {d.plans.map((p) => {
          const current = p.id === d.plan;
          return (
            <div key={p.id} className={current ? 'plan-card plan-card-current' : 'plan-card'}>
              <div className="plan-card-head">
                <span className="plan-card-name">{name(p.id)}</span>
                <span className="plan-card-price">{p.priceXtr > 0 ? t('plan_price', { n: p.priceXtr }) : t('plan_free_price')}</span>
              </div>
              <ul className="plan-features">
                <li>{t('plan_turns', { n: p.turnsPerDay })}</li>
                <li>{t('plan_searches', { n: p.webSearchesPerDay })}</li>
                <li>{t('plan_voice', { n: p.sttMinutesPerDay })}</li>
                <li>{t('plan_files', { n: p.filesPerDay })}</li>
                <li>{t('plan_missions', { n: p.activeMissions })}</li>
                <li>{t('plan_watchers', { n: p.watchers })}</li>
              </ul>
              {current ? <Badge tone="accent">{t('plan_this')}</Badge> : p.id !== 'free' ? (
                <Button onClick={() => void upgrade(p.id)} busy={act.busy}>{t('plan_upgrade', { plan: name(p.id) })}</Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
