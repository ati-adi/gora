// telegram/render/index.ts (WP2) — the Renderer (contracts/telegram.ts) over sanitize / hygiene / split / fallback / cards / time.
import type { Api } from 'grammy';
import type { Clock, Renderer } from '../../contracts/index.ts';
import { renderCard } from './cards.ts';
import { escapeMd } from './escape.ts';
import { sendMarkdownChain, toEntities } from './fallback.ts';
import { hygiene } from './hygiene.ts';
import { sanitizeMarkdown } from './sanitize.ts';
import { splitMarkdown } from './split.ts';
import { tgTime } from './time.ts';

/** `businessRich` (⚠U6, FEATURE_BUSINESS_RICH): business-connection sends start at the entities rung unless it is on. */
export function createRenderer(d: { api: () => Api; clock: Clock; businessRich?: boolean }): Renderer {
  return {
    sanitize: (md, ctx) => sanitizeMarkdown(md, ctx, d.clock.now()),
    hygiene,
    split: (md) => splitMarkdown(md),
    toEntities,
    card: renderCard,
    escape: escapeMd,
    tgTime,
    sendMarkdown: (t, md, o) =>
      sendMarkdownChain(
        d.api(),
        { chatId: t.chatId, ...(t.threadId ? { threadId: t.threadId } : {}), ...(t.businessConnectionId ? { businessConnectionId: t.businessConnectionId } : {}), ...(t.replyTo ? { replyTo: t.replyTo } : {}) },
        md,
        { ...(o?.replyMarkup ? { replyMarkup: o.replyMarkup } : {}), ...(o?.silent ? { silent: true } : {}), allowRich: o?.allowRich !== false && (!t.businessConnectionId || d.businessRich === true) },
      ),
  };
}

export { sanitizeMarkdown } from './sanitize.ts';
export { hygiene } from './hygiene.ts';
export { splitMarkdown } from './split.ts';
export { renderCard } from './cards.ts';
export { tgTime } from './time.ts';
export { escapeMd } from './escape.ts';
