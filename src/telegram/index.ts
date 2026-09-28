// telegram/index.ts (WP2) — createTelegramModule (01 §4.4 wiring; §4.5 boot steps 5, 6, 8, 10).
//   bot (fake → limiter → autoRetry) → getMe flags (kv.bot_flags, BotFather checklist) → renderer, codec, links, outbox
//   (every buffered sent hook installed before start) → files, topics (+ rename_topic job) → inbox, dispatcher, ingress
//   → commands/menu when their hash changed → privacy hook (retention of tg_updates/outbox, purge on /deletemydata).
import type { Services, TelegramModule, TelegramModuleOptions } from '../contracts/index.ts';
import { registerNamed } from '../kernel/registries.ts';
import { createCallbackRegistry } from '../kernel/registries.ts';
import { createBot } from './bot.ts';
import { createCallbackCodec } from './callbackCodec.ts';
import { createChannelFactory } from './channels/index.ts';
import { syncCommands } from './commands.ts';
import { createDispatcher } from './dispatcher.ts';
import { createTelegramFiles } from './files.ts';
import { loadFlags } from './flags.ts';
import { createGateway } from './gateway.ts';
import { createInboxRepo } from './inboxRepo.ts';
import { createIngress, createPcqTracker } from './ingress.ts';
import { createLinks } from './links.ts';
import { createOutbox } from './outbox.ts';
import { createRenderer } from './render/index.ts';
import { createTopicManager } from './topics.ts';

export async function createTelegramModule(s: Services, o: TelegramModuleOptions): Promise<TelegramModule> {
  const cfg = s.config;
  const log = s.log.child({ mod: 'telegram' });
  const token = cfg.telegram.token;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required for the Telegram module');

  const pcq = createPcqTracker();
  const { bot, limiter } = await createBot({
    token, apiRoot: cfg.telegram.apiRoot, testEnv: cfg.telegram.testEnv, ...(o.botInfo ? { botInfo: o.botInfo } : {}),
    transformers: o.transformers ?? [], clock: s.clock, log, enforceLimits: cfg.env !== 'test', extra: [pcq.transformer],
  });
  const flags = loadFlags(bot.botInfo, s.repos.kv, log, s.clock.now());
  const render = createRenderer({ api: () => bot.api, clock: s.clock, businessRich: cfg.features.businessRich });
  const codec = createCallbackCodec(cfg.secrets.callbackKey);
  const callbacks = o.callbacks ?? createCallbackRegistry(log);
  const links = createLinks(s.db, s.clock);

  const outbox = createOutbox({ db: s.db, crypto: s.crypto, clock: s.clock, log: log.child({ part: 'outbox' }), api: () => bot.api, limiter, repos: () => s.repos, businessRich: cfg.features.businessRich, onBlocked: (userId) => s.signals?.blocked(userId, s.clock.now()) });
  // Factory-time onSent registrations (app.ts pre-gateway) MUST be installed before anything can send; the array is live.
  const installed = new Set<object>();
  const installSentHooks = () => {
    for (const h of o.sentHooks ?? []) {
      if (installed.has(h)) continue;
      installed.add(h);
      outbox.onSent(h.refKind, h.hook);
    }
  };
  installSentHooks();
  const startOutbox = outbox.start.bind(outbox);
  const flushOutbox = outbox.flush.bind(outbox);
  const sendNow = outbox.sendNow.bind(outbox);
  outbox.start = () => {
    installSentHooks();
    startOutbox();
  };
  outbox.flush = () => {
    installSentHooks();
    return flushOutbox();
  };
  outbox.sendNow = (r) => {
    installSentHooks();
    return sendNow(r);
  };

  const files = createTelegramFiles({
    api: () => bot.api, token, apiRoot: cfg.telegram.apiRoot, testEnv: cfg.telegram.testEnv, clock: s.clock, log,
    fetchImpl: o.fetchImpl ?? ((() => Promise.reject(new Error('no fetchImpl for Telegram file downloads'))) as unknown as typeof fetch),
  });
  const topics = createTopicManager({ db: s.db, crypto: s.crypto, clock: s.clock, log, api: () => bot.api, flags, outbox: () => outbox, repos: () => s.repos, s });
  s.scheduler.register('rename_topic', topics.renameJob);

  const gateway = createGateway({ bot, flags, outbox, files, topics, render, codec, callbacks, links });

  const inbox = createInboxRepo(s.db, s.crypto);
  const dispatcher = createDispatcher({ inbox, bot: () => bot, clock: s.clock, log: log.child({ part: 'dispatcher' }), strings: s.strings, outbox: () => outbox });
  const ingress = createIngress({ config: cfg, clock: s.clock, log: log.child({ part: 'ingress' }), kv: s.repos.kv, inbox, dispatcher, bot: () => bot, pcq });

  await syncCommands(bot.api, s.repos.kv, cfg.publicUrl, log); // boot step 6 (only when the hash changed)

  registerNamed(s.privacyHooks, {
    name: 'telegram',
    async onDeleteUser(_userId, tgUserId) {
      // WP1 deletes topics / tg_links / outbox rows by user_id (USER_DATA_TABLES); these are the rows keyed only by chat.
      s.db.prepare(`UPDATE tg_updates SET payload_enc = NULL WHERE lane LIKE ?`).run(`dm:${tgUserId}:%`);
      s.db.prepare(`DELETE FROM outbox WHERE chat_id = ? AND status <> 'sending'`).run(tgUserId);
      links.deleteForChat(tgUserId);
    },
    async retentionSweep(now) {
      inbox.retention(now);
      outbox.retention(now);
    },
  });

  const channels = createChannelFactory(s);

  return {
    gateway,
    bot,
    channels,
    webhookHandler: (req) => ingress.webhookHandler(req),
    startIngress: () => ingress.start(),
    stopIngress: () => ingress.stop(),
    dispatcher: { start: dispatcher.start, stop: dispatcher.stop, drain: dispatcher.drain, lagMs: dispatcher.lagMs },
  };
}
