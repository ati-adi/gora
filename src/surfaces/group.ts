// src/surfaces/group.ts (WP7a) — group mode (01 F14, §10.3): Gora reads ONLY messages that mention it, reply to it,
// or are its commands; everything else is neither processed nor stored. Member input is `[Member: <name>] text`
// (mention stripped); a replied-to message that is not Gora's is untrusted (group_member). 30 triggers / 10 min per
// group, then one "short break" message. Group commands: /gora, /remember, /forget, /groupmemory, and the ephemeral
// `/me <question>` whose answer is produced in the asker's DM conversation (⚠U5 public fallback). my_chat_member:
// the groups row + intro on join, left_at on leave (the group's keys are destroyed 7 days later by the retention hook),
// users.bot_blocked for private chats.
import type { Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import type { ChatRef, Scope, UserRow } from '../contracts/index.ts';
import { neutralizeReservedTags } from '../kernel/tags.ts';
import type { DmHandlers } from './dm.ts';
import { stripMention } from './guest.ts';
import { st } from './strings.ts';
import { deepLink, errName, langOf, sendRich, urlBtn, type Keyboard, type Surf } from './util.ts';

export const GROUP_COMMANDS = ['gora', 'remember', 'forget', 'groupmemory', 'me', 'help', 'start'] as const;
export type GroupCommand = (typeof GROUP_COMMANDS)[number];
export const ME_TOKEN_TTL_MS = 24 * 3_600_000;
const TEN_MIN = 10 * 60_000;

export type GroupTrigger = { kind: 'command'; command: string; args: string } | { kind: 'mention' } | { kind: 'reply' } | null;

/** §10.3 triggers: a mention of @bot, a text_mention of the bot, a reply to the bot, or a command (for us). */
export function groupTrigger(msg: Message, bot: { id: number; username: string }): GroupTrigger {
  const text = msg.text ?? msg.caption ?? '';
  const entities: MessageEntity[] = msg.entities ?? msg.caption_entities ?? [];
  const lowerBot = bot.username.toLowerCase();
  const cmd = entities.find((e) => e.type === 'bot_command' && e.offset === 0);
  if (cmd) {
    const raw = text.slice(1, cmd.length);
    const [name, at] = raw.split('@');
    if (at && at.toLowerCase() !== lowerBot) return null; // another bot's command
    return { kind: 'command', command: (name ?? '').toLowerCase(), args: text.slice(cmd.length).trim() };
  }
  for (const e of entities) {
    if (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${lowerBot}`) return { kind: 'mention' };
    if (e.type === 'text_mention' && e.user?.id === bot.id) return { kind: 'mention' };
  }
  if (msg.reply_to_message?.from?.id === bot.id) return { kind: 'reply' };
  return null;
}

export function createGroup(surf: Surf, deps: { dm: DmHandlers }) {
  const { s } = surf;
  const L = s.config.limits;
  const esc = (t: string) => s.telegram.render.escape(t);
  const botRef = () => ({ id: s.telegram.botInfo.id, username: s.telegram.botInfo.username });
  const privateLink = (chatId: number) => deepLink(surf, `grp_${s.crypto.hmac('chat_ref', String(chatId)).slice(0, 16)}`);
  const scopeOf = (chatId: number): Scope => ({ kind: 'group', chatId });

  const reply = (msg: Message, md: string, idem: string, keyboard?: Keyboard) =>
    sendRich(surf, { chatId: msg.chat.id, ...(msg.is_topic_message && msg.message_thread_id ? { threadId: msg.message_thread_id } : {}) }, md, { idem, replyTo: msg.message_id, ...(keyboard ? { keyboard } : {}) });

  async function onMyChatMember(ctx: Context): Promise<void> {
    const u = ctx.myChatMember;
    if (!u) return;
    const status = u.new_chat_member.status;
    if (u.chat.type === 'private') {
      const user = s.repos.users.getByTg(u.chat.id);
      if (!user) return;
      if (status === 'kicked') s.repos.users.update(user.id, { botBlocked: true });
      // unblocked in Telegram: the C1 'blocked' status (set on a 403) ends with it
      else if (status === 'member') s.repos.users.update(user.id, { botBlocked: false, ...(user.status === 'blocked' ? { status: 'active' as const } : {}) });
      return;
    }
    if (u.chat.type !== 'group' && u.chat.type !== 'supergroup') return;
    const chatId = u.chat.id;
    if (status === 'member' || status === 'administrator') {
      const res = surf.groups.upsertJoined({ chatId, type: u.chat.type, status, addedByTgId: u.from?.id ?? null, title: 'title' in u.chat ? (u.chat.title ?? null) : null });
      if (!res.isNew && !res.wasLeft) return;
      if (!s.config.features.groups) return;
      const lang = u.from?.language_code;
      const kb: Keyboard = [[urlBtn(s.strings.t('use_privately_button', lang), privateLink(chatId))]];
      const sent = await sendRich(surf, { chatId }, st('group_intro', lang, { bot: s.telegram.botInfo.username }), { idem: `grpintro:${chatId}:${ctx.update.update_id}`, keyboard: kb });
      if (sent[0]) surf.groups.setIntro(chatId, sent[0].messageId);
    } else if (status === 'left' || status === 'kicked') {
      surf.groups.markLeft(chatId, status);
    }
  }

  /** Returns true when the message was for Gora (handled), false when it must be ignored (never stored). */
  async function onGroupMessage(ctx: Context): Promise<boolean> {
    const msg = ctx.message;
    if (!msg || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') || !msg.from || msg.from.is_bot) return false;
    if (!s.config.features.groups) return false;
    const trig = groupTrigger(msg, botRef());
    if (!trig) return false; // not for us: nothing is processed or stored
    const chatId = msg.chat.id;
    const updateId = ctx.update.update_id;
    const lang = msg.from.language_code;

    if (!s.quotas.rate(`grp:${chatId}`, L.groupTriggersPer10Min, TEN_MIN)) {
      if (s.quotas.rate(`grpbreak:${chatId}`, 1, TEN_MIN)) await reply(msg, st('group_break', lang), `grpbreak:${updateId}`);
      return true;
    }
    // The bot may have been added before this process saw my_chat_member: make sure the row exists.
    if (!surf.groups.get(chatId)) surf.groups.upsertJoined({ chatId, type: msg.chat.type, status: 'member', addedByTgId: null, title: 'title' in msg.chat ? (msg.chat.title ?? null) : null });

    if (trig.kind === 'command') {
      switch (trig.command as GroupCommand) {
        case 'me':
          await onMe(msg, trig.args, updateId);
          return true;
        case 'gora':
        case 'help':
        case 'start':
          await reply(msg, st('group_help', lang, { bot: s.telegram.botInfo.username }), `grphelp:${updateId}`);
          return true;
        case 'remember':
          await onRemember(msg, trig.args, updateId);
          return true;
        case 'forget':
          await onForget(msg, trig.args, updateId);
          return true;
        case 'groupmemory':
          await onGroupMemory(msg, updateId);
          return true;
        default:
          // Any other command addressed to us is treated like a mention.
          break;
      }
    }

    // Member input into the group conversation.
    const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : undefined;
    const raw = stripMention(msg.text ?? msg.caption ?? '', s.telegram.botInfo.username);
    const name = (msg.from.first_name || 'Member').replace(/[[\]\n]/g, ' ').slice(0, 64);
    try {
      const conv = s.conversations.resolve({ kind: 'group', chatId, ...(threadId ? { threadId } : {}) }, { userId: null, tgChatId: chatId, ...(threadId ? { threadId } : {}) });
      s.repos.inputs.add({
        conversationId: conv.id, kind: 'member', author: 'member', untrusted: false,
        content: [{ type: 'text', text: `[Member: ${name}] ${neutralizeReservedTags(raw || '…')}` }],
        tgUpdateId: updateId, tgChatId: chatId, tgMessageId: msg.message_id, fromTgUserId: msg.from.id, replyToCardId: null,
      });
      const r = msg.reply_to_message;
      if (r && r.from?.id !== s.telegram.botInfo.id) {
        const rt = r.text ?? r.caption ?? '';
        if (rt) {
          s.repos.inputs.add({
            conversationId: conv.id, kind: 'member', author: 'member', untrusted: true,
            content: [{ type: 'text', text: rt.slice(0, 4000) }],
            tgUpdateId: updateId, tgChatId: chatId, tgMessageId: r.message_id, fromTgUserId: r.from?.id ?? null, replyToCardId: null,
          });
        }
      }
      s.runner.kick(conv.id);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: ingest failed');
    }
    return true;
  }

  async function onRemember(msg: Message, args: string, updateId: number): Promise<void> {
    const lang = msg.from?.language_code;
    const text = args.trim();
    if (!text) {
      await reply(msg, st('group_remember_usage', lang), `grprem:${updateId}`);
      return;
    }
    const author = msg.from ? s.repos.users.getByTg(msg.from.id) : undefined;
    try {
      const res = await s.memory.save(scopeOf(msg.chat.id), {
        text: neutralizeReservedTags(text.slice(0, 500)), kind: 'group_decision', sensitivity: 'normal', explicit: true, authorUserId: author?.id ?? null,
        source: { kind: 'group_explicit', tgMessageId: msg.message_id },
      });
      if ('denied' in res) await reply(msg, st('group_remember_denied', lang, { reason: res.denied }), `grprem:${updateId}`);
      else await reply(msg, st('group_remembered', lang, { id: res.id }), `grprem:${updateId}`);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: remember failed');
      await reply(msg, st('something_wrong', lang), `grprem:${updateId}`);
    }
  }

  async function onForget(msg: Message, args: string, updateId: number): Promise<void> {
    const lang = msg.from?.language_code;
    const a = args.trim();
    if (!a || !msg.from) {
      await reply(msg, st('group_forget_usage', lang), `grpfg:${updateId}`);
      return;
    }
    const ids = a.split(/[\s,]+/).filter((x) => /^m[0-9a-z]{1,12}$/i.test(x));
    try {
      const res = await s.memory.forget(scopeOf(msg.chat.id), ids.length ? { ids } : { query: a.slice(0, 200) }, { tgUserId: msg.from.id });
      if (res.forgotten.length === 0) await reply(msg, st('group_forget_none', lang), `grpfg:${updateId}`);
      else await reply(msg, st('group_forgotten', lang, { what: res.forgotten.map((f) => `${f.id} ${esc(f.preview)}`).join('; ') }), `grpfg:${updateId}`);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: forget failed');
      await reply(msg, st('something_wrong', lang), `grpfg:${updateId}`);
    }
  }

  async function onGroupMemory(msg: Message, updateId: number): Promise<void> {
    const lang = msg.from?.language_code;
    try {
      const { items } = await s.memory.list(scopeOf(msg.chat.id), { limit: 30 });
      if (items.length === 0) {
        await reply(msg, st('group_memory_empty', lang), `grpmem:${updateId}`);
        return;
      }
      await reply(msg, [`📝 **${st('group_memory_title', lang)}**`, ...items.map((f) => `• \`${f.id}\` ${esc(f.text)}`)].join('\n'), `grpmem:${updateId}`);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: memory list failed');
      await reply(msg, st('something_wrong', lang), `grpmem:${updateId}`);
    }
  }

  /**
   * The /me question enters the DM as the owner's own words; the group title (set by any group admin) never does: it goes
   * in as a separate untrusted group_member input, so it is wrapped and taints the run (01 §11.2).
   */
  function addMeInputs(user: UserRow, q: string, title: string, o: { updateId: number | null; chat: ChatRef }): void {
    const t = title.replace(/\s+/g, ' ').trim().slice(0, 128);
    if (t) deps.dm.addOwnerText(user, `[title of the group the question was asked from] ${t}`, { ...o, kind: 'member', untrusted: true });
    deps.dm.addOwnerText(user, `${q}\n\n${st('me_from_group', langOf(user))}`, { ...o, kind: 'text' });
  }

  /** `/me <question>`: ephemeral acknowledgement (≤ 15 s) + the answer in the asker's DM conversation (⚠U5). */
  async function onMe(msg: Message, question: string, updateId: number): Promise<void> {
    const from = msg.from!;
    const lang = from.language_code;
    const ephemeralId = (msg as Message & { ephemeral_message_id?: number }).ephemeral_message_id;
    const title = 'title' in msg.chat ? (msg.chat.title ?? '') : '';
    const q = question.trim();
    const user = s.repos.users.getByTg(from.id);
    const hasDm = !!user && user.dmChatId !== null && !user.botBlocked && user.status !== 'deleting' && user.onboardingStep !== 'consent';

    let text: string;
    let keyboard: Keyboard | undefined;
    if (!q) text = st('me_usage', lang);
    else if (hasDm && user) {
      addMeInputs(user, q, title, { updateId, chat: { chatId: user.dmChatId! } });
      s.runner.kick(s.conversations.resolve({ kind: 'dm', tgUserId: user.tgUserId }, { userId: user.id, tgChatId: user.dmChatId! }).id);
      text = ephemeralId ? st('me_ack', lang) : st('me_public', lang);
    } else {
      const token = surf.deepLinks.create('me', from.id, { q: q.slice(0, 2000), g: title.slice(0, 128) }, ME_TOKEN_TTL_MS);
      text = st('me_start_hint', lang);
      keyboard = [[urlBtn(st('me_start_button', lang), deepLink(surf, `me_${token}`))]];
    }
    const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
    if (ephemeralId) {
      try {
        await s.telegram.api.sendMessage(msg.chat.id, text, {
          ephemeral_message_parameters: { receiver_user_id: from.id },
          reply_parameters: { ephemeral_message_id: ephemeralId },
          ...(msg.is_topic_message && msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
          ...markup,
        });
        return;
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'group: ephemeral ack failed; public fallback');
      }
    }
    // ⚠U5: no ephemeral id (or the ephemeral send failed) → a public reply; the DM is always the real answer.
    await reply(msg, q ? (keyboard ? text : st('me_public', lang)) : text, `grpme:${updateId}`, keyboard);
  }

  /** `/start me_<token>` in the DM. */
  async function continueMe(user: UserRow, token: string, chat: ChatRef, updateId: number | null): Promise<void> {
    const lang = langOf(user);
    const res = surf.deepLinks.consume(token, 'me', user.tgUserId);
    if ('error' in res) {
      await sendRich(surf, { ...chat, userId: user.id }, st(res.error === 'not_owner' ? 'link_other' : 'link_expired', lang), { idem: `me:${token}:${updateId ?? 'c'}` });
      return;
    }
    const p = (res.payload ?? {}) as { q?: string; g?: string };
    if (!p.q) return;
    addMeInputs(user, p.q, p.g ?? '', { updateId, chat });
    s.runner.kick(s.conversations.resolve({ kind: 'dm', tgUserId: user.tgUserId }, { userId: user.id, tgChatId: user.dmChatId ?? chat.chatId }).id);
  }

  return { onMyChatMember, onGroupMessage, continueMe, privateLink };
}
export type Group = ReturnType<typeof createGroup>;
