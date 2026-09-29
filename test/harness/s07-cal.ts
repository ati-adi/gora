// test/harness/s07-cal.ts (s07 CAL) — a fake Composio REST server over an injected fetchImpl, with the shapes of plan
// 08 §4.2 (docs + @composio/core 0.21.0 typings, verified 2026-09-29): auth configs on /api/v3, connected accounts and
// tool execution on /api/v3.1. It records every request (method, path, query, JSON body) and scripts auth configs,
// account statuses and tool responses. A `ck_…` key gets the real 401 code 801.
import { createHash } from 'node:crypto';
import { FakeClock } from '../../src/kernel/clock.ts';
import { nullLogger } from '../../src/kernel/log.ts';
import { ComposioProvider, type ComposioOptions } from '../../src/integrations/composio.ts';

export interface ComposioRequest { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null; apiKey: string }
export interface FakeAccount { id: string; status: string; user_id?: string; toolkit: { slug: string }; auth_config: { id: string; is_composio_managed: boolean } }
export interface FakeAuthConfig { id: string; name: string; status: string; is_composio_managed: boolean; toolkit: { slug: string } }
export type ToolReply = { data?: unknown; successful?: boolean; error?: unknown };

export interface ComposioFake {
  fetchImpl: typeof fetch;
  requests: ComposioRequest[];
  authConfigs: FakeAuthConfig[];
  accounts: Map<string, FakeAccount>;
  /** Scripted replies per tool slug (default: `{data:{}, successful:true}`). */
  tools: Map<string, (args: Record<string, unknown>) => ToolReply>;
  /** The next request fails with this HTTP status (and optional body). */
  failNext(status: number, body?: unknown): void;
  /** Requests whose path starts with `prefix` (e.g. '/api/v3.1/tools/execute/'). */
  to(prefix: string, method?: string): ComposioRequest[];
  setStatus(accountId: string, status: string): void;
  linkExpiresAt: string;
}

export function createComposioFetch(o: { now?: () => number } = {}): ComposioFake {
  const requests: ComposioRequest[] = [];
  const authConfigs: FakeAuthConfig[] = [];
  const accounts = new Map<string, FakeAccount>();
  const tools = new Map<string, (args: Record<string, unknown>) => ToolReply>();
  let seq = 0;
  let fail: { status: number; body?: unknown } | null = null;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fake: ComposioFake = {
    requests, authConfigs, accounts, tools,
    linkExpiresAt: new Date((o.now?.() ?? Date.UTC(2026, 8, 29, 9, 0)) + 10 * 60_000).toISOString(),
    failNext(status, body) {
      fail = { status, ...(body !== undefined ? { body } : {}) };
    },
    to(prefix, method) {
      return requests.filter((r) => r.path.startsWith(prefix) && (!method || r.method === method));
    },
    setStatus(id, status) {
      const a = accounts.get(id);
      if (a) a.status = status;
    },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const req: ComposioRequest = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, apiKey: headers.get('x-api-key') ?? '' };
      requests.push(req);
      if (fail) {
        const f = fail;
        fail = null;
        return json(f.status, f.body ?? { error: { message: 'scripted failure' } });
      }
      if (!req.apiKey.startsWith('ak_')) return json(401, { error: { code: 801, slug: 'APIKey_InvalidAPIKey', message: 'Invalid API key' } });
      const p = url.pathname;
      if (p === '/api/v3/auth_configs' && method === 'GET') {
        const slug = url.searchParams.get('toolkit_slug');
        return json(200, { items: authConfigs.filter((a) => !slug || a.toolkit.slug === slug), total_pages: 1 });
      }
      if (p === '/api/v3/auth_configs' && method === 'POST') {
        const tk = (body?.['toolkit'] as { slug?: string } | undefined)?.slug ?? '';
        const ac = body?.['auth_config'] as { type?: string; name?: string } | undefined;
        const made: FakeAuthConfig = { id: `ac_fake${++seq}`, name: ac?.name ?? `${tk}-auth`, status: 'ENABLED', is_composio_managed: ac?.type === 'use_composio_managed_auth', toolkit: { slug: tk } };
        authConfigs.push(made);
        return json(201, { toolkit: { slug: tk }, auth_config: { id: made.id, auth_scheme: 'OAUTH2', is_composio_managed: made.is_composio_managed } });
      }
      if (p === '/api/v3.1/connected_accounts/link' && method === 'POST') {
        const acId = String(body?.['auth_config_id'] ?? '');
        const slug = authConfigs.find((a) => a.id === acId)?.toolkit.slug ?? (acId.includes('gmail') ? 'gmail' : 'googlecalendar');
        const id = `ca_fake${++seq}`;
        accounts.set(id, { id, status: 'INITIATED', user_id: String(body?.['user_id'] ?? ''), toolkit: { slug }, auth_config: { id: acId, is_composio_managed: true } });
        return json(201, { link_token: `lt_${seq}`, redirect_url: `https://connect.composio.dev/link/lk_${seq}`, expires_at: fake.linkExpiresAt, connected_account_id: id });
      }
      const acc = /^\/api\/v3\.1\/connected_accounts\/([^/]+)$/.exec(p);
      if (acc) {
        const id = decodeURIComponent(acc[1]!);
        const a = accounts.get(id);
        if (!a) return json(404, { error: { message: 'Connected account not found' } });
        if (method === 'DELETE') {
          accounts.delete(id);
          return json(200, { success: true });
        }
        return json(200, a);
      }
      const ex = /^\/api\/v3\.1\/tools\/execute\/([^/]+)$/.exec(p);
      if (ex && method === 'POST') {
        const h = tools.get(decodeURIComponent(ex[1]!));
        const r = h ? h((body?.['arguments'] ?? {}) as Record<string, unknown>) : { data: {}, successful: true };
        return json(200, { data: r.data ?? {}, error: r.error ?? null, successful: r.successful ?? true, log_id: `log_${++seq}` });
      }
      return json(404, { error: { message: 'not found' } });
    }) as typeof fetch,
  };
  return fake;
}

/** A deterministic, domain-separated stand-in for s.crypto.hmac (tests only). */
export const testHmac = { hmac: (domain: string, data: string) => createHash('sha256').update(`${domain}|${data}`).digest('hex') };

export function composioProvider(fake: ComposioFake, o: Partial<ComposioOptions> = {}): ComposioProvider {
  return new ComposioProvider({ apiKey: 'ak_test', fetchImpl: fake.fetchImpl, clock: new FakeClock(), log: nullLogger, crypto: testHmac, ...o });
}
