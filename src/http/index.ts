// http/index.ts (WP8) — createHttpApp(s, tg): the Hono app (webhook, OAuth, dev connect, /api/*, /app/*, /healthz).
// Listening is main.ts's job (`serve({ fetch: app.http.fetch, port })`). See server.ts for the route map.
import type { Hono } from 'hono';
import type { Services, TelegramModule } from '../contracts/index.ts';
import { buildServer, type HttpOptions } from './server.ts';

export type { HttpOptions } from './server.ts';
export { validateInitData, dataCheckString, InitDataError } from './auth.ts';
export { drainHttp, isHttpDraining } from './drain.ts';

export function createHttpApp(s: Services, tg: TelegramModule, o?: HttpOptions): Hono {
  return buildServer(s, tg, o);
}
