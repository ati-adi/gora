// http/server.ts (WP8) — the Hono server composition (01 §4.1, §12, F15):
//   POST /tg/webhook                 WP2 webhook handler (secret-token checked there; 503 while shutting down)
//   GET  /oauth/callback             WP5 IntegrationService.oauthCallback
//   GET  /dev/fake-connect?state=    development + fake provider only (IntegrationService.devConnect; 404 otherwise)
//   GET  /healthz                    database ok, last scheduler tick within 10 s, inbox lag under 30 s
//   GET  /api/export/download        token auth (no initData)
//   /api/*                           initData auth (auth.ts) + freshness classes per route
//   /app/*                           the built Mini App (dist/webapp) with an SPA fallback to index.html, CSP (⚠U16)
// Serve it from the exact origin registered in BotFather (Bot API 10.2 origin lock): PUBLIC_URL + '/app/'.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Services, TelegramModule } from '../contracts/index.ts';
import { authMiddleware, type AppEnv } from './auth.ts';
import { drainMiddleware } from './drain.ts';
import { apiHeaders, miniAppHeaders } from './security.ts';
import { errName } from './util.ts';
import { registerApprovals } from './routes/approvals.ts';
import { registerBilling } from './routes/billing.ts';
import { registerConnections } from './routes/connections.ts';
import { registerGrants } from './routes/grants.ts';
import { registerHome } from './routes/home.ts';
import { registerLedger } from './routes/ledger.ts';
import { registerMe } from './routes/me.ts';
import { registerMemory } from './routes/memory.ts';
import { registerExportDownload, registerPrivacy } from './routes/privacy.ts';
import { registerSecretary } from './routes/secretary.ts';
import { registerSettings } from './routes/settings.ts';
import { registerStepUp } from './routes/stepup.ts';
import { registerTasks } from './routes/tasks.ts';

export const HEALTH_TICK_MAX_AGE_MS = 10_000;
export const HEALTH_INBOX_LAG_MAX_MS = 30_000;
export const API_BODY_LIMIT_BYTES = 256 * 1024;
/** Per-user API budget (in-memory token bucket via QuotaService.rate): generous for a UI, a wall for scripts. */
export const API_RATE_PER_MIN = 240;

export interface HttpOptions {
  /** Directory holding the built Mini App (default: <repo>/dist/webapp). Tests point it at a fixture. */
  webappDir?: string;
}

export function defaultWebappDir(): string {
  return resolve(import.meta.dirname, '../../dist/webapp');
}

export function buildServer(s: Services, tg: TelegramModule, o: HttpOptions = {}): Hono {
  const app = new Hono();
  const log = s.log.child({ mod: 'http' });
  const builtAt = s.clock.now();

  app.onError((e, c) => {
    // Error name and route only: messages may carry user text, and the query string may carry a token.
    log.error({ err: errName(e), method: c.req.method, path: c.req.routePath }, 'http: unhandled error');
    return c.req.path.startsWith('/api/') ? c.json({ error: 'internal' }, 500) : c.text('Internal error', 500);
  });
  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not_found' }, 404) : c.text('Not found', 404)));

  // Shutdown gate (drain.ts): first, so nothing below runs once app.stop() started draining.
  const drain = drainMiddleware(s);
  app.use('/api/*', drain);
  app.use('/oauth/*', drain);

  // ── Telegram, OAuth, dev
  app.post('/tg/webhook', (c) => tg.webhookHandler(c.req.raw));
  app.get('/oauth/callback', (c) => s.integrations.oauthCallback(c.req.query()));
  if (s.config.env !== 'production') {
    app.get('/dev/fake-connect', (c) => s.integrations.devConnect(c.req.query('state') ?? ''));
  }

  // ── health
  app.get('/healthz', (c) => {
    const now = s.clock.now();
    let db = false;
    try {
      db = s.db.prepare('SELECT 1 AS ok').get<{ ok: number }>()?.ok === 1;
    } catch {
      db = false;
    }
    let lastTickAt: number | null = null;
    try {
      lastTickAt = s.scheduler.health().lastTickAt;
    } catch {
      lastTickAt = null;
    }
    let inboxLagMs = Number.POSITIVE_INFINITY;
    try {
      inboxLagMs = tg.dispatcher.lagMs();
    } catch {
      inboxLagMs = Number.POSITIVE_INFINITY;
    }
    // Boot grace: before the scheduler's first loop iteration, the process counts as healthy for 10 s.
    const scheduler = lastTickAt !== null ? now - lastTickAt <= HEALTH_TICK_MAX_AGE_MS : now - builtAt <= HEALTH_TICK_MAX_AGE_MS;
    const inbox = inboxLagMs < HEALTH_INBOX_LAG_MAX_MS;
    const ok = db && scheduler && inbox;
    return c.json({ ok, db, scheduler, inbox, lastTickAt, inboxLagMs: Number.isFinite(inboxLagMs) ? inboxLagMs : null, profile: s.profile.id }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
  });

  // ── API
  app.use('/api/*', apiHeaders());
  app.use('/api/*', bodyLimit({ maxSize: API_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  registerExportDownload(app, s); // token auth, before the initData middleware
  const api = new Hono<AppEnv>();
  api.use('*', authMiddleware(s));
  api.use('*', async (c, next) => {
    let ok = true;
    try {
      ok = s.quotas.rate(`miniapp:${c.get('auth').user.tgUserId}`, API_RATE_PER_MIN, 60_000);
    } catch {
      ok = true;
    }
    if (!ok) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '30' });
    await next();
  });
  registerMe(api, s, tg);
  registerHome(api, s);
  registerApprovals(api, s);
  registerGrants(api, s);
  registerStepUp(api, s);
  registerLedger(api, s);
  registerMemory(api, s);
  registerTasks(api, s);
  registerConnections(api, s);
  registerSecretary(api, s);
  registerSettings(api, s);
  registerBilling(api, s);
  registerPrivacy(api, s);
  app.route('/api', api);

  // ── Mini App (static, SPA fallback; never hash routing — Telegram owns location.hash)
  mountMiniApp(app, s, o.webappDir ?? defaultWebappDir());
  return app;
}

function mountMiniApp(app: Hono, s: Services, dir: string): void {
  const headers = miniAppHeaders(s.config.frameAncestors);
  app.use('/app', headers);
  app.use('/app/*', headers);
  // '/app' → '/app/' keeping ?screen=…&id=… (relative asset URLs and the router need the trailing slash)
  app.get('/app', (c) => {
    const q = new URL(c.req.url).search;
    return c.redirect(`/app/${q}`, 301);
  });

  const built = existsSync(join(dir, 'index.html'));
  if (!built) {
    s.log.warn({ mod: 'http' }, 'Mini App not built: run `npm run build:webapp` (serving a placeholder at /app/)');
    app.get('/app/*', (c) => c.html('<!doctype html><meta charset="utf-8"><title>Gora</title><p>The Mini App is not built yet. Run <code>npm run build:webapp</code>.</p>', 503));
    return;
  }

  // Cache policy: index.html revalidates; content-hashed assets are immutable; anything else an hour.
  app.use('/app/*', async (c, next) => {
    await next();
    if (c.res.status !== 200) return;
    const type = c.res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) c.res.headers.set('Cache-Control', 'no-cache');
    else if (c.req.path.startsWith('/app/assets/')) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    else c.res.headers.set('Cache-Control', 'public, max-age=3600');
  });
  app.get('/app/*', serveStatic({ root: dir, rewriteRequestPath: (p) => p.replace(/^\/app/, '') || '/' }));
  // SPA fallback: any extension-less path under /app/ renders index.html (the screen comes from ?screen= / start_param).
  app.get('/app/*', async (c) => {
    const last = c.req.path.split('/').pop() ?? '';
    if (last.includes('.')) return c.text('Not found', 404);
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    return c.html(html, 200);
  });
}
