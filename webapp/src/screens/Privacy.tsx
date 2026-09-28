// webapp/src/screens/Privacy.tsx (WP8) — what is stored, the processors and retention; Export (a single-use 5-minute
// token → WebApp.downloadFile); Delete account (typed DELETE, initData ≤ 10 min) (01 §12, §11.9).
import { useEffect, useRef, useState } from 'react';
import { Button, Header, Notice, Section } from '../components/Card.tsx';
import { ErrorState } from '../components/Empty.tsx';
import { Row } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAction } from '../lib/actions.ts';
import { post, useApi } from '../lib/api.ts';
import { tDyn, useT } from '../lib/i18n.ts';
import { close, confirm, downloadFile, haptic, hasMainButton, useMainButton } from '../lib/tg.ts';

interface Disclosure {
  stored: string[];
  processors: Array<{ name: string; purpose: string; note?: string }>;
  retention: Array<{ what: string; keep: string }>;
  noTraining: boolean; keysSeparate: boolean; cacheNote: boolean;
}

export function Privacy(p: { autoExport?: boolean }) {
  const { t } = useT();
  const q = useApi<Disclosure>('/privacy');
  const act = useAction();
  const [typed, setTyped] = useState('');
  const [exported, setExported] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const auto = useRef(false);
  const duration = (k: string): string => {
    const m = /^(\d+)([hd])$/.exec(k);
    if (!m) return k;
    return m[2] === 'h' ? t('hours_n', { n: Number(m[1]) }) : t('days_n', { n: Number(m[1]) });
  };

  const doExport = () => act.run(async () => {
    const r = await post<{ url: string; fileName: string }>('/export/token');
    const ok = await downloadFile(r.url, r.fileName);
    if (ok) {
      haptic('success');
      setExported(true);
    }
  });
  const doDelete = () => act.run(async () => {
    if (typed !== 'DELETE') return;
    if (!(await confirm(t('privacy_delete_confirm')))) return;
    await post('/account/delete', { confirm: 'DELETE' });
    haptic('success');
    setDeleted(true);
  });

  useEffect(() => {
    if (p.autoExport && !auto.current) {
      auto.current = true;
      void doExport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.autoExport]);

  useMainButton(!deleted && typed === 'DELETE' && hasMainButton() ? { text: t('privacy_delete_button'), onClick: () => void doDelete(), destructive: true, progress: act.busy } : null);

  if (deleted) {
    return (
      <div className="page">
        <Header title={t('privacy_title')} />
        <Notice tone="ok">{t('privacy_deleted')}</Notice>
        <div className="actions"><Button onClick={close}>{t('close')}</Button></div>
      </div>
    );
  }
  if (q.loading && !q.data) return <Loading rows={6} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;

  return (
    <div className="page">
      <Header title={t('privacy_title')} />

      <Section title={t('privacy_export')} footer={t('privacy_export_hint')}>
        <Row icon="⬇️" title={exported ? t('privacy_export_started') : t('privacy_export')} onClick={() => void doExport()} />
      </Section>

      <Section title={t('privacy_stored')}>
        <div className="card-pad">
          <ul className="bullets">{d.stored.map((s) => <li key={s}>{tDyn(t, `st_${s}`, s)}</li>)}</ul>
        </div>
      </Section>

      <Section title={t('privacy_processors')}>
        {d.processors.length === 0 ? <Row icon="🏠" title={t('privacy_no_processors')} multiline /> : null}
        {d.processors.map((x, i) => <Row key={i} icon="🏢" title={x.name} subtitle={[tDyn(t, `pr_${x.purpose}`, x.purpose), x.note].filter(Boolean).join(' · ')} />)}
      </Section>

      <Section title={t('privacy_retention')}>
        {d.retention.map((r) => <Row key={r.what} title={tDyn(t, `rt_${r.what}`, r.what)} multiline right={<span className="muted small nowrap">{duration(r.keep)}</span>} />)}
      </Section>

      <Section title={t('privacy_facts')}>
        <div className="card-pad">
          <ul className="bullets">
            {d.noTraining ? <li>{t('privacy_no_training')}</li> : null}
            {d.keysSeparate ? <li>{t('privacy_keys')}</li> : null}
            {d.cacheNote ? <li>{t('privacy_cache')}</li> : null}
          </ul>
        </div>
      </Section>

      <Section title={t('privacy_delete')} footer={t('privacy_delete_hint')}>
        <div className="card-pad form">
          <label className="field">
            <span className="field-label">{t('privacy_delete_type')}</span>
            <input value={typed} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="DELETE" onChange={(e) => setTyped(e.target.value)} />
          </label>
          {!hasMainButton() ? <Button kind="danger" disabled={typed !== 'DELETE'} busy={act.busy} onClick={() => void doDelete()}>{t('privacy_delete_button')}</Button> : null}
        </div>
      </Section>
    </div>
  );
}
