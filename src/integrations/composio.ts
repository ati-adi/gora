// integrations/composio.ts (WP5) — ComposioProvider over the Composio REST API v3.1 with the injected fetchImpl (the SDK
// would use global fetch). Managed OAuth through Connect Links (callback_url → our /oauth/callback?state=…); tools are
// executed client-side through our own loop, so every call passes Sentinel first. Slugs/arguments: composioMap.ts (⚠U11).
import type { CalendarApi, Clock, IntegrationKind, IntegrationProvider, Logger, MailApi, UserId } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import {
  CAL_SLUGS, calArgs, COMPOSIO_TOOLKIT, draftIdOf, MAIL_SLUGS, mailArgs, messageIdOf, payload, toBusy, toDraft, toEvents, toOneEvent, toSummaries, toThread,
  type CalOp, type MailOp,
} from './composioMap.ts';

export const COMPOSIO_BASE = 'https://backend.composio.dev';
export class NotSupportedError extends Error {
  constructor(op: string) {
    super(`not supported by provider (${op})`);
    this.name = 'NotSupportedError';
  }
}

/** Who a callback must complete for (service.ts passes the owner of the oauth `state`). */
export interface ConnectionExpectation { userId: UserId; kind: IntegrationKind }

export interface ComposioOptions { apiKey: string; fetchImpl: typeof fetch; clock: Clock; log: Logger; baseUrl?: string; timeoutMs?: number }

export class ComposioProvider implements IntegrationProvider {
  readonly name = 'composio' as const;
  private readonly o: ComposioOptions;
  private readonly authConfigs = new Map<IntegrationKind, string>();

  constructor(o: ComposioOptions) {
    this.o = o;
  }

  private async req<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const ac = new AbortController();
    const timer = this.o.clock.setTimeout(() => ac.abort(), this.o.timeoutMs ?? 30_000);
    try {
      const res = await this.o.fetchImpl(`${this.o.baseUrl ?? COMPOSIO_BASE}${path}`, {
        method, signal: ac.signal,
        headers: { 'x-api-key': this.o.apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`composio ${path.split('?')[0]} HTTP ${res.status}`);
      return (text ? JSON.parse(text) : {}) as T;
    } catch (e) {
      this.o.log.warn({ provider: 'composio', path: path.split('?')[0], err: errorMessage(e) }, 'composio request failed');
      throw e;
    } finally {
      this.o.clock.clearTimeout(timer);
    }
  }

  /** The auth config for a toolkit: the first enabled one, else a new Composio-managed one (cached). */
  private async authConfig(kind: IntegrationKind): Promise<string> {
    const hit = this.authConfigs.get(kind);
    if (hit) return hit;
    const slug = COMPOSIO_TOOLKIT[kind];
    const list = await this.req<{ items?: Array<{ id?: string; nanoid?: string; status?: string }> }>('GET', `/api/v3.1/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`);
    let id = (list.items ?? []).find((x) => !x.status || /enabled|active/i.test(x.status))?.id ?? (list.items ?? [])[0]?.nanoid;
    if (!id) {
      const made = await this.req<{ auth_config?: { id?: string }; id?: string }>('POST', '/api/v3.1/auth_configs', { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth' } });
      id = made.auth_config?.id ?? made.id;
    }
    if (!id) throw new Error('composio: no auth config');
    this.authConfigs.set(kind, id);
    return id;
  }

  async connectLink(userId: UserId, kind: IntegrationKind, callbackUrl: string): Promise<{ url: string }> {
    const r = await this.req<{ redirect_url?: string }>('POST', '/api/v3.1/connected_accounts/link', { auth_config_id: await this.authConfig(kind), user_id: userId, callback_url: callbackUrl });
    if (!r.redirect_url) throw new Error('composio: no redirect_url');
    return { url: r.redirect_url };
  }

  /**
   * The redirect query is unauthenticated: its connected_account_id is only a claim. The account must be ACTIVE, belong to
   * the Composio user_id of the user who owns the `state` (Gora's user id, as passed to connectLink) and be of the
   * toolkit that state was started for; anything else (or an account without a user_id) is refused.
   */
  async completeConnection(query: Record<string, string>, expect?: ConnectionExpectation): Promise<{ accountRef: string }> {
    const id = query['connected_account_id'] ?? query['connectedAccountId'] ?? query['id'];
    if (!id) throw new Error('composio: callback without connected_account_id');
    if (!expect) throw new Error('composio: completion without the expected user is refused');
    const acc = await this.req<{ status?: string; user_id?: string; toolkit?: { slug?: string } }>('GET', `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
    if (acc.status && !/active/i.test(acc.status)) throw new Error(`composio: account ${acc.status}`);
    if (!acc.user_id || acc.user_id !== expect.userId) throw new Error('composio: connected account belongs to another user');
    const slug = acc.toolkit?.slug;
    if (slug && slug.toLowerCase() !== COMPOSIO_TOOLKIT[expect.kind]) throw new Error('composio: connected account is for another toolkit');
    return { accountRef: id };
  }

  async revoke(_userId: UserId, _kind: IntegrationKind, accountRef: string): Promise<void> {
    await this.req('DELETE', `/api/v3.1/connected_accounts/${encodeURIComponent(accountRef)}`);
  }

  private async exec(slug: string | null, op: string, userId: UserId, accountRef: string, args: Record<string, unknown>): Promise<unknown> {
    if (!slug) throw new NotSupportedError(op);
    const r = await this.req<{ data?: unknown; error?: string | null; successful?: boolean }>('POST', `/api/v3.1/tools/execute/${encodeURIComponent(slug)}`, { connected_account_id: accountRef, user_id: userId, arguments: args });
    if (r.successful === false) {
      const err = String(r.error ?? 'failed');
      throw new Error(/not ?found|404/i.test(err) ? `${op}: not found` : `${op} failed`);
    }
    return r.data;
  }

  mail(userId: UserId, accountRef: string): MailApi {
    const run = (op: MailOp, args: Record<string, unknown>) => this.exec(MAIL_SLUGS[op], op, userId, accountRef, args);
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
    const run = (op: CalOp, args: Record<string, unknown>) => this.exec(CAL_SLUGS[op], op, userId, accountRef, args);
    return {
      list: async (q) => toEvents(await run('list', calArgs.list(q))).slice(0, q.max),
      freeBusy: async (q) => toBusy(await run('freeBusy', calArgs.freeBusy(q))),
      create: async (e, idemKey) => toOneEvent(await run('create', calArgs.create(e, idemKey))),
      update: async (id, p) => toOneEvent(await run('update', calArgs.update(id, p))),
      remove: async (id) => {
        await run('remove', calArgs.remove(id));
      },
      respond: async () => {
        await run('respond', {});
      },
      findByIdem: async (idemKey) => toEvents(await run('findByIdem', calArgs.findByIdem(idemKey)))[0] ?? null,
    };
  }
}

export { payload as composioPayload };
