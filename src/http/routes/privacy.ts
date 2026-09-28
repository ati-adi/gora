// http/routes/privacy.ts (WP8) — Privacy screen, export and deletion (01 §12, §11.9):
//   GET  /api/privacy                         read   what is stored, processors, retention, key separation, cache note
//   POST /api/export/token                    write  → {url}: single-use deeplink_tokens row of kind 'export', 5 min
//   GET  /api/export/download?token=          token  (no initData: WebApp.downloadFile cannot send headers) — the JSON
//        export with Content-Disposition: attachment; filename="gora-export.json" and
//        Access-Control-Allow-Origin: https://web.telegram.org
//   POST /api/account/delete {confirm:'DELETE'}   high (initData ≤ 10 min) + the typed phrase → the §7.2 plan
import { z } from 'zod';
import type { Hono } from 'hono';
import type { Services } from '../../contracts/index.ts';
import { uiLang } from '../../contracts/index.ts';
import { TELEGRAM_WEB_ORIGIN } from '../security.ts';
import { auth, body, err, errName, fresh, type Api } from '../util.ts';

export const EXPORT_TOKEN_TTL_MS = 5 * 60_000;
export const EXPORT_FILENAME = 'gora-export.json';
const DeleteBody = z.object({ confirm: z.string() });
const DELETED_TEXT = {
  en: 'Deleted. Telegram keeps this chat on your device — delete the chat to remove it there.',
  ru: 'Удалено. Telegram хранит этот чат на вашем устройстве — удалите чат, чтобы убрать его и там.',
} as const;

function disclosure(s: Services) {
  const c = s.config;
  const processors: Array<{ name: string; purpose: string; note?: string }> = [];
  if (c.llm.transport === 'anthropic') processors.push({ name: 'Anthropic', purpose: 'llm', note: 'zero data retention requested where eligible' });
  if (c.llm.transport === 'groq') processors.push({ name: 'Groq', purpose: 'llm' });
  if (c.providers.stt === 'groq') processors.push({ name: 'Groq', purpose: 'stt' });
  if (c.providers.stt === 'openai') processors.push({ name: 'OpenAI', purpose: 'stt' });
  if (c.providers.integrations === 'composio') processors.push({ name: 'Composio', purpose: 'integrations' });
  if (c.providers.weather === 'openmeteo') processors.push({ name: 'Open-Meteo', purpose: 'weather', note: 'coordinates rounded' });
  if (c.providers.weather === 'metno') processors.push({ name: 'MET Norway', purpose: 'weather', note: 'coordinates rounded' });
  if (c.providers.geo === 'live') processors.push({ name: 'Photon', purpose: 'places', note: 'coordinates rounded' });
  return {
    stored: ['profile', 'consents', 'memory', 'reminders', 'todos', 'missions', 'watchers', 'ledger', 'conversations', 'connections', 'business', 'payments'],
    processors,
    // durations: '<n>h' | '<n>d' (the client localizes them)
    retention: [
      { what: 'telegram_updates', keep: '72h' },
      { what: 'outbox', keep: '7d' },
      { what: 'guest_and_links', keep: '24h' },
      { what: 'location', keep: '1h' },
      { what: 'business_messages', keep: '30d' },
      { what: 'llm_raw', keep: '30d' },
      { what: 'pending_actions', keep: '30d' },
      { what: 'closed_epochs', keep: '90d' },
      { what: 'ledger', keep: '365d' },
    ],
    noTraining: true,
    keysSeparate: true,
    cacheNote: true,
  };
}

export const EXPORT_TOKENS_PER_HOUR = 5;

export function registerPrivacy(api: Api, s: Services): void {
  api.get('/privacy', (c) => c.json(disclosure(s)));

  api.post('/export/token', (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    // An export decrypts every row the user owns: a few per hour, not the generic 240/min Mini App bucket.
    if (!s.quotas.rate(`exporttoken:${user.tgUserId}`, EXPORT_TOKENS_PER_HOUR, 60 * 60_000)) return err(c, 429, 'rate_limited');
    const token = s.deepLinks.create('export', user.tgUserId, { userId: user.id }, EXPORT_TOKEN_TTL_MS);
    return c.json({ url: `${s.config.publicUrl}/api/export/download?token=${encodeURIComponent(token)}`, fileName: EXPORT_FILENAME, expiresAt: s.clock.now() + EXPORT_TOKEN_TTL_MS });
  });

  api.post('/account/delete', async (c) => {
    const stale = fresh(s, c, 'high');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, DeleteBody);
    if (!b.ok) return b.res;
    if (b.data.confirm !== 'DELETE') return err(c, 422, 'confirm_phrase');
    const chatId = user.dmChatId ?? user.tgUserId;
    const lang = uiLang(user.languageCode);
    await s.privacy.deleteUser(user.id, 'user');
    try {
      s.telegram.outbox.enqueue({ idempotencyKey: `acctdel:${user.id}`, chatId, method: 'sendRichMessage', payload: {}, markdown: DELETED_TEXT[lang], priority: 0 });
    } catch (x) {
      s.log.warn({ mod: 'http', err: errName(x) }, 'miniapp: deletion notice not queued');
    }
    return c.json({ deleted: true });
  });
}

/** GET/OPTIONS /api/export/download — mounted before the initData middleware (token auth only). */
export function registerExportDownload(app: Hono, s: Services): void {
  const cors = { 'Access-Control-Allow-Origin': TELEGRAM_WEB_ORIGIN, 'Vary': 'Origin' };
  app.options('/api/export/download', () => new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' } }));
  app.get('/api/export/download', async (c) => {
    const base = { ...cors, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    const token = c.req.query('token') ?? '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return c.json({ error: 'not_found' }, 404, base);
    const r = s.deepLinks.consume(token, 'export');
    if ('error' in r) {
      const status = r.error === 'expired' || r.error === 'used' ? 410 : 404;
      return c.json({ error: r.error }, status, base);
    }
    const payload = r.payload as { userId?: unknown } | null;
    const user = s.repos.users.getByTg(r.ownerTgId);
    if (!user || !payload || payload.userId !== user.id || user.status === 'deleting') return c.json({ error: 'not_found' }, 404, base);
    const bytes = await s.privacy.exportUser(user.id);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...base,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${EXPORT_FILENAME}"`,
        'Content-Length': String(bytes.byteLength),
      },
    });
  });
}
