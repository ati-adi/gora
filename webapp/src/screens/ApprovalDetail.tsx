// webapp/src/screens/ApprovalDetail.tsx (WP8) — the diff (rows and body), warnings and editable fields (gmail:
// to/cc/subject/body; calendar: title/time; business: text). Approve is the MainButton, Deny the SecondaryButton; the
// "allow 24h" checkbox shows when grantable; "Always…" links to GrantConfirm. Everything goes through
// POST /api/approvals/:id, i.e. approvals.resolve — the same compare-and-set path as the card buttons.
import { useMemo, useState } from 'react';
import { Badge, Button, Header, Notice, Section } from '../components/Card.tsx';
import { Diff } from '../components/Diff.tsx';
import { ErrorState } from '../components/Empty.tsx';
import { Loading } from '../components/Loading.tsx';
import { Switch } from '../components/Toggle.tsx';
import { useAction } from '../lib/actions.ts';
import { post, useApi } from '../lib/api.ts';
import { fmtRelative, tDyn, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { useNav } from '../lib/nav.ts';
import { haptic, hasMainButton, hasSecondaryButton, useMainButton, useSecondaryButton } from '../lib/tg.ts';
import type { ApprovalItem } from './Approvals.tsx';

const LIST_FIELDS = new Set(['to', 'cc']);
const LONG_FIELDS = new Set(['body', 'text']);

/** Prefill an editable field from the diff: a row whose label matches the field, or the body. */
function initialValue(a: ApprovalItem, field: string): string {
  if (LONG_FIELDS.has(field) && a.body) return a.body.text;
  const aliases: Record<string, string[]> = { to: ['to', 'кому'], cc: ['cc', 'копия'], subject: ['subject', 'тема'], title: ['title', 'название', 'event'], start: ['start', 'when', 'начало'], end: ['end', 'конец'], text: ['text', 'reply', 'текст'] };
  const names = aliases[field] ?? [field];
  const row = a.rows.find(([k]) => names.includes(k.trim().toLowerCase()));
  return row ? row[1] : '';
}

export function ApprovalDetail(p: { id: string }) {
  const { t, lang } = useT();
  const { me } = useMe();
  const nav = useNav();
  const q = useApi<{ item: ApprovalItem }>(`/approvals/${encodeURIComponent(p.id)}`);
  const act = useAction();
  const [allow24h, setAllow24h] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const [result, setResult] = useState<{ status: string; message: string } | null>(null);

  const a = q.data?.item ?? null;
  const pending = !!a && a.status === 'pending' && !result;
  const values = useMemo(() => fields ?? (a ? Object.fromEntries(a.editableFields.map((f) => [f, initialValue(a, f)])) : {}), [fields, a]);

  const decide = (decision: 'approve' | 'deny') => act.run(async () => {
    if (!a) return;
    const body: Record<string, unknown> = { decision, scope: decision === 'approve' && allow24h ? '24h' : 'once' };
    if (decision === 'approve' && editing && fields) {
      const changed: Record<string, string | string[]> = {};
      for (const f of a.editableFields) {
        const v = fields[f] ?? '';
        if (v === initialValue(a, f)) continue;
        changed[f] = LIST_FIELDS.has(f) ? v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean) : v;
      }
      if (Object.keys(changed).length) body['editedFields'] = changed;
    }
    const r = await post<{ status: string; message: string; item: ApprovalItem | null }>(`/approvals/${encodeURIComponent(a.id)}`, body);
    setResult({ status: r.status, message: r.message });
    haptic(decision === 'approve' && (r.status === 'executed' || r.status === 'approved') ? 'success' : r.status === 'denied' ? 'warning' : 'error');
    if (r.item) q.set({ item: r.item });
  });

  useMainButton(pending && hasMainButton() ? { text: allow24h ? t('approve_24h') : t('approve'), onClick: () => void decide('approve'), progress: act.busy, active: !act.busy } : null);
  useSecondaryButton(pending && hasSecondaryButton() ? { text: t('deny'), onClick: () => void decide('deny'), active: !act.busy } : null);

  if (q.loading && !q.data) return <Loading />;
  if (!a) return <ErrorState error={q.error} onRetry={q.reload} />;

  const statusTone = a.status === 'executed' || a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'accent' : a.status === 'denied' || a.status === 'failed' ? 'danger' : 'muted';
  const canAlways = a.grantable && a.ladderOffer;

  return (
    <div className="page">
      <Header
        title={<>🔐 {a.title}</>}
        subtitle={a.summary}
        right={<Badge tone={statusTone}>{tDyn(t, `status_${a.status}`, a.status)}</Badge>}
      />
      {result ? <Notice tone={result.status === 'executed' || result.status === 'approved' ? 'ok' : result.status === 'denied' ? 'info' : 'warn'}>{result.status === 'denied' ? t('denied_toast') : result.message || t('approved_toast')}</Notice> : null}

      <Section>
        <div className="card-pad">
          <Diff v={a} />
          {pending ? <div className="muted small top-gap">{t('expires_in', { time: fmtRelative(a.expiresAt, me.now, lang) })}</div> : null}
        </div>
      </Section>

      {pending && a.editableFields.length > 0 ? (
        <Section>
          <button type="button" className="row tappable" onClick={() => setEditing(!editing)}>
            <span className="row-icon" aria-hidden>✏️</span>
            <span className="row-main"><span className="row-title">{editing ? t('edit_hide') : t('edit_before')}</span></span>
          </button>
          {editing ? (
            <div className="card-pad form">
              {a.editableFields.map((f) => (
                <label className="field" key={f}>
                  <span className="field-label">{tDyn(t, `field_${f}`, f)}</span>
                  {LONG_FIELDS.has(f) ? (
                    <textarea rows={6} value={values[f] ?? ''} onChange={(e) => setFields({ ...values, [f]: e.target.value })} />
                  ) : (
                    <input value={values[f] ?? ''} onChange={(e) => setFields({ ...values, [f]: e.target.value })} inputMode={LIST_FIELDS.has(f) ? 'email' : 'text'} />
                  )}
                  {LIST_FIELDS.has(f) ? <span className="field-hint">{t('comma_hint')}</span> : null}
                </label>
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}

      {pending && a.grantable && a.ladderOffer ? (
        <Section footer={t('allow_24h_hint')}>
          <div className="row">
            <span className="row-icon" aria-hidden>⏱</span>
            <span className="row-main"><span className="row-title">{t('allow_24h')}</span></span>
            <span className="row-right"><Switch checked={allow24h} onChange={setAllow24h} label={t('allow_24h')} /></span>
          </div>
        </Section>
      ) : null}

      {pending && canAlways ? (
        <Section>
          <button type="button" className="row tappable" onClick={() => nav.push({ screen: 'grant', id: a.id })}>
            <span className="row-icon" aria-hidden>♾️</span>
            <span className="row-main"><span className="row-title link">{t('always_link')}</span></span>
            <span className="row-chevron" aria-hidden>›</span>
          </button>
        </Section>
      ) : null}

      {pending && !hasMainButton() ? (
        <div className="actions">
          <Button onClick={() => void decide('approve')} busy={act.busy}>{allow24h ? t('approve_24h') : t('approve')}</Button>
          <Button kind="plain" onClick={() => void decide('deny')} disabled={act.busy}>{t('deny')}</Button>
        </div>
      ) : null}
      {pending && hasMainButton() && !hasSecondaryButton() ? (
        <div className="actions">
          <Button kind="plain" onClick={() => void decide('deny')} disabled={act.busy}>{t('deny')}</Button>
        </div>
      ) : null}
    </div>
  );
}
