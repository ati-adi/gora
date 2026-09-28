// telegram/bot.ts (WP2) — the Bot factory and transformer order (01 §16 WP2: fake → limiter → autoRetry).
// grammY runs the most recently installed transformer first, so the caller's transformers (tests: FakeTelegram) are
// installed first (innermost, closest to the network), then the limiter, then autoRetry (outermost).
import { Bot, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Clock, Logger } from '../contracts/index.ts';
import { createAutoRetry, createLimiter, type Limiter } from './limiter.ts';

export interface BotParts { bot: Bot; limiter: Limiter }

export async function createBot(o: {
  token: string; apiRoot: string; testEnv: boolean; botInfo?: UserFromGetMe; transformers?: Transformer[];
  clock: Clock; log: Logger; enforceLimits: boolean; extra?: Transformer[];
}): Promise<BotParts> {
  const bot = new Bot(o.token, {
    ...(o.botInfo ? { botInfo: o.botInfo } : {}),
    client: { apiRoot: o.apiRoot, environment: o.testEnv ? 'test' : 'prod', timeoutSeconds: 60 },
  });
  for (const t of o.transformers ?? []) bot.api.config.use(t);
  const limiter = createLimiter({ clock: o.clock, enforce: o.enforceLimits, log: o.log });
  bot.api.config.use(limiter.transformer);
  bot.api.config.use(createAutoRetry({ clock: o.clock, log: o.log }));
  for (const t of o.extra ?? []) bot.api.config.use(t);
  // No bot.catch(): bot.handleUpdate must reject so the dispatcher can mark the inbox row failed and log it.
  if (!o.botInfo) await bot.init(); // getMe (boot step 5)
  return { bot, limiter };
}
