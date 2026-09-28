// webapp/src/screens/Ledger.tsx (WP8) — the timeline with filters (All, Actions, Reads, Memory, Messages, Payments),
// a Planned tab (jobs, reminders, watchers, missions, pending approvals) and the chain-verified badge (01 §11.8).
import { useCallback, useEffect, useState } from 'react';
import { Badge, Chips, Header, Section, Segmented } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row } from '../components/List.tsx';
import { Loading, Spinner } from '../components/Loading.tsx';
import { ApiError, get, useApi } from '../lib/api.ts';
import { fmtDate, fmtTime, tDyn, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { useNav } from '../lib/nav.ts';
import type { ApprovalItem } from './Approvals.tsx';

type Filter = 'all' | 'actions' | 'reads' | 'memory' | 'messages' | 'payments';
interface Entry { seq: number; ts: number; actor: string; kind: string; summary: string }
interface Planned {
  jobs: Array<{ id: string; kind: string; runAt: number; recurring: boolean }>;
  reminders: Array<{ id: string; text: string; display: string; status: string; cron: string | null }>;
  watchers: Array<{ id: string; target: string; intervalMin: number; status: string }>;
  missions: Array<{ id: string; title: string; status: string }>;
  approvals: ApprovalItem[];
}

const ICON: Record<string, string> = {
  tool_call: '🛠', data_read: '👀', approval_requested: '🔐', approval_resolved: '✅', message_sent: '💬', email_sent: '📧', draft_created: '📝',
  calendar_changed: '📅', memory_saved: '🧠', memory_forgotten: '🧽', connection: '🔗', permission_change: '🎚', grant_change: '♾️', business_event: '💼',
  nudge_sent: '💡', mission: '🎯', payment: '⭐', export: '⬇️', deletion: '🗑', consent: '🤝', pause: '⏸', refusal: '🙅', fallback_served: '↪️',
  undo: '↩️', settings: '⚙️', guard_block: '🛡',
};

function Timeline() {
  const { t, lang } = useT();
  const { me } = useMe();
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<Entry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const verify = useApi<{ ok: boolean; brokenAtSeq: number | null }>('/ledger/verify');

  const load = useCallback(async (f: Filter, cursor: number | null) => {
    setLoading(true);
    try {
      const r = await get<{ items: Entry[]; next: number | null }>(`/ledger?filter=${f}&limit=50${cursor !== null ? `&cursor=${cursor}` : ''}`);
      setItems((prev) => (cursor === null ? r.items : [...prev, ...r.items]));
      setNext(r.next);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(filter, null);
  }, [filter, load]);

  const groups: Array<{ day: string; entries: Entry[] }> = [];
  for (const e of items) {
    const day = fmtDate(e.ts, lang, me.user.tz);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.entries.push(e);
    else groups.push({ day, entries: [e] });
  }

  return (
    <>
      {verify.data ? (
        <div className="center-row">
          <Badge tone={verify.data.ok ? 'ok' : 'danger'}>{verify.data.ok ? t('ledger_verified') : t('ledger_broken', { seq: verify.data.brokenAtSeq ?? '?' })}</Badge>
        </div>
      ) : null}
      <Chips<Filter>
        value={filter}
        onChange={setFilter}
        options={(['all', 'actions', 'reads', 'memory', 'messages', 'payments'] as const).map((f) => ({ value: f, label: t(`filter_${f}`) }))}
      />
      {error && items.length === 0 ? <ErrorState error={error} onRetry={() => void load(filter, null)} /> : null}
      {loading && items.length === 0 ? <Loading rows={6} /> : null}
      {!loading && !error && items.length === 0 ? <Empty icon="📜">{t('ledger_empty')}</Empty> : null}
      {groups.map((g) => (
        <Section key={g.day} title={g.day}>
          {g.entries.map((e) => (
            <Row
              key={e.seq}
              icon={ICON[e.kind] ?? '•'}
              title={e.summary}
              multiline
              subtitle={`${tDyn(t, `actor_${e.actor}`, e.actor)} · ${fmtTime(e.ts, lang, me.user.tz)} · #${e.seq}`}
            />
          ))}
        </Section>
      ))}
      {next !== null ? (
        <div className="center-row">
          {loading ? <Spinner /> : <button type="button" className="btn btn-plain" onClick={() => void load(filter, next)}>{t('more')}</button>}
        </div>
      ) : null}
    </>
  );
}

function PlannedTab() {
  const { t, lang } = useT();
  const { me } = useMe();
  const nav = useNav();
  const q = useApi<Planned>('/ledger/planned');
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const empty = d.jobs.length + d.reminders.length + d.watchers.length + d.missions.length + d.approvals.length === 0;
  if (empty) return <Empty icon="🗓">{t('planned_empty')}</Empty>;
  return (
    <>
      {d.approvals.length ? (
        <Section title={t('nav_approvals')}>
          {d.approvals.map((a) => <Row key={a.id} icon="🔐" title={a.title} subtitle={a.summary} onClick={() => nav.push({ screen: 'approval', id: a.id })} />)}
        </Section>
      ) : null}
      {d.reminders.length ? (
        <Section title={t('reminders')}>
          {d.reminders.map((r) => <Row key={r.id} icon={r.cron ? '🔁' : '⏰'} title={r.text} subtitle={r.display} />)}
        </Section>
      ) : null}
      {d.missions.length ? (
        <Section title={t('missions')}>
          {d.missions.map((m) => <Row key={m.id} icon="🎯" title={m.title} subtitle={tDyn(t, `mst_${m.status}`, m.status)} onClick={() => nav.push({ screen: 'tasks' })} />)}
        </Section>
      ) : null}
      {d.watchers.length ? (
        <Section title={t('watchers')}>
          {d.watchers.map((w) => <Row key={w.id} icon="👁" title={w.target} subtitle={`${tDyn(t, `wst_${w.status}`, w.status)} · ${t('watcher_every', { n: w.intervalMin })}`} />)}
        </Section>
      ) : null}
      {d.jobs.length ? (
        <Section title={t('planned_jobs')}>
          {d.jobs.map((j) => <Row key={j.id} icon={j.recurring ? '🔁' : '🕒'} title={j.kind.replace(/_/g, ' ')} subtitle={fmtTime(j.runAt, lang, me.user.tz)} />)}
        </Section>
      ) : null}
    </>
  );
}

export function Ledger() {
  const { t } = useT();
  const [tab, setTab] = useState<'timeline' | 'planned'>('timeline');
  return (
    <div className="page">
      <Header title={t('ledger_title')} />
      <Segmented value={tab} onChange={setTab} options={[{ value: 'timeline', label: t('ledger_timeline') }, { value: 'planned', label: t('ledger_planned') }]} />
      <div className="top-gap">{tab === 'timeline' ? <Timeline /> : <PlannedTab />}</div>
    </div>
  );
}
