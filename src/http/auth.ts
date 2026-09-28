// http/auth.ts (WP8) — Mini App initData authentication (01 §12 "Auth", F15).
// Every /api/* request except GET /api/export/download carries `Authorization: tma <initDataRaw>`. The HMAC recipe is
// Telegram's: secret = HMAC_SHA256(key='WebAppData', bot_token); hash = hex(HMAC_SHA256(secret, data_check_string)),
// where the data-check-string holds every field except `hash` (the Ed25519 `signature` field STAYS in it), sorted, as
// 'key=value' joined by '\n'. Freshness classes: read ≤ 24 h, write ≤ 1 h, high ≤ 10 min (grants `always`, account
// delete, secretary consent). initData is never logged (01 §4.2).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Ms, Services, UserRow } from '../contracts/index.ts';
import { deletedTgMarkerKey } from '../privacy/delete.ts';

export type Freshness = 'read' | 'write' | 'high';
export type AuthFailure = 'missing' | 'malformed' | 'no_hash' | 'bad_hash' | 'stale' | 'future' | 'no_user' | 'no_token';

export class InitDataError extends Error {
  readonly reason: AuthFailure;
  constructor(reason: AuthFailure) {
    super(`initData rejected: ${reason}`);
    this.name = 'InitDataError';
    this.reason = reason;
  }
}

/** WebAppUser (only the fields Gora reads). */
export interface WebAppUser { id: number; first_name: string; last_name?: string; username?: string; language_code?: string; is_premium?: boolean; allows_write_to_pm?: boolean }

export interface ValidatedInitData { user: WebAppUser; authDate: number /* unix seconds */; startParam: string | null; queryId: string | null }

const WebAppUserSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(35).optional(),
  is_premium: z.boolean().optional(),
  allows_write_to_pm: z.boolean().optional(),
}).loose();

/** Seconds of forward clock skew tolerated on auth_date (a client clock slightly ahead of ours). */
export const MAX_FUTURE_SKEW_SEC = 300;
/** initData longer than this is refused before any hashing (Telegram's is ~1 KB). */
export const MAX_INIT_DATA_CHARS = 8192;

export function freshnessMaxAgeSec(s: Pick<Services, 'config'>, cls: Freshness): number {
  const l = s.config.limits;
  return cls === 'high' ? l.initDataHighMaxAgeSec : cls === 'write' ? l.initDataWriteMaxAgeSec : l.initDataReadMaxAgeSec;
}

/** The data-check-string: every field but `hash` (the `signature` field is kept), sorted, 'k=v' joined by '\n'. */
export function dataCheckString(p: URLSearchParams): string {
  return [...p.entries()].filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort().join('\n');
}

/**
 * 01 §12 validateInitData: throws InitDataError (→ 401) unless `raw` is signed with `botToken` and no older than
 * `maxAgeSec` at `now`. Returns the parsed WebAppUser plus auth_date / start_param.
 */
export function validateInitData(raw: string, botToken: string, maxAgeSec: number, now: Ms): ValidatedInitData {
  if (!botToken) throw new InitDataError('no_token');
  if (typeof raw !== 'string' || raw.length === 0) throw new InitDataError('missing');
  if (raw.length > MAX_INIT_DATA_CHARS) throw new InitDataError('malformed');
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(raw);
  } catch {
    throw new InitDataError('malformed');
  }
  const hashes = p.getAll('hash');
  if (hashes.length === 0) throw new InitDataError('no_hash');
  const hash = hashes[0]!;
  if (hashes.length !== 1 || !/^[0-9a-f]{64}$/.test(hash)) throw new InitDataError('bad_hash');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = createHmac('sha256', secret).update(dataCheckString(p)).digest();
  if (!timingSafeEqual(Buffer.from(hash, 'hex'), calc)) throw new InitDataError('bad_hash');
  const authDate = Number(p.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) throw new InitDataError('stale');
  const nowSec = now / 1000;
  if (nowSec - authDate > maxAgeSec) throw new InitDataError('stale');
  if (authDate - nowSec > MAX_FUTURE_SKEW_SEC) throw new InitDataError('future');
  const rawUser = p.get('user');
  if (!rawUser) throw new InitDataError('no_user');
  let user: WebAppUser;
  try {
    const parsed = WebAppUserSchema.safeParse(JSON.parse(rawUser));
    if (!parsed.success) throw new InitDataError('no_user');
    user = parsed.data as WebAppUser;
  } catch {
    throw new InitDataError('no_user');
  }
  return { user, authDate, startParam: p.get('start_param'), queryId: p.get('query_id') };
}

/** Extracts `<raw>` from `Authorization: tma <raw>` (scheme case-insensitive); null when absent or another scheme. */
export function tmaFromHeader(h: string | undefined | null): string | null {
  if (!h) return null;
  const m = /^\s*tma\s+(.+?)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

export interface AuthInfo {
  user: UserRow;
  tg: WebAppUser;
  authDate: number;
  /** now − auth_date, ms (≥ 0). */
  ageMs: number;
  startParam: string | null;
}
export type AppEnv = { Variables: { auth: AuthInfo } };

const STATUS_FOR: Record<AuthFailure, number> = { missing: 401, malformed: 401, no_hash: 401, bad_hash: 401, stale: 401, future: 401, no_user: 401, no_token: 503 };

/**
 * The /api/* middleware: validates initData at the loosest class (read, 24 h), maps the Telegram user to users.tg_user_id
 * (created if missing, every consent unset) and stores AuthInfo on the context. Routes then call `requireFresh(c, cls)`.
 */
export function authMiddleware(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = tmaFromHeader(c.req.header('authorization'));
    const token = s.config.telegram.token ?? '';
    let v: ValidatedInitData;
    try {
      if (raw === null) throw new InitDataError('missing');
      v = validateInitData(raw, token, freshnessMaxAgeSec(s, 'read'), s.clock.now());
    } catch (e) {
      const reason: AuthFailure = e instanceof InitDataError ? e.reason : 'malformed';
      if (reason === 'no_token') s.log.warn({ mod: 'http' }, 'miniapp auth: no bot token configured');
      return c.json({ error: 'unauthorized', reason }, STATUS_FOR[reason] as 401);
    }
    let user = s.repos.users.getByTg(v.user.id);
    if (!user) {
      // An account deleted after this initData was signed stays deleted: the still-open Mini App must not re-create it.
      // Reopening the Mini App (fresh initData) signs up again.
      const deletedAt = s.repos.kv.get<{ at?: unknown }>(deletedTgMarkerKey(s, v.user.id))?.at;
      if (typeof deletedAt === 'number' && v.authDate * 1000 <= deletedAt) return c.json({ error: 'forbidden', reason: 'deleted' }, 403);
      user = s.repos.users.upsertFromTelegram({
        id: v.user.id,
        first_name: v.user.first_name,
        ...(v.user.username ? { username: v.user.username } : {}),
        ...(v.user.language_code ? { language_code: v.user.language_code } : {}),
      }, { dmChatId: v.user.id, refSource: 'miniapp' });
    }
    // spec 05 C1: 'blocked' only stops Gora-first messages; the owner can always see, correct and erase what Gora knows
    if (user.status === 'deleting') return c.json({ error: 'forbidden', reason: user.status }, 403);
    c.set('auth', { user, tg: v.user, authDate: v.authDate, ageMs: Math.max(0, s.clock.now() - v.authDate * 1000), startParam: v.startParam });
    await next();
  };
}

/**
 * Enforces a freshness class on the current request. Returns a 401 Response ({error:'stale', need}) to send, or null
 * when the initData is fresh enough. The client reacts to `need:'high'` by asking the user to reopen the Mini App.
 */
export function requireFresh(s: Services, c: Context<AppEnv>, cls: Freshness): Response | null {
  const a = c.get('auth');
  if (a.ageMs <= freshnessMaxAgeSec(s, cls) * 1000) return null;
  return c.json({ error: 'stale', need: cls, maxAgeSec: freshnessMaxAgeSec(s, cls) }, 401);
}
