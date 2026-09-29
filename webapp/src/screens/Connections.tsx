// webapp/src/screens/Connections.tsx (WP8) — Gmail and Calendar (status, level selector, connect, disconnect), the
// grants list with revoke, and trusted contacts (add, remove) (01 §12, F9, §11.2).
import { useState } from 'react';
import { Badge, Button, Header, Notice, Section } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row, RowBlock } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAction } from '../lib/actions.ts';
import { del, patch, post, useApi } from '../lib/api.ts';
import { fmtTime, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { confirm, haptic, openLink } from '../lib/tg.ts';

type Level = 'none' | 'read' | 'draft' | 'act';
interface ConnData {
  provider: string | null;
  /** `pending` (s07 B1): a connect link is still being polled; the connection completes on its own. */
  integrations: Array<{ kind: 'gmail' | 'gcal'; connected: boolean; level: Level; pending?: boolean }>;
  grants: Array<{ id: string; toolName: string; scope: '24h' | 'always'; expiresAt: number | null }>;
  trusted: Array<{ hmac: string; kind: string; value: string; source: string; createdAt: number }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function Connections() {
  const { t, lang } = useT();
  const { me } = useMe();
  const q = useApi<ConnData>('/connections');
  const act = useAction();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<string | null>(null);

  if (q.loading && !q.data) return <Loading rows={5} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const svc = (k: 'gmail' | 'gcal') => t(k);
  const waiting = lang === 'ru' ? 'ожидаю подключения…' : 'waiting for the connection…';

  const connect = (k: 'gmail' | 'gcal') => act.run(async () => {
    const { url } = await post<{ url: string }>(`/connections/${k}/link`);
    openLink(url);
    setNote(t('connect_opened'));
  });
  const disconnect = (k: 'gmail' | 'gcal') => act.run(async () => {
    if (!(await confirm(t('disconnect_confirm', { service: svc(k) })))) return;
    await del(`/connections/${k}`);
    await q.reload();
  });
  const setLevel = (k: 'gmail' | 'gcal', level: Exclude<Level, 'none'>) => act.run(async () => {
    await patch(`/connections/${k}`, { level });
    haptic('select');
    q.set({ ...d, integrations: d.integrations.map((i) => (i.kind === k ? { ...i, level } : i)) });
  });
  const revoke = (id: string) => act.run(async () => {
    if (!(await confirm(t('revoke_confirm')))) return;
    await del(`/grants/${encodeURIComponent(id)}`);
    await q.reload();
  });
  const addTrusted = () => act.run(async () => {
    const v = email.trim();
    if (!EMAIL.test(v)) {
      setNote(t('trusted_invalid'));
      return;
    }
    const r = await post<{ items: ConnData['trusted'] }>('/trusted-targets', { kind: 'email', value: v });
    q.set({ ...d, trusted: r.items });
    setEmail('');
    setNote(null);
  });
  const removeTrusted = (h: string) => act.run(async () => {
    const r = await del<{ items: ConnData['trusted'] }>(`/trusted-targets/${encodeURIComponent(h)}`);
    q.set({ ...d, trusted: r.items });
  });

  return (
    <div className="page">
      <Header title={t('connections_title')} />
      {note ? <Notice tone="info">{note}</Notice> : null}
      {d.provider === null ? <Notice tone="warn">{t('integrations_off')}</Notice> : null}

      {d.integrations.map((i) => (
        <Section key={i.kind} title={svc(i.kind)} footer={i.connected ? t('level_hint') : undefined}>
          <Row icon={i.kind === 'gmail' ? '📧' : '📅'} title={svc(i.kind)} right={<Badge tone={i.connected ? 'ok' : 'muted'}>{i.connected ? t('connected') : i.pending ? waiting : t('not_connected')}</Badge>} />
          {i.connected ? (
            <>
              <div className="subhead">{t('level')}</div>
              {(['read', 'draft', 'act'] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={i.level === l} className="row tappable" disabled={act.busy} onClick={() => i.level !== l && void setLevel(i.kind, l)}>
                  <span className="row-main"><span className="row-title">{t(`level_${l}`)}</span></span>
                  {i.level === l ? <span className="row-right tick" aria-hidden>✓</span> : null}
                </button>
              ))}
              <Row title={t('disconnect')} danger onClick={() => void disconnect(i.kind)} chevron={false} />
            </>
          ) : d.provider !== null ? (
            <RowBlock><Button onClick={() => void connect(i.kind)} busy={act.busy}>{t('connect')}</Button></RowBlock>
          ) : null}
        </Section>
      ))}

      <Section title={t('grants')}>
        {d.grants.length === 0 ? <Empty icon="♾️">{t('grants_empty')}</Empty> : d.grants.map((g) => (
          <Row
            key={g.id}
            icon={g.scope === 'always' ? '♾️' : '⏱'}
            title={g.toolName.replace(/_/g, ' ')}
            subtitle={g.scope === 'always' ? t('grant_always') : g.expiresAt ? t('grant_until', { time: fmtTime(g.expiresAt, lang, me.user.tz) }) : t('grant_24h')}
            right={<span className="text-danger small">{t('revoke')}</span>}
            onClick={() => void revoke(g.id)}
            chevron={false}
          />
        ))}
      </Section>

      <Section title={t('trusted')} footer={t('trusted_hint')}>
        {d.trusted.length === 0 ? <Empty icon="🤝">{t('trusted_empty')}</Empty> : d.trusted.map((x) => (
          <Row key={x.hmac} icon={x.kind === 'email' ? '✉️' : '👤'} title={x.value} subtitle={x.source.replace(/_/g, ' ')} right={<button type="button" className="icon-btn" aria-label={t('remove')} onClick={() => void removeTrusted(x.hmac)}>✕</button>} />
        ))}
        <RowBlock>
          <div className="inline-form">
            <input type="email" inputMode="email" autoComplete="off" placeholder={t('trusted_placeholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button small onClick={() => void addTrusted()} disabled={!email.trim()} busy={act.busy}>{t('add')}</Button>
          </div>
        </RowBlock>
      </Section>
    </div>
  );
}
