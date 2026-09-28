// webapp/src/App.tsx (WP8) — the Mini App shell: Telegram boot, the signed-in user (/api/me), language, and the
// screen stack (React state + Telegram BackButton; no hash routing — 01 §12).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorState } from './components/Empty.tsx';
import { Loading } from './components/Loading.tsx';
import { ApiError, get } from './lib/api.ts';
import { I18nContext, langFrom, makeT } from './lib/i18n.ts';
import { MeContext, type Me } from './lib/me.ts';
import { initialRoute, initialStack, NavContext, type Nav, type Route } from './lib/nav.ts';
import { initData, startParam, tgUser, useBackButton, wa } from './lib/tg.ts';
import { ApprovalDetail } from './screens/ApprovalDetail.tsx';
import { Approvals } from './screens/Approvals.tsx';
import { Connections } from './screens/Connections.tsx';
import { GrantConfirm } from './screens/GrantConfirm.tsx';
import { Home } from './screens/Home.tsx';
import { Ledger } from './screens/Ledger.tsx';
import { Memory } from './screens/Memory.tsx';
import { Plan } from './screens/Plan.tsx';
import { Privacy } from './screens/Privacy.tsx';
import { Secretary } from './screens/Secretary.tsx';
import { Settings } from './screens/Settings.tsx';
import { Tasks } from './screens/Tasks.tsx';
import { TzDetect } from './screens/TzDetect.tsx';

function Screen(p: { r: Route }) {
  const r = p.r;
  switch (r.screen) {
    case 'home': return <Home />;
    case 'approvals': return <Approvals />;
    case 'approval': return <ApprovalDetail id={r.id ?? ''} />;
    case 'grant': return <GrantConfirm id={r.id ?? ''} />;
    case 'ledger': return <Ledger />;
    case 'memory': return <Memory />;
    case 'tasks': return <Tasks />;
    case 'connections': return <Connections />;
    case 'secretary': return <Secretary {...(r.id ? { focus: r.id } : {})} />;
    case 'settings': return <Settings />;
    case 'plan': return <Plan />;
    case 'privacy': return <Privacy autoExport={!!r.export} />;
    case 'tz': return <TzDetect />;
  }
}

function NotInTelegram(p: { t: ReturnType<typeof makeT> }) {
  return (
    <div className="page page-center">
      <div className="logo" aria-hidden>⛰️</div>
      <h1 className="center">{p.t('not_in_telegram_title')}</h1>
      <p className="muted center">{p.t('not_in_telegram_body')}</p>
    </div>
  );
}

export function App() {
  const hasInit = initData().length > 0;
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stack, setStack] = useState<Route[]>(() => initialStack(initialRoute(window.location.search, startParam())));

  const lang = langFrom(me?.user.languageCode ?? tgUser()?.language_code ?? navigator.language);
  const t = useMemo(() => makeT(lang), [lang]);

  const loadMe = useCallback(async () => {
    try {
      setMe(await get<Me>('/me'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, { error: 'network' }));
    }
  }, []);
  useEffect(() => {
    if (hasInit) void loadMe();
  }, [hasInit, loadMe]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const nav: Nav = useMemo(() => ({
    route: stack[stack.length - 1]!,
    depth: stack.length,
    push: (r) => {
      setStack((s) => [...s, r]);
      window.scrollTo({ top: 0 });
    },
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    back: () => {
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      window.scrollTo({ top: 0 });
    },
    home: () => setStack([{ screen: 'home' }]),
  }), [stack]);

  useBackButton(stack.length > 1 && nav.route.screen !== 'tz' ? nav.back : null);

  const i18n = useMemo(() => ({ t, lang }), [t, lang]);
  const meCtx = useMemo(() => (me ? { me, refresh: loadMe } : null), [me, loadMe]);

  let body;
  if (!hasInit || !wa()) body = <NotInTelegram t={t} />;
  else if (!meCtx) body = error ? <ErrorState error={error} onRetry={() => void loadMe()} /> : <Loading rows={5} />;
  else {
    body = (
      <MeContext.Provider value={meCtx}>
        <NavContext.Provider value={nav}>
          {/* keyed by depth + screen so each screen mounts fresh (its own data load) */}
          <Screen key={`${stack.length}:${nav.route.screen}:${nav.route.id ?? ''}`} r={nav.route} />
        </NavContext.Provider>
      </MeContext.Provider>
    );
  }
  return (
    <I18nContext.Provider value={i18n}>
      <main className="app">{body}</main>
    </I18nContext.Provider>
  );
}
