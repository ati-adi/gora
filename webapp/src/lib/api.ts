// webapp/src/lib/api.ts (WP8) — the API client: `Authorization: tma <initData>` on every call (01 §12 "Auth"),
// JSON in and out, typed errors (stale initData → the "reopen Gora" state), and a small data hook.
import { useCallback, useEffect, useRef, useState } from 'react';
import { initData } from './tg.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly need: 'read' | 'write' | 'high' | null;
  readonly data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) {
    super(String(data['error'] ?? `HTTP ${status}`));
    this.name = 'ApiError';
    this.status = status;
    this.code = String(data['error'] ?? 'error');
    const need = data['need'];
    this.need = need === 'read' || need === 'write' || need === 'high' ? need : null;
    this.data = data;
  }
  /** initData too old for this action: the user must close and reopen the Mini App. */
  get stale(): boolean {
    return this.status === 401 && (this.code === 'stale' || this.data['reason'] === 'stale');
  }
}

const BASE = '/api';

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `tma ${initData()}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ApiError(0, { error: 'network' });
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'bad_response' };
    }
  }
  if (!res.ok) throw new ApiError(res.status, (data && typeof data === 'object' ? data : {}) as Record<string, unknown>);
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export interface Loadable<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => Promise<void>; set: (v: T) => void }

/** GET `path` on mount (and when it changes); `reload()` refreshes without flashing the spinner. */
export function useApi<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (path === null) return;
    const my = ++seq.current;
    try {
      const d = await get<T>(path);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, { error: 'network' }));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(path !== null);
    void load();
  }, [load, path]);
  return { data, error, loading, reload: load, set: setData };
}
