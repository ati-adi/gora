// integrations/composio.ts (WP5, s07 CAL) — ComposioProvider over the Composio REST API with the injected fetchImpl
// (the SDK would use global fetch and bypass DI; plan 08 §7.1). Spec 07 B1/B5, plan 08 §4.2:
//  - auth configs on /api/v3 (lead-verified live, B5); connected accounts and tool execution on /api/v3.1 with the
//    pinned toolkit `version` on every execute (composioMap.ts TOOLKIT_VERSIONS);
//  - the Composio `user_id` is a stable HMAC of Gora's user id (`composioUserId`), never an internal or Telegram id;
//  - managed OAuth through Connect Links (callback_url → our /oauth/callback?state=…) PLUS polling of the pending
//    connected account (`connectionStatus`), because the tunnel URL can change and the callback may never arrive;
//  - tools are executed client-side, one call per tool_use, after Sentinel and approvals (never Composio sessions, MCP
//    or Tool Router: B1 forbids server-side autonomous calls).
import type { CalendarApi, Clock, ConnectionPoll, IntegrationKind, IntegrationProvider, Logger, MailApi, Ms, UserId } from '../contracts/index.ts';
import {
  authConfigName, CAL_SLUGS, calArgs, COMPOSIO_TOOLKIT, draftIdOf, MAIL_SLUGS, mailArgs, messageIdOf, payload, TOOLKIT_VERSIONS, toBusy, toDraft, toEvents, toOneEvent, toSummaries, toThread,
  type CalOp, type MailOp,
} from './composioMap.ts';

export const COMPOSIO_BASE = 'https://backend.composio.dev';
/** B5: auth configs are addressed exactly as the lead verified them live. */
const AUTH_API = '/api/v3';
/** Current API for connected accounts and tool execution (plan 08 §4.2). */
const API = '/api/v3.1';

export class NotSupportedError extends Error {
  constructor(op: string) {
    super(`not supported by provider (${op})`);
    this.name = 'NotSupportedError';
  }
}
/** HTTP 401 (code 801: a consumer `ck_…` key instead of a Platform project `ak_…` key) or 403: nothing will work until the key is fixed. */
export class ComposioMisconfiguredError extends Error {
  constructor(status: number, code: number | null) {
    super(`integrations misconfigured (composio HTTP ${status}${code !== null ? ` code ${code}` : ''})`);
    this.name = 'ComposioMisconfiguredError';
  }
}
export class ComposioHttpError extends Error {
  readonly status: number;
  constructor(route: string, status: number) {
    super(`composio ${route} HTTP ${status}`);
    this.name = 'ComposioHttpError';
    this.status = status;
  }
}

/** Who a callback / poll must complete for (service.ts passes the owner and toolkit of the oauth `state`). */
export interface ConnectionExpectation { userId: UserId; kind: IntegrationKind }

export interface ComposioOptions {
  apiKey: string;
  fetchImpl: typeof fetch;
  clock: Clock;
  log: Logger;
  /** s.crypto (only `hmac` is used): derives the Composio user id. */
  crypto: { hmac(domain: string, data: string): string };
  /** COMPOSIO_AUTH_CONFIG_GCAL / _GMAIL (cfg.composio.authConfigs): used as-is when set. */
  authConfigs?: Partial<Record<IntegrationKind, string>>;
  /** The owner's IANA zone for EVENTS_LIST / FREE_BUSY (the docs warn UTC skews results). */
  tzOf?: (userId: UserId) => string | null | undefined;
  baseUrl?: string;
  timeoutMs?: number;
}

type AccountStatus = 'INITIALIZING' | 'INITIATED' | 'ACTIVE' | 'FAILED' | 'EXPIRED' | 'INACTIVE' | 'REVOKED';
interface Account { id?: string; status?: string; user_id?: string; toolkit?: { slug?: string } }

/** A log-safe route: ids (connected accounts, auth configs) are never logged; tool slugs are kept. */
function routeOf(path: string): string {
  return path.split('?')[0]!.replace(/(\/connected_accounts\/)[^/]+/, '$1:id').replace(/(\/auth_configs\/)[^/]+/, '$1:id');
}

export class ComposioProvider implements IntegrationProvider {
  readonly name = 'composio' as const;
  private readonly o: ComposioOptions;
  /** Resolved auth config ids; the promise is cached so concurrent connects never create two configs. */
  private readonly authConfigs = new Map<IntegrationKind, Promise<string>>();

  constructor(o: ComposioOptions) {
    this.o = o;
  }

  /** B1: the stable Composio `user_id` for a Gora user (never the Telegram id or the internal id in clear). */
  composioUserId(userId: UserId): string {
    return `g_${this.o.crypto.hmac('composio_user', userId).slice(0, 32)}`;
  }

  private async req<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const ac = new AbortController();
    const timer = this.o.clock.setTimeout(() => ac.abort(), this.o.timeoutMs ?? 30_000);
    const route = routeOf(path);
    try {
      const res = await this.o.fetchImpl(`${this.o.baseUrl ?? COMPOSIO_BASE}${path}`, {
        method, signal: ac.signal,
        headers: { 'x-api-key': this.o.apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new ComposioMisconfiguredError(res.status, errorCodeOf(text));
      if (!res.ok) throw new ComposioHttpError(route, res.status);
      return (text ? JSON.parse(text) : {}) as T;
    } catch (e) {
      this.o.log.warn({ provider: 'composio', method, route, err: e instanceof Error ? e.name : 'error', status: e instanceof ComposioHttpError ? e.status : undefined }, 'composio request failed');
      throw e;
    } finally {
      this.o.clock.clearTimeout(timer);
    }
  }

  /**
   * B5: the auth config for a toolkit: COMPOSIO_AUTH_CONFIG_* when set → an existing enabled config named `gora-<slug>` →
   * a new Composio-managed config with that name (idempotent by name; Gmail's is created only on its first connect).
   */
  private authConfig(kind: IntegrationKind): Promise<string> {
    const fixed = this.o.authConfigs?.[kind];
    if (fixed) return Promise.resolve(fixed);
    let hit = this.authConfigs.get(kind);
    if (!hit) {
      hit = this.resolveAuthConfig(kind);
      this.authConfigs.set(kind, hit);
      hit.catch(() => this.authConfigs.delete(kind)); // a failed lookup is retried on the next connect
    }
    return hit;
  }

  private async resolveAuthConfig(kind: IntegrationKind): Promise<string> {
    const slug = COMPOSIO_TOOLKIT[kind];
    const name = authConfigName(kind);
    const list = await this.req<{ items?: Array<{ id?: string; name?: string; status?: string }> }>('GET', `${AUTH_API}/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`);
    const mine = (list.items ?? []).find((x) => x.name === name && x.id && (!x.status || /^enabled$/i.test(x.status)));
    if (mine?.id) return mine.id;
    const made = await this.req<{ auth_config?: { id?: string }; id?: string }>('POST', `${AUTH_API}/auth_configs`, { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth', name } });
    const id = made.auth_config?.id ?? made.id;
    if (!id) throw new Error('composio: no auth config id');
    return id;
  }

  async connectLink(userId: UserId, kind: IntegrationKind, callbackUrl: string): Promise<{ url: string; pendingRef?: string; expiresAt?: Ms }> {
    const r = await this.req<{ redirect_url?: string; expires_at?: string; connected_account_id?: string }>('POST', `${API}/connected_accounts/link`, {
      auth_config_id: await this.authConfig(kind), user_id: this.composioUserId(userId), callback_url: callbackUrl,
    });
    if (!r.redirect_url) throw new Error('composio: no redirect_url');
    const exp = r.expires_at ? Date.parse(r.expires_at) : NaN;
    return { url: r.redirect_url, ...(r.connected_account_id ? { pendingRef: r.connected_account_id } : {}), ...(Number.isFinite(exp) ? { expiresAt: exp } : {}) };
  }

  /**
   * B1 polling. The account must belong to the Composio user of the owner the link was issued for and be of that toolkit
   * (else 'mismatch', whatever its status). Only the exact status ACTIVE completes (`INACTIVE` is not active).
   */
  async connectionStatus(pendingRef: string, expect: ConnectionExpectation): Promise<ConnectionPoll> {
    let acc: Account;
    try {
      acc = await this.req<Account>('GET', `${API}/connected_accounts/${encodeURIComponent(pendingRef)}`);
    } catch (e) {
      if (e instanceof ComposioHttpError && e.status === 404) return { status: 'failed', reason: 'error' };
      throw e;
    }
    if (acc.user_id !== undefined && acc.user_id !== this.composioUserId(expect.userId)) return { status: 'failed', reason: 'mismatch' };
    const slug = acc.toolkit?.slug;
    if (slug && slug.toLowerCase() !== COMPOSIO_TOOLKIT[expect.kind]) return { status: 'failed', reason: 'mismatch' };
    switch ((acc.status ?? '').toUpperCase() as AccountStatus) {
      case 'ACTIVE':
        return acc.user_id ? { status: 'active', accountRef: acc.id || pendingRef } : { status: 'failed', reason: 'mismatch' };
      case 'FAILED':
        return { status: 'failed', reason: 'failed' };
      case 'EXPIRED':
        return { status: 'failed', reason: 'expired' };
      case 'INACTIVE':
      case 'REVOKED':
        return { status: 'failed', reason: 'revoked' };
      default: // INITIALIZING, INITIATED, or a status this code does not know yet: keep polling until the deadline
        return { status: 'pending' };
    }
  }

  /**
   * The redirect query is unauthenticated: its connected_account_id is only a claim ("query parameters alone aren't proof
   * of ownership"). The account must be exactly ACTIVE, belong to the Composio user of the owner of the `state` and be
   * of the toolkit that state was started for; anything else (or an account without a user_id) is refused.
   */
  async completeConnection(query: Record<string, string>, expect?: ConnectionExpectation): Promise<{ accountRef: string }> {
    const id = query['connected_account_id'] ?? query['connectedAccountId'];
    if (!id) throw new Error('composio: callback without connected_account_id');
    if (!expect) throw new Error('composio: completion without the expected user is refused');
    const r = await this.connectionStatus(id, expect);
    if (r.status !== 'active') throw new Error(`composio: account not active (${r.status === 'failed' ? r.reason : 'pending'})`);
    return { accountRef: r.accountRef };
  }

  async revoke(_userId: UserId, _kind: IntegrationKind, accountRef: string): Promise<void> {
    await this.req('DELETE', `${API}/connected_accounts/${encodeURIComponent(accountRef)}`);
  }

  private async exec(kind: IntegrationKind, slug: string | null, op: string, userId: UserId, accountRef: string, args: Record<string, unknown>): Promise<unknown> {
    if (!slug) throw new NotSupportedError(op);
    const r = await this.req<{ data?: unknown; error?: unknown; successful?: boolean }>('POST', `${API}/tools/execute/${encodeURIComponent(slug)}`, {
      connected_account_id: accountRef, user_id: this.composioUserId(userId), arguments: args, version: TOOLKIT_VERSIONS[kind],
    });
    if (r.successful === false) {
      const err = typeof r.error === 'string' ? r.error : JSON.stringify(r.error ?? 'failed');
      throw new Error(/not ?found|404|410|deleted/i.test(err) ? `${op}: not found` : `${op} failed`);
    }
    return r.data;
  }

  mail(userId: UserId, accountRef: string): MailApi {
    const run = (op: MailOp, args: Record<string, unknown>) => this.exec('gmail', MAIL_SLUGS[op], op, userId, accountRef, args);
    return {
      search: async (q) => toSummaries(await run('search', mailArgs.search(q))).slice(0, q.maxResults),
      readThread: async (threadId) => toThread(threadId, await run('readThread', mailArgs.readThread(threadId))),
      createDraft: async (d) => {
        const id = draftIdOf(await run('createDraft', mailArgs.createDraft(d)));
        if (!id) throw new Error('createDraft: no draft id');
        return { draftId: id };
      },
      getDraft: async (draftId) => toDraft(draftId, await run('getDraft', mailArgs.getDraft(draftId))),
      deleteDraft: async (draftId) => {
        await run('deleteDraft', mailArgs.deleteDraft(draftId));
      },
      sendDraft: async (draftId) => ({ messageId: messageIdOf(await run('sendDraft', mailArgs.sendDraft(draftId))) || draftId }),
      findSent: async (q) => {
        const hit = toSummaries(await run('findSent', mailArgs.findSent(q)))[0];
        return hit ? { messageId: hit.threadId } : null;
      },
    };
  }

  calendar(userId: UserId, accountRef: string): CalendarApi {
    const run = (op: CalOp, args: Record<string, unknown>) => this.exec('gcal', CAL_SLUGS[op], op, userId, accountRef, args);
    const tz = (): string | undefined => {
      try {
        return this.o.tzOf?.(userId) || undefined;
      } catch {
        return undefined;
      }
    };
    return {
      list: async (q) => toEvents(await run('list', calArgs.list(q, tz()))).slice(0, q.max),
      freeBusy: async (q) => toBusy(await run('freeBusy', calArgs.freeBusy(q, tz()))),
      create: async (e, idemKey) => toOneEvent(await run('create', calArgs.create(e, idemKey))),
      update: async (id, p) => toOneEvent(await run('update', calArgs.update(id, p))),
      remove: async (id) => {
        await run('remove', calArgs.remove(id));
      },
      respond: async (id, r) => {
        await run('respond', calArgs.respond(id, r));
      },
      findByIdem: async (idemKey) => toEvents(await run('findByIdem', calArgs.findByIdem(idemKey)))[0] ?? null,
    };
  }
}

/** Composio error bodies carry a numeric code (`{error:{code:801,…}}` or `{code:801}`); null when absent. */
function errorCodeOf(text: string): number | null {
  try {
    const j = JSON.parse(text) as { code?: unknown; error?: { code?: unknown } | string };
    const c = typeof j.error === 'object' && j.error ? j.error.code : j.code;
    const n = Number(c);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export { payload as composioPayload };
