// webapp/src/screens/GrantConfirm.tsx (WP8) — explains the risk of an `always` grant, then a step-up (01 §11.1):
// BiometricManager (enroll: requestAccess → POST /api/stepup/enroll → updateBiometricToken; then authenticate →
// POST /api/stepup/verify) or, when biometrics are unavailable (⚠U20), the typed phrase `ALWAYS <FIRST WORD>` with
// initData ≤ 5 min → POST /api/stepup/phrase. Finally POST /api/grants (high freshness; S16 re-checked server-side).
import { useEffect, useState } from 'react';
import { Button, Header, Notice, Section } from '../components/Card.tsx';
import { ErrorState } from '../components/Empty.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAction } from '../lib/actions.ts';
import { ApiError, post, useApi } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useNav } from '../lib/nav.ts';
import { bioAuthenticate, bioInit, bioRequestAccess, bioSaveToken, haptic, hasMainButton, useMainButton, type Bio } from '../lib/tg.ts';
import type { ApprovalItem } from './Approvals.tsx';

/** Same recipe as the server (http/routes/stepup.ts): 'ALWAYS <first word of the first target>'. */
export function expectedPhrase(display: string): string {
  const word = display.trim().split(/[\s@.,;:<>()"']+/u).find((w) => w.length > 0) ?? '';
  return `ALWAYS ${word}`.trim().toUpperCase();
}

export function GrantConfirm(p: { id: string }) {
  const { t } = useT();
  const nav = useNav();
  const q = useApi<{ item: ApprovalItem }>(`/approvals/${encodeURIComponent(p.id)}`);
  const act = useAction();
  const [bio, setBio] = useState<Bio | null>(null);
  const [phrase, setPhrase] = useState('');
  const [state, setState] = useState<'idle' | 'done' | 'not_eligible' | 'failed' | 'stale'>('idle');

  useEffect(() => {
    void bioInit().then(setBio);
  }, []);

  const a = q.data?.item ?? null;
  const target = a?.targets[0]?.display ?? '';
  const want = expectedPhrase(target);
  const phraseOk = phrase.trim().replace(/\s+/g, ' ').toUpperCase() === want;

  const createGrant = async (stepupGrantId: string) => {
    try {
      await post('/grants', { pendingActionId: p.id, stepupGrantId });
      haptic('success');
      setState('done');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_eligible') setState('not_eligible');
      else if (e instanceof ApiError && e.stale) setState('stale');
      else setState('failed');
      haptic('error');
    }
  };

  const viaBiometric = () => act.run(async () => {
    const reason = t('grant_title');
    let b = bio ?? (await bioInit());
    if (!b.available) return;
    if (!b.tokenSaved) {
      if (!b.accessGranted && !(await bioRequestAccess(reason))) return;
      const { token } = await post<{ token: string }>('/stepup/enroll');
      if (!(await bioSaveToken(token))) {
        setState('failed');
        return;
      }
      b = await bioInit();
      setBio(b);
    }
    const token = await bioAuthenticate(reason);
    if (!token) {
      setState('failed');
      return;
    }
    try {
      const { grantId } = await post<{ grantId: string }>('/stepup/verify', { token });
      await createGrant(grantId);
    } catch (e) {
      setState(e instanceof ApiError && e.stale ? 'stale' : 'failed');
    }
  });

  const viaPhrase = () => act.run(async () => {
    try {
      const { grantId } = await post<{ grantId: string }>('/stepup/phrase', { phrase, pendingActionId: p.id });
      await createGrant(grantId);
    } catch (e) {
      setState(e instanceof ApiError && e.stale ? 'stale' : 'failed');
    }
  });

  const bioUsable = !!bio?.available;
  useMainButton(state === 'idle' && a && hasMainButton() ? (bioUsable ? { text: t('grant_bio_button', { type: t(bio!.type === 'face' ? 'grant_bio_face' : bio!.type === 'finger' ? 'grant_bio_finger' : 'grant_bio_unknown') }), onClick: () => void viaBiometric(), progress: act.busy } : { text: t('grant_create'), onClick: () => void viaPhrase(), active: phraseOk && !act.busy, progress: act.busy }) : null);

  if (q.loading && !q.data) return <Loading />;
  if (!a) return <ErrorState error={q.error} onRetry={q.reload} />;

  if (state === 'done') {
    return (
      <div className="page">
        <Header title={t('grant_title')} />
        <Notice tone="ok">{t('grant_done')}</Notice>
        <div className="actions"><Button kind="plain" onClick={() => nav.back()}>{t('done')}</Button></div>
      </div>
    );
  }

  return (
    <div className="page">
      <Header title={<>♾️ {t('grant_title')}</>} subtitle={a.title} />
      <Section>
        <div className="card-pad prose">
          <p>{t('grant_explain', { title: a.title, target })}</p>
          <p className="muted">{t('grant_limits')}</p>
        </div>
      </Section>
      {state === 'not_eligible' ? <Notice tone="warn">{t('grant_not_eligible')}</Notice> : null}
      {state === 'failed' ? <Notice tone="danger">{t('grant_stepup_failed')}</Notice> : null}
      {state === 'stale' ? <Notice tone="warn"><b>{t('error_stale_title')}</b><br />{t('error_stale_body')}</Notice> : null}

      <Section title={t('grant_stepup')} footer={bioUsable ? t('grant_bio_note') : undefined}>
        {bioUsable && !hasMainButton() ? (
          <div className="card-pad"><Button onClick={() => void viaBiometric()} busy={act.busy}>{t('grant_bio_button', { type: t(bio!.type === 'face' ? 'grant_bio_face' : bio!.type === 'finger' ? 'grant_bio_finger' : 'grant_bio_unknown') })}</Button></div>
        ) : null}
        {!bioUsable ? (
          <div className="card-pad form">
            <label className="field">
              <span className="field-label">{t('grant_phrase_only', { phrase: want })}</span>
              <input value={phrase} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder={t('grant_phrase_placeholder')} onChange={(e) => setPhrase(e.target.value)} />
            </label>
            {!hasMainButton() ? <Button onClick={() => void viaPhrase()} disabled={!phraseOk} busy={act.busy}>{t('grant_create')}</Button> : null}
          </div>
        ) : null}
      </Section>
    </div>
  );
}
