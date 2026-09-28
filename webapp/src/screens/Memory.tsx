// webapp/src/screens/Memory.tsx (WP8; friend mode 05 B5) — the profile card ("what I know about you": summary, people,
// goals, preferences, right now, follow-ups; each item can be corrected or deleted) above the memories grouped by kind;
// search; edit, pin, forget; the memory and incognito toggles; Import (textarea → candidates ✓/✗); "Forget everything
// from a chat"; Export (01 §12, F5).
import { useEffect, useMemo, useState } from 'react';
import { Button, Header, Section } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row, RowBlock } from '../components/List.tsx';
import { Loading, Toast } from '../components/Loading.tsx';
import { Toggle } from '../components/Toggle.tsx';
import { useAction } from '../lib/actions.ts';
import { del, get, patch, post, useApi } from '../lib/api.ts';
import { fmtDate, fmtTime, tDyn, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { useNav } from '../lib/nav.ts';
import { confirm, haptic, popup } from '../lib/tg.ts';

interface Fact { id: string; text: string; kind: string; sourceLabel: string; createdAt: number; pinned: boolean; status: 'active' | 'pending_confirm'; sensitivity: string; quote: string | null; useCount: number }
interface ProfileCard {
  summary: string;
  people: Array<{ name: string; relation: string; notes: string }>;
  goals: string[];
  preferences: string[];
  current_context: Array<{ text: string; expires_local: string | null }>;
  open_threads: Array<{ what: string; when_local: string | null; follow_up_after_local: string | null }>;
}
interface MemoryData { items: Fact[]; next: string | null; consent: boolean | null; incognitoUntil: number | null; memory?: 'on' | 'off' | 'incognito'; profile?: { version: number; card: ProfileCard } | null }
type ProfileField = 'summary' | 'people' | 'goals' | 'preferences' | 'current_context' | 'open_threads';
interface ProfileItem { field: ProfileField; index?: number; text: string; sub?: string }
interface Conv { id: string; kind: string; threadId: number | null; lastActivityAt: number }

const KIND_ORDER = ['profile', 'preference', 'person', 'relationship', 'goal', 'routine', 'date', 'fact', 'group_decision'];

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const h = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(h);
  }, [v, ms]);
  return d;
}

function ImportBox(p: { onDone: () => void }) {
  const { t } = useT();
  const act = useAction();
  const [text, setText] = useState('');
  const [cands, setCands] = useState<Array<{ id: string; text: string; keep: boolean }> | null>(null);

  const find = () => act.run(async () => {
    const r = await post<{ candidates: Array<{ id: string; text: string }> }>('/memory/import', { text });
    setCands(r.candidates.map((c) => ({ ...c, keep: true })));
  });
  const saveChoices = () => act.run(async () => {
    if (!cands) return;
    const keep = cands.filter((c) => c.keep).map((c) => c.id);
    const skip = cands.filter((c) => !c.keep).map((c) => c.id);
    if (keep.length) await post('/memory/confirm', { ids: keep, accept: true });
    if (skip.length) await post('/memory/confirm', { ids: skip, accept: false });
    haptic('success');
    setCands(null);
    setText('');
    p.onDone();
  });

  if (cands) {
    return (
      <Section title={t('import_review')}>
        {cands.length === 0 ? <Empty icon="🤷">{t('import_none')}</Empty> : cands.map((c, i) => (
          <div className="row" key={c.id}>
            <span className="row-main"><span className="row-title multiline">{c.text}</span></span>
            <span className="row-right pair">
              <button type="button" className={c.keep ? 'pick pick-on' : 'pick'} aria-label={t('import_keep')} onClick={() => setCands(cands.map((x, j) => (j === i ? { ...x, keep: true } : x)))}>✓</button>
              <button type="button" className={!c.keep ? 'pick pick-off' : 'pick'} aria-label={t('import_skip')} onClick={() => setCands(cands.map((x, j) => (j === i ? { ...x, keep: false } : x)))}>✗</button>
            </span>
          </div>
        ))}
        <RowBlock>
          <Button onClick={() => void saveChoices()} busy={act.busy}>{t('import_save')}</Button>
        </RowBlock>
      </Section>
    );
  }
  return (
    <Section title={t('import_title')} footer={t('import_hint')}>
      <div className="card-pad form">
        <textarea rows={3} value={text} maxLength={50_000} onChange={(e) => setText(e.target.value)} />
        <Button onClick={() => void find()} disabled={text.trim().length < 3} busy={act.busy}>{t('import_button')}</Button>
      </div>
    </Section>
  );
}

/** The card's items as rows, in the order they are shown. */
function profileItems(c: ProfileCard): Array<{ field: ProfileField; items: ProfileItem[] }> {
  return [
    { field: 'summary', items: c.summary ? [{ field: 'summary', text: c.summary }] : [] },
    { field: 'people', items: c.people.map((p, i) => ({ field: 'people', index: i, text: p.name, sub: [p.relation, p.notes].filter(Boolean).join(' · ') })) },
    { field: 'goals', items: c.goals.map((g, i) => ({ field: 'goals', index: i, text: g })) },
    { field: 'preferences', items: c.preferences.map((g, i) => ({ field: 'preferences', index: i, text: g })) },
    { field: 'current_context', items: c.current_context.map((x, i) => ({ field: 'current_context', index: i, text: x.text })) },
    { field: 'open_threads', items: c.open_threads.map((x, i) => ({ field: 'open_threads', index: i, text: x.what, ...(x.when_local ? { sub: x.when_local.replace('T', ' ') } : {}) })) },
  ];
}

const FIELD_TITLE = { summary: 'profile_summary', people: 'profile_people', goals: 'profile_goals', preferences: 'profile_preferences', current_context: 'profile_context', open_threads: 'profile_threads' } as const;

function ProfileCardView(p: { card: ProfileCard; onChanged: () => Promise<void> }) {
  const { t } = useT();
  const act = useAction();
  const [editing, setEditing] = useState<ProfileItem | null>(null);
  const target = (it: ProfileItem) => (it.index === undefined ? { field: it.field } : { field: it.field, index: it.index });
  const remove = (it: ProfileItem) => act.run(async () => {
    await patch('/memory/profile', { op: 'delete', ...target(it) });
    haptic('success');
    await p.onChanged();
  });
  const saveEdit = () => act.run(async () => {
    if (!editing || !editing.text.trim()) return;
    await patch('/memory/profile', { op: 'correct', ...target(editing), text: editing.text.trim() });
    setEditing(null);
    await p.onChanged();
  });
  const menu = async (it: ProfileItem) => {
    const id = await popup({
      message: it.text.length > 200 ? `${it.text.slice(0, 200)}…` : it.text,
      buttons: [{ id: 'correct', text: t('profile_correct') }, { id: 'delete', text: t('profile_delete'), type: 'destructive' }],
    });
    if (id === 'correct') setEditing(it);
    if (id === 'delete') void remove(it);
  };
  const sections = profileItems(p.card).filter((x) => x.items.length > 0);
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((sec, n) => (
        <Section key={sec.field} title={n === 0 ? t('profile_title') : t(FIELD_TITLE[sec.field])} {...(n === 0 ? { footer: t('profile_hint') } : {})}>
          {sec.items.map((it) =>
            editing && editing.field === it.field && editing.index === it.index ? (
              <div className="card-pad form" key={`${it.field}-${it.index ?? 0}`}>
                <textarea rows={3} value={editing.text} maxLength={it.field === 'summary' ? 600 : 300} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                <div className="pair-buttons">
                  <Button small onClick={() => void saveEdit()} busy={act.busy} disabled={!editing.text.trim()}>{t('save')}</Button>
                  <Button small kind="plain" onClick={() => setEditing(null)}>{t('cancel')}</Button>
                </div>
              </div>
            ) : (
              <Row key={`${it.field}-${it.index ?? 0}`} title={it.text} {...(it.sub ? { subtitle: it.sub } : {})} multiline chevron={false} onClick={() => void menu(it)} />
            ),
          )}
        </Section>
      ))}
    </>
  );
}

function ForgetChats() {
  const { t, lang } = useT();
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const q = useApi<{ items: Conv[] }>(open ? '/memory/conversations' : null);
  const act = useAction();
  const [toast, setToast] = useState<string | null>(null);
  const forget = (c: Conv) => act.run(async () => {
    if (!(await confirm(t('forget_chat_confirm')))) return;
    await post('/memory/forget-conversation', { conversationId: c.id });
    haptic('success');
    setToast(t('memory_forgotten'));
  });
  return (
    <Section title={t('forget_chat_title')} footer={t('forget_chat_hint')}>
      {!open ? <Row icon="🧽" title={t('choose_chat')} onClick={() => setOpen(true)} /> : null}
      {open && q.loading ? <div className="card-pad muted">{t('loading')}</div> : null}
      {open && q.data ? q.data.items.map((c) => (
        <Row key={c.id} icon={c.kind === 'group' ? '👥' : c.kind === 'mission' ? '🎯' : '💬'} title={tDyn(t, `conv_${c.kind}`, c.kind) + (c.threadId ? ` #${c.threadId}` : '')} subtitle={fmtTime(c.lastActivityAt, lang, me.user.tz)} right={<span className="text-danger small">{t('memory_forget')}</span>} onClick={() => void forget(c)} />
      )) : null}
      <Toast text={toast} />
    </Section>
  );
}

export function Memory() {
  const { t, lang } = useT();
  const { me } = useMe();
  const nav = useNav();
  const [search, setSearch] = useState('');
  const qd = useDebounced(search.trim(), 300);
  const q = useApi<MemoryData>(`/memory${qd ? `?q=${encodeURIComponent(qd)}` : ''}`);
  const act = useAction();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [extra, setExtra] = useState<Fact[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; k: number } | null>(null);

  useEffect(() => {
    setExtra([]);
    setNext(q.data?.next ?? null);
  }, [q.data]);

  const all = useMemo(() => [...(q.data?.items ?? []), ...extra], [q.data, extra]);
  const pendingFacts = all.filter((f) => f.status === 'pending_confirm');
  const groups = useMemo(() => {
    const active = all.filter((f) => f.status === 'active');
    const by = new Map<string, Fact[]>();
    for (const f of active) by.set(f.kind, [...(by.get(f.kind) ?? []), f]);
    for (const list of by.values()) list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
    return [...by.entries()].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]));
  }, [all]);

  if (q.loading && !q.data) return <Loading rows={6} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;

  const loadMore = () => act.run(async () => {
    if (!next) return;
    const r = await get<MemoryData>(`/memory?cursor=${encodeURIComponent(next)}${qd ? `&q=${encodeURIComponent(qd)}` : ''}`);
    setExtra((x) => [...x, ...r.items]);
    setNext(r.next);
  });
  const setConsent = (on: boolean) => act.run(async () => {
    await patch('/memory/consent', { on });
    q.set({ ...d, consent: on, memory: on ? (d.incognitoUntil ? 'incognito' : 'on') : 'off' });
  });
  const setIncognito = (on: boolean) => act.run(async () => {
    const r = await post<{ incognitoUntil: number | null }>('/memory/incognito', { on });
    q.set({ ...d, incognitoUntil: r.incognitoUntil });
  });
  const forget = (f: Fact) => act.run(async () => {
    if (!(await confirm(t('memory_forget_confirm')))) return;
    await del(`/memory/${encodeURIComponent(f.id)}`);
    haptic('success');
    setToast({ text: t('memory_forgotten'), k: Date.now() });
    await q.reload();
  });
  const pin = (f: Fact) => act.run(async () => {
    await patch(`/memory/${encodeURIComponent(f.id)}`, { pinned: !f.pinned });
    await q.reload();
  });
  const saveEdit = () => act.run(async () => {
    if (!editing) return;
    await patch(`/memory/${encodeURIComponent(editing.id)}`, { text: editing.text });
    setEditing(null);
    await q.reload();
  });
  const confirmFact = (f: Fact, accept: boolean) => act.run(async () => {
    await post('/memory/confirm', { ids: [f.id], accept });
    await q.reload();
  });
  const menu = async (f: Fact) => {
    const id = await popup({
      message: f.text.length > 200 ? `${f.text.slice(0, 200)}…` : f.text,
      buttons: [{ id: 'pin', text: f.pinned ? t('memory_unpin') : t('memory_pin') }, { id: 'edit', text: t('edit') }, { id: 'forget', text: t('memory_forget'), type: 'destructive' }],
    });
    if (id === 'pin') void pin(f);
    if (id === 'edit') setEditing({ id: f.id, text: f.text });
    if (id === 'forget') void forget(f);
  };

  return (
    <div className="page">
      <Header title={t('memory_title')} />
      <Section footer={t('memory_on_hint')}>
        {/* spec 05 B1: memory is on unless the owner turned it off (never asked = on) */}
        <Toggle icon="🧠" title={t('memory_on')} {...(d.consent === false ? { subtitle: t('memory_state_off_hint') } : {})} checked={d.consent !== false} onChange={setConsent} disabled={act.busy} />
        <Toggle icon="🕶️" title={t('incognito')} subtitle={d.incognitoUntil ? t('incognito_until', { time: fmtTime(d.incognitoUntil, lang, me.user.tz) }) : t('incognito_hint')} checked={d.incognitoUntil !== null} onChange={setIncognito} disabled={act.busy} />
      </Section>

      {d.profile ? <ProfileCardView card={d.profile.card} onChanged={q.reload} /> : null}

      <div className="search">
        <input type="search" placeholder={t('memory_search')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {pendingFacts.length > 0 ? (
        <Section title={t('memory_pending')}>
          {pendingFacts.map((f) => (
            <div className="row" key={f.id}>
              <span className="row-main"><span className="row-title multiline">{f.text}</span><span className="row-sub">{t('memory_source', { label: f.sourceLabel })}</span></span>
              <span className="row-right pair">
                <button type="button" className="pick pick-on" aria-label={t('import_keep')} onClick={() => void confirmFact(f, true)}>✓</button>
                <button type="button" className="pick pick-off" aria-label={t('import_skip')} onClick={() => void confirmFact(f, false)}>✗</button>
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      {groups.length === 0 && pendingFacts.length === 0 ? <Empty icon="🧠">{t('memory_empty')}</Empty> : null}
      {groups.map(([kind, facts]) => (
        <Section key={kind} title={tDyn(t, `kind_${kind}`, kind)}>
          {facts.map((f) =>
            editing?.id === f.id ? (
              <div className="card-pad form" key={f.id}>
                <textarea rows={3} value={editing.text} maxLength={1000} onChange={(e) => setEditing({ id: f.id, text: e.target.value })} />
                <div className="pair-buttons">
                  <Button small onClick={() => void saveEdit()} busy={act.busy} disabled={!editing.text.trim()}>{t('save')}</Button>
                  <Button small kind="plain" onClick={() => setEditing(null)}>{t('cancel')}</Button>
                </div>
              </div>
            ) : (
              <Row
                key={f.id}
                {...(f.pinned ? { icon: '📌' } : f.sensitivity === 'sensitive' ? { icon: '🔒' } : {})}
                title={f.text}
                multiline
                subtitle={`${f.sourceLabel || fmtDate(f.createdAt, lang, me.user.tz)}${f.useCount ? ` · ${t('memory_used', { n: f.useCount })}` : ''}`}
                                chevron={false}
                onClick={() => void menu(f)}
              />
            ),
          )}
        </Section>
      ))}
      {next ? <div className="center-row"><button type="button" className="btn btn-plain" onClick={() => void loadMore()}>{t('more')}</button></div> : null}

      <ImportBox onDone={() => void q.reload()} />
      <ForgetChats />
      <Section>
        <Row icon="⬇️" title={t('export_link')} onClick={() => nav.push({ screen: 'privacy', export: true })} />
      </Section>
      <Toast text={toast?.text ?? null} k={toast?.k ?? 0} />
    </div>
  );
}
