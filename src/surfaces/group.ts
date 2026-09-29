// src/surfaces/group.ts (WP7a) — group mode (01 F14, §10.3): Gora reads ONLY messages that mention it, reply to it,
// or are its commands; everything else is neither processed nor stored. Member input is `[Member: <name>] text`
// (mention stripped); a replied-to message that is not Gora's is untrusted (group_member). 30 triggers / 10 min per
// group, then one "short break" message. Group commands: /gora, /remember, /forget, /groupmemory, and the ephemeral
// `/me <question>` whose answer is produced in the asker's DM conversation (⚠U5 public fallback). my_chat_member:
// the groups row + intro on join, left_at on leave (the group's keys are destroyed 7 days later by the retention hook),
// users.bot_blocked for private chats.
// Spec 07 §C (GR): when s.groupAgent.readsAll() (privacy mode OFF), every member message is also observed (stored
// sealed, 14 days) but only answered when Gora is mentioned, replied to or addressed by name ("Гора, …"); chattiness
// words ("Гора, тише") are handled first; "что я пропустил?" / /catchup gives a private catch-up; an addressed message
// carries the recent group lines as ONE untrusted member input; the join line replaces the intro; /forget all purges.
import type { Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import type { ChatRef, GroupAddress, GroupChattiness, GroupObservedMessage, GroupParticipation, Scope, UserRow } from '../contracts/index.ts';
import { GROUP_CHATTINESS } from '../contracts/index.ts';
import { neutralizeReservedTags } from '../kernel/tags.ts';
import type { DmHandlers } from './dm.ts';
import { stripMention } from './guest.ts';
import { st } from './strings.ts';
import { deepLink, errName, langOf, sendPlain, sendRich, urlBtn, type Keyboard, type Surf } from './util.ts';

export const GROUP_COMMANDS = ['gora', 'remember', 'forget', 'groupmemory', 'me', 'catchup', 'help', 'start'] as const;
export type GroupCommand = (typeof GROUP_COMMANDS)[number];
export const ME_TOKEN_TTL_MS = 24 * 3_600_000;
const TEN_MIN = 10 * 60_000;

export type GroupTrigger = { kind: 'command'; command: string; args: string } | { kind: 'mention' } | { kind: 'reply' } | { kind: 'name' } | null;

/** C5 "что я пропустил?" / "what did I miss?" (after the "Гора," / @bot address is removed). */
const CATCHUP_RE = [
  /^(?:а\s+)?(?:что|чё|че|шо)\s+(?:я\s+)?пропустил[аи]?\s*[?!.]*$/iu,
  /^(?:что|чё|че)\s+(?:тут|здесь)\s+(?:было|произошло)\s*[?!.]*$/iu,
  /^what\s+did\s+i\s+miss\s*[?!.]*$/i,
  /^catch\s+me\s+up\s*[?!.]*$/i,
];
const NAME_PREFIX = /^[\s"'«(]*(?:(?:эй|ну|hey|hi)[\s,!]+)?(?:гора|горушка|gora)(?![\p{L}\p{N}_])[\s,!:.—-]*/iu;
export function isCatchupPhrase(text: string, botUsername: string): boolean {
  const t = stripMention(text, botUsername).replace(NAME_PREFIX, '').trim();
  return t.length > 0 && t.length <= 60 && CATCHUP_RE.some((r) => r.test(t));
}
const stepLevel = (cur: GroupChattiness, dir: 'quieter' | 'louder'): GroupChattiness => {
  const i = GROUP_CHATTINESS.indexOf(cur);
  return GROUP_CHATTINESS[dir === 'quieter' ? Math.max(0, i - 1) : Math.min(GROUP_CHATTINESS.length - 1, i + 1)]!;
};

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
  /** C1: the group participant mode (privacy mode OFF + features); false → the 01 F14 mention-only behaviour. */
  const readsAll = (): boolean => {
    try {
      return s.groupAgent.readsAll();
    } catch {
      return false;
    }
  };

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
      if (readsAll()) {
        // C2: ONE line in the group's language, no buttons (members must know Gora reads the chat)
        await s.groupAgent.onJoin(chatId, { ...(lang ? { lang } : {}), idem: `${chatId}:${ctx.update.update_id}` });
        return;
      }
      const kb: Keyboard = [[urlBtn(s.strings.t('use_privately_button', lang), privateLink(chatId))]];
      const sent = await sendRich(surf, { chatId }, st('group_intro', lang, { bot: s.telegram.botInfo.username }), { idem: `grpintro:${chatId}:${ctx.update.update_id}`, keyboard: kb });
      if (sent[0]) surf.groups.setIntro(chatId, sent[0].messageId);
    } else if (status === 'left' || status === 'kicked') {
      surf.groups.markLeft(chatId, status);
    }
  }

  /**
   * Returns true when the message was for Gora (handled), false when it is not answered. Privacy mode ON (01 F14): a
   * message that is not for Gora is neither processed nor stored. Privacy mode OFF (spec 07 C3): it is observed (stored
   * sealed for the summary, catch-up and chime-ins) but still not answered.
   */
  async function onGroupMessage(ctx: Context): Promise<boolean> {
    const msg = ctx.message;
    if (!msg || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') || !msg.from || msg.from.is_bot) return false;
    if (!s.config.features.groups) return false;
    const reads = readsAll();
    const bot = botRef();
    const chatId = msg.chat.id;
    const updateId = ctx.update.update_id;
    const lang = msg.from.language_code;
    let trig = groupTrigger(msg, bot);
    let text = msg.text ?? msg.caption ?? '';
    if (reads && !trig && text && s.groupAgent.addressedByName(text)) trig = { kind: 'name' };

    if (reads) {
      // C5: a catch-up request (the request itself is not stored, so "since your last message" stays right)
      if ((trig?.kind === 'command' && trig.command === 'catchup') || (trig?.kind !== 'command' && text && isCatchupPhrase(text, bot.username))) {
        if (trig || text.length <= 40) {
          await onCatchup(msg, updateId);
          return true;
        }
      }
      // C4: chattiness by words, addressed to Gora ("Гора, тише" / "@bot можешь чаще")
      if (trig && trig.kind !== 'command' && text) {
        const cw = s.groupAgent.chattinessFromWords(stripMention(text, bot.username));
        if (cw) {
          const cur = s.groupAgent.policy(chatId).chattiness;
          const level = cw === 'quieter' || cw === 'louder' ? stepLevel(cur, cw) : cw;
          s.groupAgent.setChattiness(chatId, level, { reason: 'words' });
          await observeMsg(msg, text, 'text', addressOf(trig));
          const louder = GROUP_CHATTINESS.indexOf(level) > GROUP_CHATTINESS.indexOf(cur) || (level === cur && cw === 'louder');
          const key = louder ? 'group_louder_ack' : level === 'quiet' ? 'group_quiet_ack' : 'group_quieter_ack';
          await reply(msg, st(key, lang), `grpchat:${updateId}`);
          return true;
        }
      }
      // C3: voice notes are stored as transcripts (background STT, only when available and the budget allows)
      if (!text && msg.voice && trig?.kind !== 'command') {
        const tr = await transcribeVoice(msg);
        if (tr) text = tr;
      }
      if (trig?.kind !== 'command' && text) await observeMsg(msg, text, msg.voice ? 'voice' : msg.text ? 'text' : 'caption', addressOf(trig));
    }
    if (!trig) return false; // not for us: never answered (and, with privacy mode ON, never stored)

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
        case 'catchup':
          // privacy mode ON (reading all messages handled /catchup above): nothing is stored → the usual help line
          await reply(msg, st('group_help', lang, { bot: s.telegram.botInfo.username }), `grphelp:${updateId}`);
          return true;
        default:
          // Any other command addressed to us is treated like a mention.
          break;
      }
    }

    // Member input into the group conversation.
    const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : undefined;
    const raw = stripMention(text, s.telegram.botInfo.username);
    const name = (msg.from.first_name || 'Member').replace(/[[\]\n]/g, ' ').slice(0, 64);
    try {
      const conv = s.conversations.resolve({ kind: 'group', chatId, ...(threadId ? { threadId } : {}) }, { userId: null, tgChatId: chatId, ...(threadId ? { threadId } : {}) });
      const r = msg.reply_to_message;
      const repliedText = r && r.from?.id !== s.telegram.botInfo.id ? (r.text ?? r.caption ?? '') : '';
      const member = () =>
        s.repos.inputs.add({
          conversationId: conv.id, kind: 'member', author: 'member', untrusted: false,
          content: [{ type: 'text', text: `[Member: ${name}] ${neutralizeReservedTags(raw || '…')}` }],
          tgUpdateId: updateId, tgChatId: chatId, tgMessageId: msg.message_id, fromTgUserId: msg.from!.id, replyToCardId: null,
        });
      if (reads) {
        // C3/C4: the recent group lines (+ summary) as ONE untrusted member input before the member's words; never
        // system context. A replied-to message of another member joins the same untrusted block.
        const gctx = s.groupAgent.recentContext(chatId, { excludeTgMessageId: msg.message_id, threadId: threadId ?? null }) ?? null;
        const block = [gctx, repliedText ? `The message being replied to:\n${repliedText.slice(0, 4000)}` : null].filter((x): x is string => !!x).join('\n\n');
        if (block) {
          s.repos.inputs.add({
            conversationId: conv.id, kind: 'member', author: 'member', untrusted: true,
            content: [{ type: 'text', text: block.slice(0, 12_000) }],
            tgUpdateId: updateId, tgChatId: chatId, tgMessageId: r && repliedText ? r.message_id : msg.message_id, fromTgUserId: r && repliedText ? (r.from?.id ?? null) : null, replyToCardId: null,
          });
        }
        member();
      } else {
        member();
        if (r && repliedText) {
          s.repos.inputs.add({
            conversationId: conv.id, kind: 'member', author: 'member', untrusted: true,
            content: [{ type: 'text', text: repliedText.slice(0, 4000) }],
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

  const addressOf = (t: GroupTrigger): GroupAddress => (t ? t.kind : null);

  /** C3: hand one member message to the group participant (stored sealed; never throws). */
  async function observeMsg(msg: Message, text: string, kind: GroupObservedMessage['kind'], addressed: GroupAddress): Promise<void> {
    if (!msg.from) return;
    try {
      const r = msg.reply_to_message;
      await s.groupAgent.observe({
        chatId: msg.chat.id,
        threadId: msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : null,
        tgMessageId: msg.message_id,
        fromTgId: msg.from.id,
        fromName: msg.from.first_name || 'Member',
        ...(msg.from.language_code ? { fromLang: msg.from.language_code } : {}),
        text: stripMention(text, s.telegram.botInfo.username) || text,
        kind,
        at: msg.date * 1000,
        replyToTgMessageId: r ? r.message_id : null,
        replyToBot: !!r && r.from?.id === s.telegram.botInfo.id,
        addressed,
      });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: observe failed');
    }
  }

  /** A short group voice note → transcript (priority background; skipped when STT is off or the budget is tight). */
  async function transcribeVoice(msg: Message): Promise<string | null> {
    const v = msg.voice;
    if (!v || v.duration > 120 || s.config.providers.stt === 'none') return null;
    try {
      if (!s.llmBudget.allow('background')) return null;
      const f = await s.telegram.files.download(v.file_id, 5 * 1024 * 1024);
      const res = await s.caps.stt.transcribe(f.bytes, { filename: `voice.${f.ext || 'ogg'}`, mime: v.mime_type ?? 'audio/ogg', priority: 'background' });
      return res.noSpeech ? null : res.text.trim().slice(0, 4000) || null;
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: voice transcript failed');
      return null;
    }
  }

  /**
   * C5 catch-up, delivered privately: an ephemeral reply when the request carries `ephemeral_message_id` (⚠U5), else a
   * DM (with a public one-line pointer), else a `me_` deep link that opens the DM and delivers it there.
   */
  async function onCatchup(msg: Message, updateId: number): Promise<void> {
    const from = msg.from!;
    const lang = from.language_code;
    const chatId = msg.chat.id;
    const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : null;
    const ephemeralId = (msg as Message & { ephemeral_message_id?: number }).ephemeral_message_id;
    const title = 'title' in msg.chat ? (msg.chat.title ?? '') : '';
    const user = s.repos.users.getByTg(from.id);
    const hasDm = !!user && user.dmChatId !== null && !user.botBlocked && user.status !== 'deleting';
    if (!ephemeralId && !hasDm) {
      const token = surf.deepLinks.create('me', from.id, { cu: chatId, ...(threadId ? { th: threadId } : {}), g: title.slice(0, 128) }, ME_TOKEN_TTL_MS);
      await reply(msg, st('group_catchup_start', lang), `grpcu:${updateId}`, [[urlBtn(st('me_start_button', lang), deepLink(surf, `me_${token}`))]]);
      return;
    }
    const body = await catchupText(chatId, from.id, lang, threadId, title);
    if (ephemeralId) {
      try {
        await s.telegram.api.sendMessage(chatId, body, {
          ephemeral_message_parameters: { receiver_user_id: from.id },
          reply_parameters: { ephemeral_message_id: ephemeralId },
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
        return;
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'group: ephemeral catch-up failed; DM fallback');
      }
    }
    if (hasDm && user) {
      await sendPlain(surf, { chatId: user.dmChatId!, userId: user.id }, body, { idem: `grpcu:dm:${updateId}` });
      await reply(msg, st('group_catchup_dm', lang), `grpcu:${updateId}`);
      return;
    }
    const token = surf.deepLinks.create('me', from.id, { cu: chatId, ...(threadId ? { th: threadId } : {}), g: title.slice(0, 128) }, ME_TOKEN_TTL_MS);
    await reply(msg, st('group_catchup_start', lang), `grpcu:${updateId}`, [[urlBtn(st('me_start_button', lang), deepLink(surf, `me_${token}`))]]);
  }

  async function catchupText(chatId: number, tgUserId: number, lang: string | undefined, threadId: number | null, title: string): Promise<string> {
    let text: string | null = null;
    try {
      text = await s.groupAgent.catchup(chatId, tgUserId, { ...(lang ? { lang } : {}), threadId });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: catch-up failed');
    }
    if (!text) return st('group_catchup_none', lang);
    const head = title.trim() ? st('group_catchup_title', lang, { group: title.replace(/\s+/g, ' ').trim().slice(0, 64) }) : st('group_catchup_title_plain', lang);
    return `${head}\n${text}`.slice(0, 4000);
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
    if (/^(?:all|everything|всё|все)$/iu.test(a)) {
      await onForgetAll(msg, updateId);
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

  /**
   * `/forget all|всё` (spec 07 C3): the stored group messages and summary are purged (any member may ask; chattiness is a
   * setting and stays), and the group memory facts are forgotten as far as this member may (their own, or all for an admin).
   */
  async function onForgetAll(msg: Message, updateId: number): Promise<void> {
    const lang = msg.from?.language_code;
    const chatId = msg.chat.id;
    try {
      await s.groupAgent.purge(chatId, 'forget');
      const { items } = await s.memory.list(scopeOf(chatId), { limit: 200 });
      let kept = 0;
      if (items.length && msg.from) {
        const res = await s.memory.forget(scopeOf(chatId), { ids: items.map((f) => f.id) }, { tgUserId: msg.from.id });
        kept = items.length - res.forgotten.length;
      }
      // honest reply (s07 lead fix): say what stayed (other members' /remember notes need their author or an admin)
      await reply(msg, kept > 0 ? st('group_forget_all_partial', lang, { n: String(kept) }) : st('group_forget_all', lang), `grpfg:${updateId}`);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: forget all failed');
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
    const p = (res.payload ?? {}) as { q?: string; g?: string; cu?: number; th?: number };
    if (typeof p.cu === 'number') {
      // C5: a group catch-up requested before this DM existed → delivered here (not an agent run: no DM request sees it)
      const body = await catchupText(p.cu, user.tgUserId, lang, typeof p.th === 'number' ? p.th : null, p.g ?? '');
      await sendPlain(surf, { ...chat, userId: user.id }, body, { idem: `me:${token}:cu` });
      return;
    }
    if (!p.q) return;
    addMeInputs(user, p.q, p.g ?? '', { updateId, chat });
    s.runner.kick(s.conversations.resolve({ kind: 'dm', tgUserId: user.tgUserId }, { userId: user.id, tgChatId: user.dmChatId ?? chat.chatId }).id);
  }

  /**
   * A member edited a group message (reads-all mode, s07 lead fix): the stored copy follows the edit (Telegram never
   * delivers deletions; an edit that removes personal details must reach what Gora keeps). Nothing is answered.
   */
  async function onGroupEdited(ctx: Context): Promise<void> {
    const msg = ctx.editedMessage;
    if (!msg?.from || msg.from.is_bot || !s.groupAgent.readsAll()) return;
    const text = msg.text ?? msg.caption ?? '';
    try {
      await s.groupAgent.onEdited({ chatId: msg.chat.id, tgMessageId: msg.message_id, fromTgId: msg.from.id, text: stripMention(text, s.telegram.botInfo.username) || text, at: (msg.edit_date ?? msg.date) * 1000 });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'group: edit failed');
    }
  }

  return { onMyChatMember, onGroupMessage, onGroupEdited, continueMe, privateLink };
}
export type Group = ReturnType<typeof createGroup>;
