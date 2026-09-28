// webapp/src/components/Empty.tsx (WP8) — empty states and error states (stale initData gets its own message).
import type { ReactNode } from 'react';
import type { ApiError } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { close } from '../lib/tg.ts';
import { Button } from './Card.tsx';

export function Empty(p: { icon?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{p.icon ?? '🌿'}</div>
      <div className="empty-text">{p.children}</div>
    </div>
  );
}

export function errorText(e: ApiError | null, t: ReturnType<typeof useT>['t']): string {
  if (!e) return t('error_generic');
  if (e.stale) return t('error_stale_body');
  if (e.status === 0) return t('error_network');
  if (e.status === 404) return t('error_not_found');
  if (e.status === 403) return t('error_forbidden');
  if (e.status === 429) return t('error_rate');
  return t('error_generic');
}

export function ErrorState(p: { error: ApiError | null; onRetry?: () => void }) {
  const { t } = useT();
  const stale = !!p.error?.stale;
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{stale ? '🔒' : '⚠️'}</div>
      {stale ? <div className="empty-title">{t('error_stale_title')}</div> : null}
      <div className="empty-text">{errorText(p.error, t)}</div>
      <div className="empty-actions">
        {stale ? (
          <Button onClick={close}>{t('close')}</Button>
        ) : p.onRetry ? (
          <Button kind="plain" onClick={p.onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
