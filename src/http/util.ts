// http/util.ts (WP8) — shared helpers for the API routes: JSON body validation (zod), error responses, the user's
// scope and language, and a guarded ledger append. Nothing here logs request bodies or initData.
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { ZodType } from 'zod';
import type { LedgerEntry, Scope, Services, UserRow } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import type { AppEnv, AuthInfo, Freshness } from './auth.ts';
import { requireFresh } from './auth.ts';

export type Api = Hono<AppEnv>;
export type Ctx = Context<AppEnv>;

export interface RouteDeps { s: Services }

export function auth(c: Ctx): AuthInfo {
  return c.get('auth');
}

export function userScope(u: UserRow): Scope {
  return { kind: 'user', userId: u.id };
}

export function langOf(u: UserRow): 'en' | 'ru' {
  return uiLang(u.languageCode);
}

export function err(c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503, error: string, extra?: Record<string, unknown>): Response {
  return c.json({ error, ...(extra ?? {}) }, status);
}

/** Reads and validates the JSON body. Returns the data, or a 400 Response to return as-is. */
export async function body<T>(c: Ctx, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: err(c, 400, 'invalid_json') };
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, res: err(c, 400, 'invalid_body', { issues: r.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) }) };
  return { ok: true, data: r.data };
}

/** Validates query parameters (strings) with a schema; 400 on failure. */
export function query<T>(c: Ctx, schema: ZodType<T>): { ok: true; data: T } | { ok: false; res: Response } {
  const r = schema.safeParse(c.req.query());
  if (!r.success) return { ok: false, res: err(c, 400, 'invalid_query', { issues: r.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) }) };
  return { ok: true, data: r.data };
}

/** Freshness gate: `const stale = fresh(s, c, 'write'); if (stale) return stale;` */
export function fresh(s: Services, c: Ctx, cls: Freshness): Response | null {
  return cls === 'read' ? null : requireFresh(s, c, cls);
}

/** Ledger append that never fails the request (the action already happened). */
export function ledger(s: Services, e: LedgerEntry): void {
  try {
    s.ledger.append(e);
  } catch (x) {
    s.log.warn({ mod: 'http', kind: e.kind, err: x instanceof Error ? x.name : 'error' }, 'miniapp: ledger append failed');
  }
}

/** A service call whose failure should degrade a read endpoint (e.g. a module still on its fake), never 500 it. */
export function safely<T>(s: Services, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (x) {
    s.log.warn({ mod: 'http', what, err: x instanceof Error ? x.name : 'error' }, 'miniapp: read degraded');
    return fallback;
  }
}

export async function safelyAsync<T>(s: Services, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (x) {
    s.log.warn({ mod: 'http', what, err: x instanceof Error ? x.name : 'error' }, 'miniapp: read degraded');
    return fallback;
  }
}

/** Error name only (never the message: it may carry user text). */
export function errName(x: unknown): string {
  return x instanceof Error ? x.name : typeof x;
}

/** Service-thrown "not found / not yours" errors become 404; everything else is re-thrown (→ 500 via onError). */
export function isNotFoundish(x: unknown): boolean {
  if (!(x instanceof Error)) return false;
  const code = String((x as { code?: unknown }).code ?? '').toLowerCase();
  if (/^(not_found|forbidden|not_owner|not_yours|unknown)$/.test(code)) return true;
  return /not[ _-]?found|unknown|no such|not yours|forbidden|not owned|missing/.test(`${x.name} ${x.message}`.toLowerCase());
}
