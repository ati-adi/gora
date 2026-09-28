// src/surfaces/handlers.ts (WP7a) — grammY handler registration (01 §4.3 "Registering grammY handlers", §10.1).
// app.ts calls this right before WP7b's business.registerHandlers(bot), so business_* updates (and a `/start bizChat…`
// that this module passes on with next()) reach WP7b's handlers through the same middleware chain.
import type { Bot, Context, NextFunction } from 'grammy';
import type { UserRow } from '../contracts/index.ts';
import { PROACTIVE_LOG_PREFIX } from '../contracts/behaviour.ts';
import type { Callbacks } from './callbacks.ts';
import { PRIVATE_COMMANDS, type Commands } from './commands.ts';
import type { DmHandlers } from './dm.ts';
import type { Group } from './group.ts';
import type { Guest } from './guest.ts';
import type { Onboarding } from './onboarding.ts';
import type { PaymentsModule } from './payments.ts';
import type { Why } from './why.ts';
import { errName, type Surf } from './util.ts';

export interface HandlerDeps {
  ob: Onboarding;
  dm: DmHandlers;
  commands: Commands;
  why: Why;
  guest: Guest;
  group: Group;
  callbacks: Callbacks;
  payments: PaymentsModule;
}

export function registerSurfaceHandlers(surf: Surf, bot: Bot, d: HandlerDeps): void {
  const { s } = surf;
  surf.bot = bot;
  const safe =
    (name: string, fn: (ctx: Context, next: NextFunction) => Promise<void>) =>
    async (ctx: Context, next: NextFunction): Promise<void> => {
      try {
        await fn(ctx, next);
      } catch (e) {
        surf.log.error({ err: errName(e), handler: name, updateId: ctx.update.update_id }, 'surfaces: handler failed');
      }
    };
  const ownerOf = (ctx: Context): UserRow | null => {
    const m = ctx.message;
    if (!m?.from || m.from.is_bot) return null;
    const u = s.repos.users.upsertFromTelegram(m.from, { dmChatId: m.chat.id });
    // 05 A1: a command can be the first message too (records the description's memory notice once)
    return u.status === 'deleting' ? null : m.chat.type === 'private' ? d.ob.firstContact(u) : u;
  };

  // ── control lane
  bot.on('pre_checkout_query', safe('pre_checkout', async (ctx) => {
    if (ctx.preCheckoutQuery) await d.payments.precheck(ctx.preCheckoutQuery);
  }));
  bot.on('subscription', safe('subscription', async (ctx) => {
    const u = ctx.update.subscription;
    if (u) await d.payments.onSubscription({ user: { id: u.user.id }, invoice_payload: u.invoice_payload, state: u.state as 'canceled' | 'active' | 'failed' });
  }));
  bot.on('callback_query:data', safe('callback', (ctx) => d.callbacks.route(ctx)));
  bot.on('my_chat_member', safe('my_chat_member', (ctx) => d.group.onMyChatMember(ctx)));
  bot.on('stopped_message_generation', safe('stop', async (ctx) => {
    const u = ctx.update.stopped_message_generation;
    if (!u) return;
    await s.runner.stopByDraft(u.chat.id, u.message_thread_id ?? 0, u.draft_id);
  }));
  bot.on('message_reaction', safe('reaction', async (ctx) => {
    const r = ctx.messageReaction;
    if (!r || !r.user) return;
    const emoji = (x: typeof r.new_reaction) => x.filter((e) => e.type === 'emoji').map((e) => (e as { emoji: string }).emoji);
    const added = emoji(r.new_reaction).filter((e) => !emoji(r.old_reaction).includes(e));
    // spec 05 C1 (friend foundation): a reaction by the owner in their own DM → behaviour signals (the emoji only)
    if (r.chat.type === 'private' && r.chat.id === r.user.id && added.length) {
      const me = s.repos.users.getByTg(r.user.id);
      if (me) {
        try {
          s.signals.reaction(me.id, { at: s.clock.now(), emoji: added[0]!, tgMessageId: r.message_id });
        } catch {
          /* best effort */
        }
      }
    }
    const link = s.telegram.links.lookup(r.chat.id, r.message_id);
    if (!link?.nudgeId || link.nudgeId.startsWith(PROACTIVE_LOG_PREFIX)) return; // proactive messages: signals only (above)
    const owner = link.userId ? s.repos.users.getById(link.userId) : undefined;
    if (!owner || owner.tgUserId !== r.user.id) return;
    if (added.includes('👍') || added.includes('❤') || added.includes('🔥')) await s.nudges.outcome(link.nudgeId, 'reaction_up');
    else if (added.includes('👎')) await s.nudges.outcome(link.nudgeId, 'reaction_down');
  }));

  // ── guest mode
  bot.on('guest_message', safe('guest', (ctx) => d.guest.onGuestMessage(ctx)));

  // ── private chats: commands, then everything else
  const pm = bot.chatType('private');
  pm.command('start', safe('start', async (ctx, next) => {
    const m = ctx.message;
    if (!m?.from || m.from.is_bot) return;
    const res = await d.ob.onStart({ from: m.from, chatId: m.chat.id, payload: typeof ctx.match === 'string' ? ctx.match : '', updateId: ctx.update.update_id, messageId: m.message_id });
    if (res === 'next') await next();
  }));
  pm.command('why', safe('why', async (ctx) => {
    const user = ownerOf(ctx);
    const m = ctx.message;
    if (!user || !m) return;
    const threadId = m.is_topic_message && m.message_thread_id ? m.message_thread_id : undefined;
    await d.why.explain(user, { chatId: m.chat.id, ...(threadId ? { threadId } : {}) }, m.reply_to_message ? { messageId: m.reply_to_message.message_id } : null, `why:${ctx.update.update_id}`);
  }));
  pm.command([...PRIVATE_COMMANDS], safe('command', async (ctx) => {
    const user = ownerOf(ctx);
    const m = ctx.message;
    if (!user || !m) return;
    const name = (m.text ?? '').slice(1).split(/[\s@]/)[0]!.toLowerCase() as (typeof PRIVATE_COMMANDS)[number];
    const threadId = m.is_topic_message && m.message_thread_id ? m.message_thread_id : undefined;
    await d.commands.run(name, { user, args: typeof ctx.match === 'string' ? ctx.match : '', chat: { chatId: m.chat.id, ...(threadId ? { threadId } : {}) }, updateId: ctx.update.update_id, messageId: m.message_id });
  }));
  pm.on('message', safe('dm', async (ctx, next) => {
    // A /start passed on by onboarding (bizChat…) belongs to WP7b's handlers further down the chain.
    if (/^\/start(@\w+)?(\s|$)/.test(ctx.message?.text ?? '')) return next();
    await d.dm.onMessage(ctx);
  }));
  pm.on('edited_message', safe('dm_edit', (ctx) => d.dm.onEdited(ctx)));

  // ── groups: only mentions, replies to Gora and Gora's commands are processed (the rest is ignored, never stored)
  bot.chatType(['group', 'supergroup']).on('message', safe('group', async (ctx) => {
    await d.group.onGroupMessage(ctx);
  }));
}
