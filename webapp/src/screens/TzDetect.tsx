// webapp/src/screens/TzDetect.tsx (WP8; friend mode 05 A6) — the lazy "set my time zone" button opens this: it POSTs
// Intl…timeZone automatically, shows ✓, then close()s the Mini App (no further steps).
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Card.tsx';
import { errorText } from '../components/Empty.tsx';
import { Spinner } from '../components/Loading.tsx';
import { ApiError, post } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useNav } from '../lib/nav.ts';
import { close, haptic } from '../lib/tg.ts';

export function TzDetect() {
  const { t } = useT();
  const nav = useNav();
  const [state, setState] = useState<{ kind: 'busy' } | { kind: 'done'; tz: string } | { kind: 'error'; err: ApiError | null }>({ kind: 'busy' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = '';
    }
    if (!tz) {
      setState({ kind: 'error', err: null });
      return;
    }
    void post('/settings/tz', { tz })
      .then(() => {
        haptic('success');
        setState({ kind: 'done', tz });
        window.setTimeout(close, 1200);
      })
      .catch((e: unknown) => {
        haptic('error');
        setState({ kind: 'error', err: e instanceof ApiError ? e : null });
      });
  }, []);

  return (
    <div className="page page-center">
      {state.kind === 'busy' ? (
        <>
          <Spinner />
          <p className="muted">{t('tz_detecting')}</p>
        </>
      ) : state.kind === 'done' ? (
        <>
          <div className="big-check" aria-hidden>✓</div>
          <h1 className="center">{t('tz_done', { tz: state.tz.replace(/_/g, ' ') })}</h1>
          <p className="muted center">{t('tz_closing')}</p>
          <Button kind="plain" onClick={close}>{t('close')}</Button>
        </>
      ) : (
        <>
          <div className="empty-icon" aria-hidden>🕒</div>
          <p className="center">{state.err ? errorText(state.err, t) : t('tz_failed')}</p>
          <Button onClick={() => nav.replace({ screen: 'settings' })}>{t('tz_pick')}</Button>
        </>
      )}
    </div>
  );
}
