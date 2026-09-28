// webapp/src/lib/tg.ts (WP8) — a thin, defensive wrapper over Telegram.WebApp (01 §12 "UI conventions").
// Every call checks availability and the client's Bot API version, so older clients degrade instead of throwing.
import { useEffect, useRef } from 'react';

type WebApp = typeof window.Telegram.WebApp;

export function wa(): WebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function atLeast(v: string): boolean {
  const w = wa();
  try {
    return !!w && w.isVersionAtLeast(v);
  } catch {
    return false;
  }
}

/** Raw initData for `Authorization: tma …` (empty outside Telegram or from a keyboard button). */
export function initData(): string {
  return wa()?.initData ?? '';
}

export function tgUser(): { id: number; first_name: string; language_code?: string } | null {
  const u = wa()?.initDataUnsafe?.user;
  return u ? { id: u.id, first_name: u.first_name, ...(u.language_code ? { language_code: u.language_code } : {}) } : null;
}

export function startParam(): string | null {
  const w = wa();
  const p = w?.initDataUnsafe?.start_param;
  if (p) return p;
  try {
    return new URLSearchParams(window.location.search).get('tgWebAppStartParam');
  } catch {
    return null;
  }
}

export function boot(): void {
  const w = wa();
  if (!w) return;
  try {
    w.ready();
    w.expand();
    if (atLeast('6.1')) {
      w.setHeaderColor('secondary_bg_color');
      w.setBackgroundColor('secondary_bg_color');
    }
    if (atLeast('7.10')) w.setBottomBarColor('secondary_bg_color');
    if (atLeast('7.7')) w.disableVerticalSwipes();
  } catch {
    /* older client */
  }
  document.documentElement.dataset['scheme'] = w.colorScheme;
  w.onEvent('themeChanged', () => {
    document.documentElement.dataset['scheme'] = w.colorScheme;
  });
}

export function haptic(kind: 'success' | 'error' | 'warning' | 'select' | 'light'): void {
  const h = wa()?.HapticFeedback;
  if (!h || !atLeast('6.1')) return;
  try {
    if (kind === 'select') h.selectionChanged();
    else if (kind === 'light') h.impactOccurred('light');
    else h.notificationOccurred(kind);
  } catch {
    /* ignore */
  }
}

export function confirm(message: string): Promise<boolean> {
  const w = wa();
  if (w && atLeast('6.2')) return new Promise((res) => w.showConfirm(message, (ok) => res(!!ok)));
  return Promise.resolve(window.confirm(message));
}

export function alert(message: string): Promise<void> {
  const w = wa();
  if (w && atLeast('6.2')) return new Promise((res) => w.showAlert(message, () => res()));
  window.alert(message);
  return Promise.resolve();
}

/** A native popup with up to 3 buttons; resolves with the pressed id ('' when dismissed). */
export function popup(p: { title?: string; message: string; buttons: Array<{ id: string; text: string; type?: 'default' | 'destructive' | 'cancel' }> }): Promise<string> {
  const w = wa();
  if (w && atLeast('6.2')) {
    return new Promise((res) => w.showPopup({ ...(p.title ? { title: p.title } : {}), message: p.message, buttons: p.buttons.slice(0, 3).map((b) => (b.type === 'cancel' ? { id: b.id, type: 'cancel' as const } : { id: b.id, type: b.type ?? 'default', text: b.text })) as never }, (id) => res(id ?? '')));
  }
  const first = p.buttons.find((b) => b.type !== 'cancel');
  return Promise.resolve(first && window.confirm(`${p.message}\n\n${first.text}?`) ? first.id : '');
}

export function openLink(url: string): void {
  const w = wa();
  if (w) w.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function openTelegramLink(url: string): void {
  const w = wa();
  if (w && atLeast('6.1')) w.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function openInvoice(url: string): Promise<'paid' | 'cancelled' | 'failed' | 'pending'> {
  const w = wa();
  if (!w || !atLeast('6.1')) {
    openLink(url);
    return Promise.resolve('pending');
  }
  return new Promise((res) => w.openInvoice(url, (st) => res(st)));
}

/** WebApp.downloadFile (8.0+); falls back to opening the URL. */
export function downloadFile(url: string, fileName: string): Promise<boolean> {
  const w = wa();
  if (w && atLeast('8.0')) return new Promise((res) => w.downloadFile({ url, file_name: fileName }, (ok) => res(!!ok)));
  openLink(url);
  return Promise.resolve(true);
}

export function close(): void {
  wa()?.close();
}

// ── CloudStorage (6.9+), with a localStorage fallback outside Telegram
export function cloudGet(key: string): Promise<string | null> {
  const w = wa();
  if (w && atLeast('6.9')) return new Promise((res) => w.CloudStorage.getItem(key, (e, v) => res(e ? null : (v ?? null))));
  try {
    return Promise.resolve(window.localStorage.getItem(`gora:${key}`));
  } catch {
    return Promise.resolve(null);
  }
}
export function cloudSet(key: string, value: string): Promise<void> {
  const w = wa();
  if (w && atLeast('6.9')) return new Promise((res) => w.CloudStorage.setItem(key, value, () => res()));
  try {
    window.localStorage.setItem(`gora:${key}`, value);
  } catch {
    /* ignore */
  }
  return Promise.resolve();
}

// ── Home screen (8.0+)
export function homeScreenStatus(): Promise<'unsupported' | 'unknown' | 'added' | 'missed'> {
  const w = wa();
  if (!w || !atLeast('8.0')) return Promise.resolve('unsupported');
  return new Promise((res) => w.checkHomeScreenStatus((st) => res(st)));
}
export function addToHomeScreen(): void {
  const w = wa();
  if (w && atLeast('8.0')) w.addToHomeScreen();
}

// ── BiometricManager (7.2+). Proves possession of a device-stored token released after a local biometric check.
export interface Bio { available: boolean; type: string; tokenSaved: boolean; accessGranted: boolean }
export function bioInit(): Promise<Bio> {
  const w = wa();
  if (!w || !atLeast('7.2') || !w.BiometricManager) return Promise.resolve({ available: false, type: 'unknown', tokenSaved: false, accessGranted: false });
  const bm = w.BiometricManager;
  return new Promise((res) => {
    const done = () => res({ available: bm.isBiometricAvailable, type: bm.biometricType, tokenSaved: bm.isBiometricTokenSaved, accessGranted: bm.isAccessGranted });
    if (bm.isInited) done();
    else bm.init(done);
  });
}
export function bioRequestAccess(reason: string): Promise<boolean> {
  const bm = wa()?.BiometricManager;
  if (!bm) return Promise.resolve(false);
  return new Promise((res) => bm.requestAccess({ reason }, (ok) => res(!!ok)));
}
export function bioSaveToken(token: string): Promise<boolean> {
  const bm = wa()?.BiometricManager;
  if (!bm) return Promise.resolve(false);
  return new Promise((res) => bm.updateBiometricToken(token, (ok) => res(!!ok)));
}
export function bioAuthenticate(reason: string): Promise<string | null> {
  const bm = wa()?.BiometricManager;
  if (!bm) return Promise.resolve(null);
  return new Promise((res) => bm.authenticate({ reason }, (ok, token) => res(ok && token ? token : null)));
}

// ── React hooks for the Telegram chrome

/** Shows the BackButton while `onBack` is set. */
export function useBackButton(onBack: (() => void) | null): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  const visible = onBack !== null;
  useEffect(() => {
    const w = wa();
    if (!w || !atLeast('6.1')) return;
    const handler = () => ref.current?.();
    if (visible) {
      w.BackButton.onClick(handler);
      w.BackButton.show();
    } else w.BackButton.hide();
    return () => {
      w.BackButton.offClick(handler);
    };
  }, [visible]);
}

export interface BottomButtonSpec { text: string; onClick: () => void; visible?: boolean; active?: boolean; progress?: boolean; destructive?: boolean }

function useBottomButton(which: 'MainButton' | 'SecondaryButton', spec: BottomButtonSpec | null): void {
  const ref = useRef(spec?.onClick);
  ref.current = spec?.onClick;
  const text = spec?.text ?? '';
  const visible = !!spec && spec.visible !== false;
  const active = spec?.active !== false;
  const progress = !!spec?.progress;
  const destructive = !!spec?.destructive;
  useEffect(() => {
    const w = wa();
    if (!w) return;
    if (which === 'SecondaryButton' && !atLeast('7.10')) return;
    const b = w[which];
    const handler = () => ref.current?.();
    if (!visible) {
      b.hide();
      return;
    }
    const tp = w.themeParams;
    b.setParams({
      text,
      is_visible: true,
      is_active: active,
      ...(which === 'MainButton' && destructive ? { color: (tp.destructive_text_color ?? '#e53935') as `#${string}`, text_color: '#ffffff' } : {}),
      ...(which === 'MainButton' && !destructive && tp.button_color ? { color: tp.button_color as `#${string}`, text_color: (tp.button_text_color ?? '#ffffff') as `#${string}` } : {}),
    });
    if (progress) b.showProgress(false);
    else b.hideProgress();
    b.onClick(handler);
    return () => {
      b.offClick(handler);
      b.hideProgress();
      b.hide();
    };
  }, [which, text, visible, active, progress, destructive]);
}

export function useMainButton(spec: BottomButtonSpec | null): void {
  useBottomButton('MainButton', spec);
}
export function useSecondaryButton(spec: BottomButtonSpec | null): void {
  useBottomButton('SecondaryButton', spec);
}

/** True when the Telegram bottom buttons exist (otherwise screens render in-page buttons). */
export function hasMainButton(): boolean {
  return !!wa() && initData().length > 0;
}
export function hasSecondaryButton(): boolean {
  return hasMainButton() && atLeast('7.10');
}
