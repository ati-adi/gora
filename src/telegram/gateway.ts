// telegram/gateway.ts (WP2) — the TelegramGateway handed to every other module as `s.telegram` (01 §4.4).
import type { Bot } from 'grammy';
import type { BotFlags, CallbackCodec, CallbackRegistry, Outbox, Renderer, TelegramFiles, TelegramGateway, TgLinks, TopicManager } from '../contracts/index.ts';

export function createGateway(p: {
  bot: Bot; flags: BotFlags; outbox: Outbox; files: TelegramFiles; topics: TopicManager; render: Renderer; codec: CallbackCodec; callbacks: CallbackRegistry; links: TgLinks;
}): TelegramGateway {
  return {
    get api() {
      return p.bot.api;
    },
    get botInfo() {
      return p.bot.botInfo;
    },
    flags: p.flags, // live object: the ⚠U13 downgrade flips `topics` in place
    outbox: p.outbox,
    files: p.files,
    topics: p.topics,
    render: p.render,
    codec: p.codec,
    callbacks: p.callbacks,
    links: p.links,
  };
}
