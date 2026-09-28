// webapp/src/screens/Tasks.tsx (WP8) — missions (status, budget, Stop, +Budget), watchers (pause, resume, cancel),
// reminders (edit time, pause/resume, cancel) and to-dos (toggle) (01 §12).
import { useState } from 'react';
import { Badge, Button, Header, Meter, Section } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row, RowBlock } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAction } from '../lib/actions.ts';
import { del, patch, post, useApi } from '../lib/api.ts';
import { tDyn, useT } from '../lib/i18n.ts';
import { confirm, haptic, popup } from '../lib/tg.ts';

interface Mission { id: string; title: string; status: string; budgetUsd: number; spentUsd: number; deadlineAt: number | null; checklist: Array<{ text: string; done: boolean }> }
interface Watcher { id: string; kind: string; target: string; intervalMin: number; status: string; lastCheckedAt: number | null }
interface Reminder { id: string; kind: string; text: string; display: string; status: string; cron: string | null }
interface Todo { id: string; text: string; done: boolean; position: number }
interface TasksData { missions: Mission[]; watchers: Watcher[]; reminders: Reminder[]; todos: Todo[]; tz: string }

const LIVE_MISSION = new Set(['active', 'parked', 'budget_exhausted']);

export function Tasks() {
  const { t } = useT();
  const q = useApi<TasksData>('/tasks');
  const act = useAction();
  const [editing, setEditing] = useState<{ id: string; at: string } | null>(null);

  if (q.loading && !q.data) return <Loading rows={6} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;

  const stopMission = (m: Mission) => act.run(async () => {
    if (!(await confirm(t('mission_stop_confirm')))) return;
    await post(`/missions/${encodeURIComponent(m.id)}/stop`);
    haptic('success');
    await q.reload();
  });
  const addBudget = (m: Mission) => act.run(async () => {
    const id = await popup({ title: t('mission_add_budget'), message: m.title, buttons: [{ id: '1', text: '+$1' }, { id: '2', text: '+$2' }, { id: '5', text: '+$5' }] });
    if (!id) return;
    await post(`/missions/${encodeURIComponent(m.id)}/budget`, { usd: Number(id) });
    haptic('success');
    await q.reload();
  });
  const watcherAction = (w: Watcher, action: 'pause' | 'resume' | 'cancel') => act.run(async () => {
    if (action === 'cancel' && !(await confirm(t('watcher_cancel_confirm')))) return;
    await patch(`/watchers/${encodeURIComponent(w.id)}`, { action });
    await q.reload();
  });
  const reminderMenu = async (r: Reminder) => {
    const buttons: Array<{ id: string; text: string; type?: 'destructive' }> = [];
    if (!r.cron) buttons.push({ id: 'time', text: t('reminder_change_time') });
    else buttons.push(r.status === 'paused' ? { id: 'resume', text: t('reminder_resume') } : { id: 'pause', text: t('reminder_pause') });
    buttons.push({ id: 'cancel', text: t('reminder_cancel'), type: 'destructive' });
    const id = await popup({ message: r.text, buttons });
    if (id === 'time') setEditing({ id: r.id, at: '' });
    if (id === 'pause' || id === 'resume') void act.run(async () => {
      await patch(`/reminders/${encodeURIComponent(r.id)}`, { status: id === 'pause' ? 'paused' : 'active' });
      await q.reload();
    });
    if (id === 'cancel') void act.run(async () => {
      if (!(await confirm(t('reminder_cancel_confirm')))) return;
      await del(`/reminders/${encodeURIComponent(r.id)}`);
      await q.reload();
    });
  };
  const saveTime = () => act.run(async () => {
    if (!editing?.at) return;
    await patch(`/reminders/${encodeURIComponent(editing.id)}`, { atLocal: editing.at.slice(0, 16) });
    setEditing(null);
    haptic('success');
    await q.reload();
  });
  const toggleTodo = (td: Todo) => act.run(async () => {
    const r = await patch<{ todos: Todo[] }>(`/todos/${encodeURIComponent(td.id)}`, { done: !td.done });
    q.set({ ...d, todos: r.todos });
  });

  const missions = [...d.missions].sort((a, b) => Number(LIVE_MISSION.has(b.status)) - Number(LIVE_MISSION.has(a.status)));

  return (
    <div className="page">
      <Header title={t('tasks_title')} />

      <Section title={t('missions')}>
        {missions.length === 0 ? <Empty icon="🎯">{t('missions_empty')}</Empty> : missions.map((m) => (
          <div key={m.id} className="block">
            <Row icon="🎯" title={m.title} right={<Badge tone={m.status === 'active' ? 'accent' : m.status === 'done' ? 'ok' : m.status === 'failed' || m.status === 'budget_exhausted' ? 'danger' : 'muted'}>{tDyn(t, `mst_${m.status}`, m.status)}</Badge>} />
            <div className="card-pad-x">
              <Meter label={t('mission_budget_line', { spent: m.spentUsd.toFixed(2), budget: m.budgetUsd.toFixed(2) })} used={Math.round(m.spentUsd * 100)} limit={Math.round(m.budgetUsd * 100)} unit="¢" />
              {m.checklist.length > 0 ? (
                <ul className="checklist">
                  {m.checklist.map((c, i) => <li key={i} className={c.done ? 'done' : ''}>{c.done ? '☑' : '☐'} {c.text}</li>)}
                </ul>
              ) : null}
            </div>
            {LIVE_MISSION.has(m.status) ? (
              <RowBlock>
                <div className="pair-buttons">
                  <Button small kind="plain" onClick={() => void addBudget(m)} disabled={act.busy}>{t('mission_budget')}</Button>
                  <Button small kind="danger" onClick={() => void stopMission(m)} disabled={act.busy}>{t('mission_stop')}</Button>
                </div>
              </RowBlock>
            ) : null}
          </div>
        ))}
      </Section>

      <Section title={t('watchers')}>
        {d.watchers.length === 0 ? <Empty icon="👁">{t('watchers_empty')}</Empty> : d.watchers.map((w) => (
          <div key={w.id} className="block">
            <Row icon={w.kind === 'inbox' ? '📥' : '🌐'} title={w.target} multiline subtitle={`${tDyn(t, `wst_${w.status}`, w.status)} · ${t('watcher_every', { n: w.intervalMin })}`} />
            {w.status === 'active' || w.status === 'paused' ? (
              <RowBlock>
                <div className="pair-buttons">
                  <Button small kind="plain" onClick={() => void watcherAction(w, w.status === 'active' ? 'pause' : 'resume')} disabled={act.busy}>{w.status === 'active' ? t('watcher_pause') : t('watcher_resume')}</Button>
                  <Button small kind="danger" onClick={() => void watcherAction(w, 'cancel')} disabled={act.busy}>{t('watcher_cancel')}</Button>
                </div>
              </RowBlock>
            ) : null}
          </div>
        ))}
      </Section>

      <Section title={t('reminders')}>
        {d.reminders.length === 0 ? <Empty icon="⏰">{t('reminders_empty')}</Empty> : d.reminders.map((r) =>
          editing?.id === r.id ? (
            <div key={r.id} className="card-pad form">
              <div className="row-title">{r.text}</div>
              <input type="datetime-local" value={editing.at} onChange={(e) => setEditing({ id: r.id, at: e.target.value })} />
              <div className="muted small">{d.tz}</div>
              <div className="pair-buttons">
                <Button small onClick={() => void saveTime()} disabled={!editing.at} busy={act.busy}>{t('save')}</Button>
                <Button small kind="plain" onClick={() => setEditing(null)}>{t('cancel')}</Button>
              </div>
            </div>
          ) : (
            <Row key={r.id} icon={r.cron ? '🔁' : r.status === 'paused' ? '⏸' : '⏰'} title={r.text} multiline subtitle={`${r.display}${r.cron ? ` · ${t('reminder_recurring')}` : ''}`} onClick={() => void reminderMenu(r)} chevron={false} />
          ),
        )}
      </Section>

      <Section title={t('todos')}>
        {d.todos.length === 0 ? <Empty icon="☑️">{t('todos_empty')}</Empty> : [...d.todos].sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position).map((td) => (
          <button type="button" key={td.id} className="row tappable" onClick={() => void toggleTodo(td)} aria-pressed={td.done}>
            <span className={td.done ? 'check check-on' : 'check'} aria-hidden>{td.done ? '✓' : ''}</span>
            <span className="row-main"><span className={`row-title multiline${td.done ? ' struck' : ''}`}>{td.text}</span></span>
          </button>
        ))}
      </Section>
    </div>
  );
}
