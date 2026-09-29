// webapp/src/screens/Home.tsx (WP8) — pending approvals, active missions, the next 3 reminders, today's usage, the
// Pause / Incognito toggles (01 §12) and the provider + today's LLM budget (03 R8).
import { useEffect, useState } from 'react';
import { Badge, Card, Header, Meter, Section } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { Toggle } from '../components/Toggle.tsx';
import { useAction } from '../lib/actions.ts';
import { patch, post, useApi } from '../lib/api.ts';
import { fmtTime, tDyn, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { useNav } from '../lib/nav.ts';
import { addToHomeScreen, cloudGet, cloudSet, homeScreenStatus, openTelegramLink } from '../lib/tg.ts';

interface HomeData {
  pendingApprovals: number;
  approvals: Array<{ id: string; title: string; summary: string; expiresAt: number }>;
  missions: Array<{ id: string; title: string; status: string; spentUsd: number; budgetUsd: number }>;
  reminders: Array<{ id: string; kind: string; text: string; display: string; at: number | null; recurring: boolean }>;
  todosOpen: number;
  usage: Array<{ kind: string; used: number; limit: number }>;
  plan: string;
  paused: boolean;
  incognitoUntil: number | null;
  llm: { provider: string; profile: string; transport: string; model: string; budget: Array<{ model: string; rpdUsed: number; rpdLimit: number; tpmRemaining: number }> };
  now: number;
}

const NAV: Array<{ screen: 'tasks' | 'memory' | 'ledger' | 'connections' | 'secretary' | 'settings' | 'plan' | 'privacy'; icon: string; key: 'nav_tasks' | 'nav_memory' | 'nav_ledger' | 'nav_connections' | 'nav_secretary' | 'nav_settings' | 'nav_plan' | 'nav_privacy' }> = [
  { screen: 'tasks', icon: '🎯', key: 'nav_tasks' },
  { screen: 'memory', icon: '🧠', key: 'nav_memory' },
  { screen: 'ledger', icon: '📜', key: 'nav_ledger' },
  { screen: 'connections', icon: '🔗', key: 'nav_connections' },
  { screen: 'secretary', icon: '💼', key: 'nav_secretary' },
  { screen: 'settings', icon: '⚙️', key: 'nav_settings' },
  { screen: 'plan', icon: '⭐', key: 'nav_plan' },
  { screen: 'privacy', icon: '🛡️', key: 'nav_privacy' },
];

/** 01 §12: addToHomeScreen() is offered on the third open, tracked in CloudStorage. */
function useHomeScreenOffer(): [boolean, () => void] {
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const n = Number((await cloudGet('opens')) ?? '0') + 1;
      await cloudSet('opens', String(n));
      if (n !== 3) return;
      const st = await homeScreenStatus();
      if (alive && (st === 'missed' || st === 'unknown')) setOffer(true);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return [offer, () => setOffer(false)];
}

export function Home() {
  const { t, lang } = useT();
  const { me, refresh } = useMe();
  const nav = useNav();
  const home = useApi<HomeData>('/home');
  const act = useAction();
  const [offer, dismissOffer] = useHomeScreenOffer();

  if (home.loading && !home.data) return <Loading rows={5} />;
  if (!home.data) return <ErrorState error={home.error} onRetry={home.reload} />;
  const d = home.data;
  const tz = me.user.tz;
  // spec 07 C6: /api/me addToGroupUrl (the startgroup picker, no admin rights)
  const addToGroupUrl = me.addToGroupUrl ?? null;
  const planName = t(d.plan === 'plus' ? 'plan_plus' : d.plan === 'pro' ? 'plan_pro' : 'plan_free');

  const setPaused = (v: boolean) => act.run(async () => {
    await patch('/settings', { paused: v });
    home.set({ ...d, paused: v });
    await refresh();
  });
  const setIncognito = (v: boolean) => act.run(async () => {
    const r = await post<{ incognitoUntil: number | null }>('/memory/incognito', { on: v });
    home.set({ ...d, incognitoUntil: r.incognitoUntil });
  });

  const providerName = d.llm.transport === 'demo' ? t('provider_demo') : d.llm.provider === 'groq' ? t('provider_groq') : t('provider_anthropic');

  return (
    <div className="page">
      <Header title={t('hello', { name: me.user.firstName ?? '' })} right={<button type="button" className="plan-pill" onClick={() => nav.push({ screen: 'plan' })}>⭐ {planName}</button>} />

      {offer ? (
        <Card tone="accent">
          <div className="banner">
            <div>
              <div className="banner-title">{t('add_home_title')}</div>
              <div className="banner-text">{t('add_home_body')}</div>
            </div>
            <button type="button" className="btn btn-primary btn-small" onClick={() => { addToHomeScreen(); dismissOffer(); }}>{t('add_home_button')}</button>
          </div>
        </Card>
      ) : null}

      <Section>
        <Row
          icon="🔐"
          title={t('nav_approvals')}
          subtitle={d.pendingApprovals > 0 ? t('pending_n', { n: d.pendingApprovals }) : t('pending_none')}
          right={d.pendingApprovals > 0 ? <Badge tone="danger">{d.pendingApprovals}</Badge> : undefined}
          onClick={() => nav.push({ screen: 'approvals' })}
        />
        {d.approvals.map((a) => (
          <Row key={a.id} icon="✉️" title={a.title} subtitle={a.summary} onClick={() => nav.push({ screen: 'approval', id: a.id })} />
        ))}
      </Section>

      <div className="grid">
        {NAV.filter((n) => n.screen !== 'secretary' || me.flags.business).map((n) => (
          <button key={n.screen} type="button" className="tile tappable" onClick={() => nav.push({ screen: n.screen })}>
            <span className="tile-icon" aria-hidden>{n.icon}</span>
            <span className="tile-label">{t(n.key)}</span>
          </button>
        ))}
      </div>

      {addToGroupUrl ? (
        <Section>
          <Row icon="👥" title={t('add_to_group_title')} subtitle={t('add_to_group_subtitle')} onClick={() => openTelegramLink(addToGroupUrl)} />
        </Section>
      ) : null}

      {d.missions.length > 0 ? (
        <Section title={t('missions_active')}>
          {d.missions.map((m) => (
            <Row key={m.id} icon="🎯" title={m.title} subtitle={`${tDyn(t, `mst_${m.status}`, m.status)} · $${m.spentUsd.toFixed(2)} / $${m.budgetUsd.toFixed(2)}`} onClick={() => nav.push({ screen: 'tasks' })} />
          ))}
        </Section>
      ) : null}

      <Section title={t('next_reminders')}>
        {d.reminders.length === 0 ? <Empty icon="⏰">{t('no_reminders')}</Empty> : d.reminders.map((r) => (
          <Row key={r.id} icon={r.recurring ? '🔁' : '⏰'} title={r.text} subtitle={r.at ? fmtTime(r.at, lang, tz) : r.display} onClick={() => nav.push({ screen: 'tasks' })} />
        ))}
        {d.todosOpen > 0 ? <Row icon="☑️" title={t('todos_open', { n: d.todosOpen })} onClick={() => nav.push({ screen: 'tasks' })} /> : null}
      </Section>

      {d.usage.length > 0 ? (
        <Section title={t('usage_today')}>
          <div className="card-pad meters">
            {d.usage.filter((u) => u.kind !== 'guest_answer' || u.used > 0).map((u) => (
              <Meter key={u.kind} label={tDyn(t, `usage_${u.kind}`, u.kind)} used={u.used} limit={u.limit} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('controls')}>
        <Toggle icon="⏸️" title={t('pause')} subtitle={t('pause_hint')} checked={d.paused} onChange={setPaused} disabled={act.busy} />
        <Toggle
          icon="🕶️"
          title={t('incognito')}
          subtitle={d.incognitoUntil ? t('incognito_until', { time: fmtTime(d.incognitoUntil, lang, tz) }) : t('incognito_hint')}
          checked={d.incognitoUntil !== null}
          onChange={setIncognito}
          disabled={act.busy}
        />
      </Section>

      <Section title={t('assistant')}>
        <Row icon="🤖" title={providerName} subtitle={t('provider')} />
        <Row icon="🧩" title={<span className="mono">{d.llm.model}</span>} subtitle={t('model')} />
        <div className="card-pad meters">
          <div className="meters-title">{t('llm_budget')}</div>
          {d.llm.budget.filter((b) => b.rpdLimit > 0).length === 0 ? (
            <div className="muted small">{t('llm_budget_none')}</div>
          ) : (
            d.llm.budget.filter((b) => b.rpdLimit > 0).map((b) => (
              <Meter key={b.model} label={<span className="mono">{b.model}</span>} used={b.rpdUsed} limit={b.rpdLimit} />
            ))
          )}
        </div>
      </Section>
    </div>
  );
}
