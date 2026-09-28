// webapp/src/screens/Secretary.tsx (WP8) — connection status and rights, the AI default, the chat list (title, last
// message time, AI toggle, triage/draft mode, tone notes) and the consent text with its version (01 §12, F12).
// Turning AI help on (per chat or for new chats) is consent: it needs `high` freshness server-side.
import { useEffect, useState } from 'react';
import { Badge, Header, Notice, Section, Segmented } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row, RowBlock } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { Switch } from '../components/Toggle.tsx';
import { useAction } from '../lib/actions.ts';
import { patch, useApi } from '../lib/api.ts';
import { fmtRelative, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { confirm, haptic } from '../lib/tg.ts';

interface Chat { ref: string; title: string; aiEnabled: boolean; mode: 'triage' | 'draft'; lastIncomingAt: number | null; unansweredSince: number | null; windowExpiresAt: number | null; priority: number }
interface SecData {
  enabled: boolean;
  connection: { enabled: boolean; canReply: boolean; aiDefault: 'off' | 'new_chats'; connectedAt: number; consentTextVersion: string } | null;
  chats: Chat[];
}

function ChatBlock(p: { chat: Chat; focus: boolean; onChange: (c: Chat) => void }) {
  const { t, lang } = useT();
  const { me } = useMe();
  const act = useAction();
  const [tone, setTone] = useState('');
  const c = p.chat;
  const [open, setOpen] = useState(p.focus);

  const send = (body: Record<string, unknown>) => act.run(async () => {
    const r = await patch<{ chat: Chat | null }>(`/secretary/chats/${encodeURIComponent(c.ref)}`, body);
    if (r.chat) p.onChange(r.chat);
    haptic('select');
  });
  const setAi = async (on: boolean) => {
    if (on && !(await confirm(t('consent_confirm')))) return;
    await send({ aiEnabled: on });
  };

  return (
    <div className={p.focus ? 'block block-focus' : 'block'} id={`chat-${c.ref}`}>
      <button type="button" className="row tappable" onClick={() => setOpen(!open)}>
        <span className="row-icon" aria-hidden>{c.unansweredSince ? '🟠' : '💬'}</span>
        <span className="row-main">
          <span className="row-title">{c.title}</span>
          <span className="row-sub">{c.lastIncomingAt ? t('last_message', { time: fmtRelative(c.lastIncomingAt, me.now, lang) }) : '—'}</span>
        </span>
        <span className="row-right">{c.aiEnabled ? <Badge tone="accent">AI</Badge> : null}</span>
        <span className="row-chevron" aria-hidden>{open ? '⌄' : '›'}</span>
      </button>
      {open ? (
        <div className="card-pad-x stack gap">
          <div className="row row-flat">
            <span className="row-main"><span className="row-title">{t('secretary_ai')}</span></span>
            <span className="row-right"><Switch checked={c.aiEnabled} disabled={act.busy} onChange={(v) => void setAi(v)} label={t('secretary_ai')} /></span>
          </div>
          {c.aiEnabled ? (
            <>
              <span className="field-label">{t('secretary_mode')}</span>
              <Segmented value={c.mode} disabled={act.busy} onChange={(v) => void send({ mode: v })} options={[{ value: 'triage', label: t('mode_triage') }, { value: 'draft', label: t('mode_draft') }]} />
              <label className="field">
                <span className="field-label">{t('tone_notes')}</span>
                <input value={tone} maxLength={500} placeholder={t('tone_placeholder')} onChange={(e) => setTone(e.target.value)} onBlur={() => tone.trim() && void send({ toneNotes: tone.trim() })} />
              </label>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Secretary(p: { focus?: string }) {
  const { t } = useT();
  const { me } = useMe();
  const q = useApi<SecData>('/secretary');
  const act = useAction();

  useEffect(() => {
    if (!p.focus || !q.data) return;
    document.getElementById(`chat-${p.focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [p.focus, q.data]);

  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d.enabled) {
    return <div className="page"><Header title={t('secretary_title')} /><Empty icon="💼">{t('secretary_disabled')}</Empty></div>;
  }
  const conn = d.connection;

  const setDefault = (v: 'off' | 'new_chats') => act.run(async () => {
    if (v === 'new_chats' && !(await confirm(t('consent_default_confirm')))) return;
    await patch('/secretary', { aiDefault: v });
    if (conn) q.set({ ...d, connection: { ...conn, aiDefault: v } });
  });

  return (
    <div className="page">
      <Header title={t('secretary_title')} />
      {!conn ? (
        <Section title={t('secretary_status')}>
          <Row icon="💼" title={t('secretary_not_connected')} />
          <div className="card-pad muted">{t('secretary_how', { bot: me.bot.username ?? 'gora' })}</div>
        </Section>
      ) : (
        <>
          <Section title={t('secretary_status')}>
            <Row icon="💼" title={conn.enabled ? t('secretary_enabled') : t('secretary_paused')} right={<Badge tone={conn.enabled ? 'ok' : 'warn'}>{conn.enabled ? '●' : '○'}</Badge>} />
            <Row icon={conn.canReply ? '✍️' : '👀'} title={conn.canReply ? t('secretary_can_reply') : t('secretary_cannot_reply')} />
            <RowBlock>
              <div className="stack">
                <span className="field-label">{t('secretary_default')}</span>
                <Segmented value={conn.aiDefault} disabled={act.busy} onChange={(v) => void setDefault(v)} options={[{ value: 'off', label: t('secretary_default_off') }, { value: 'new_chats', label: t('secretary_default_new') }]} />
              </div>
            </RowBlock>
          </Section>
          <Section title={t('secretary_chats')} flush>
            {d.chats.length === 0 ? <Empty icon="💬">{t('secretary_chats_empty')}</Empty> : d.chats.map((c) => (
              <ChatBlock key={c.ref} chat={c} focus={p.focus === c.ref} onChange={(nc) => q.set({ ...d, chats: d.chats.map((x) => (x.ref === nc.ref ? nc : x)) })} />
            ))}
          </Section>
          <Section title={t('consent_title')} footer={t('consent_version', { v: conn.consentTextVersion })}>
            <div className="card-pad prose"><p>{t('consent_body')}</p></div>
          </Section>
        </>
      )}
      {conn && !conn.canReply ? <Notice tone="info">{t('secretary_cannot_reply')}</Notice> : null}
    </div>
  );
}
