// test/harness/initData.ts (WP0) — signs Mini App initData with the same recipe as http/auth.ts (01 §12).
// 'signature' stays in the data-check-string; only 'hash' is excluded.
import { createHmac } from 'node:crypto';
import { TEST_TOKEN } from './fakeTelegram.ts';

export interface InitDataUser { id: number; first_name: string; last_name?: string; username?: string; language_code?: string; is_premium?: boolean; allows_write_to_pm?: boolean }

export function dataCheckString(p: URLSearchParams): string {
  return [...p.entries()].filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort().join('\n');
}

export function initDataHash(p: URLSearchParams, token: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return createHmac('sha256', secret).update(dataCheckString(p)).digest('hex');
}

/** Raw initData string (what the Mini App sends as `Authorization: tma <raw>`). authDate is unix seconds. */
export function signInitData(user: InitDataUser, o: { authDate: number; token?: string; queryId?: string; startParam?: string; extra?: Record<string, string>; signature?: string | null } ): string {
  const p = new URLSearchParams();
  p.set('user', JSON.stringify({ allows_write_to_pm: true, ...user }));
  p.set('auth_date', String(Math.floor(o.authDate)));
  p.set('query_id', o.queryId ?? 'AAHdF6IQAAAAAN0XohDhrOrc');
  if (o.startParam) p.set('start_param', o.startParam);
  if (o.signature !== null) p.set('signature', o.signature ?? 'dGVzdC1zaWduYXR1cmUtZWQyNTUxOS1ub3QtY2hlY2tlZA');
  for (const [k, v] of Object.entries(o.extra ?? {})) p.set(k, v);
  p.set('hash', initDataHash(p, o.token ?? TEST_TOKEN));
  return p.toString();
}

/** Same hash, altered user → must fail validation. */
export function tamperInitData(raw: string, patch: Partial<InitDataUser> = { id: 999_999 }): string {
  const p = new URLSearchParams(raw);
  const user = JSON.parse(p.get('user') ?? '{}') as InitDataUser;
  p.set('user', JSON.stringify({ ...user, ...patch }));
  return p.toString();
}

/** Validly signed but `ageSec` old relative to `nowMs`. */
export function staleInitData(user: InitDataUser, o: { nowMs: number; ageSec: number; token?: string }): string {
  return signInitData(user, { authDate: Math.floor(o.nowMs / 1000) - o.ageSec, ...(o.token ? { token: o.token } : {}) });
}

/** Reference validator (identical to 01 §12 validateInitData) so harness tests can prove the signer is correct. */
export function verifyInitData(raw: string, token: string, maxAgeSec: number, nowMs: number): { ok: true; user: InitDataUser } | { ok: false; reason: 'no_hash' | 'bad_hash' | 'stale' } {
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };
  if (!/^[0-9a-f]{64}$/.test(hash) || hash !== initDataHash(p, token)) return { ok: false, reason: 'bad_hash' };
  const authDate = Number(p.get('auth_date'));
  if (!authDate || nowMs / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'stale' };
  return { ok: true, user: JSON.parse(p.get('user')!) as InitDataUser };
}
