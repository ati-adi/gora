// webapp/src/lib/actions.ts (WP8) — run a mutation with a busy flag and user-facing error handling.
import { useCallback, useRef, useState } from 'react';
import { ApiError } from './api.ts';
import { useT } from './i18n.ts';
import { alert, haptic } from './tg.ts';

export function useAction(): { busy: boolean; run: <T>(fn: () => Promise<T>, o?: { quiet?: boolean }) => Promise<T | undefined> } {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, o?: { quiet?: boolean }): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      haptic('error');
      if (!o?.quiet) {
        const err = e instanceof ApiError ? e : null;
        let msg = t('error_generic');
        if (err?.stale) msg = `${t('error_stale_title')}\n\n${t('error_stale_body')}`;
        else if (err?.status === 0) msg = t('error_network');
        else if (err?.status === 404) msg = t('error_not_found');
        else if (err?.status === 429) msg = t('error_rate');
        await alert(msg);
      }
      if (o?.quiet) throw e;
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [t]);
  return { busy, run };
}
