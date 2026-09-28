// webapp/src/lib/nav.ts (WP8) — in-app navigation as React state (01 §12 "Routing"): Telegram owns location.hash,
// so there is NO hash routing. The first screen comes from `?screen=<name>&id=<id>` or from the launch parameter
// `start_param` = `<screen>_<id>` (e.g. `approval_A7K2QX`). The Telegram BackButton pops the stack.
import { createContext, useContext } from 'react';

export type ScreenName =
  | 'home' | 'approvals' | 'approval' | 'grant' | 'ledger' | 'memory' | 'tasks' | 'connections' | 'secretary'
  | 'settings' | 'plan' | 'privacy' | 'tz';

export interface Route { screen: ScreenName; id?: string; export?: boolean }

const SCREENS: readonly ScreenName[] = ['home', 'approvals', 'approval', 'grant', 'ledger', 'memory', 'tasks', 'connections', 'secretary', 'settings', 'plan', 'privacy', 'tz'];
const ALIASES: Readonly<Record<string, Route>> = {
  export: { screen: 'privacy', export: true },
  approvals_list: { screen: 'approvals' },
  timezone: { screen: 'tz' },
  billing: { screen: 'plan' },
  reminders: { screen: 'tasks' },
  missions: { screen: 'tasks' },
};

const idOk = (id: string | null | undefined): id is string => !!id && /^[A-Za-z0-9_:.-]{1,128}$/.test(id);

function toRoute(name: string | null | undefined, id?: string | null): Route | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const alias = ALIASES[n];
  if (alias) return { ...alias, ...(idOk(id) ? { id } : {}) };
  if (!(SCREENS as readonly string[]).includes(n)) return null;
  const screen = n as ScreenName;
  if ((screen === 'approval' || screen === 'grant') && !idOk(id)) return { screen: 'approvals' };
  return { screen, ...(idOk(id) ? { id } : {}) };
}

/** The launch route: ?screen=&id= (also ?chat= for the Secretary), else start_param `<screen>_<id>`, else Home. */
export function initialRoute(search: string, startParam: string | null): Route {
  const q = new URLSearchParams(search);
  const fromQuery = toRoute(q.get('screen'), q.get('id') ?? q.get('chat'));
  if (fromQuery) return fromQuery;
  if (startParam) {
    const i = startParam.indexOf('_');
    const r = i > 0 ? toRoute(startParam.slice(0, i), startParam.slice(i + 1)) : toRoute(startParam);
    if (r) return r;
  }
  return { screen: 'home' };
}

/** The stack under a deep-linked screen: back from an approval goes to the list, then Home. */
export function initialStack(r: Route): Route[] {
  if (r.screen === 'home' || r.screen === 'tz') return [r];
  if (r.screen === 'approval') return [{ screen: 'home' }, { screen: 'approvals' }, r];
  if (r.screen === 'grant') return [{ screen: 'home' }, { screen: 'approvals' }, { screen: 'approval', id: r.id! }, r];
  return [{ screen: 'home' }, r];
}

export interface Nav {
  route: Route;
  depth: number;
  push(r: Route): void;
  replace(r: Route): void;
  back(): void;
  home(): void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error('NavContext missing');
  return n;
}
