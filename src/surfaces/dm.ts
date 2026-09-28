// src/surfaces/dm.ts (WP7a) — private-chat ingest (01 §10.1 rows 1–2, F2/F3): owner messages become
// conversation_inputs (idempotent per update id) and kick the runner; media goes through caps.media (STT quota
// checked first); forwards are untrusted; a typed "yes" never approves anything (it re-shows the cards, §11.3 item 6);
// edits replace an unconsumed input or append "✏️ Edited: …" within 10 min; payments and topic events are routed.
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { BetaContentBlockParam, ChatRef, UserRow } from '../contracts/index.ts';
import type { LocationHandlers } from './location.ts';
import type { Onboarding } from './onboarding.ts';
import type { PaymentsModule } from './payments.ts';
import type { TzGuesser } from './tz.ts';
import { st } from './strings.ts';
import { dmConversation, errName, langOf, missionReplyConversation, sendRich, type Surf } from './util.ts';

export const EDIT_APPEND_WINDOW_MS = 10 * 60_000;
/** F11 (02 §C): the photo messages of one album arrive as separate updates; parts within this window are merged. */
export const ALBUM_WINDOW_MS = 1_500;
const ALBUM_MAX_PARTS = 10;
const YES_RE = /^\s*(yes|yep|yeah|ok|okay|approve|approved|confirm|go ahead|да|ага|ок|одобряю|одобрить|подтверждаю)\s*[.!]*\s*$/i;

export interface DmHandlers {
  onMessage(ctx: Context): Promise<void>;
  onEdited(ctx: Context): Promise<void>;
  /** Owner text into the DM conversation (used by /start g_ and me_, chips). */
  addOwnerText(user: UserRow, text: string, o: { updateId: number | null; chat: ChatRef; messageId?: number | null; kind?: 'text' | 'guest' | 'choice' | 'command' | 'member'; untrusted?: boolean; threadId?: number }): string;
}

export function forwardLabel(m: Message): string {
  const o = m.forward_origin;
  if (!o) return 'forwarded message';
  switch (o.type) {
    case 'user':
      return `forwarded from ${o.sender_user.first_name}`;
    case 'hidden_user':
      return `forwarded from ${o.sender_user_name}`;
    case 'chat':
      return `forwarded from ${'title' in o.sender_chat && o.sender_chat.title ? o.sender_chat.title : 'a chat'}`;
    case 'channel':
      return `forwarded from ${'title' in o.chat && o.chat.title ? o.chat.title : 'a channel'}`;
    default:
      return 'forwarded message';
  }
}

export function createDm(surf: Surf, deps: { ob: Onboarding; payments: PaymentsModule; location: LocationHandlers; tz: TzGuesser }): DmHandlers {
  const { s } = surf;
  const L = s.config.limits;

  function addOwnerText(user: UserRow, text: string, o: Parameters<DmHandlers['addOwnerText']>[2]): string {
    const conv = dmConversation(surf, user, o.threadId);
    return s.repos.inputs.add({
      conversationId: conv.id, kind: o.kind ?? 'text', author: 'owner', untrusted: !!o.untrusted, content: [{ type: 'text', text }],
      tgUpdateId: o.updateId, tgChatId: o.chat.chatId, tgMessageId: o.messageId ?? null, fromTgUserId: user.tgUserId, replyToCardId: null,
    });
  }

  /** Owner input → the conversation (a reply to a topic-less mission's message goes to that mission, F8) → kick. */
  function commit(user: UserRow, msg: Message, updateId: number, threadId: number | undefined, kind: 'text' | 'voice' | 'photo' | 'document' | 'forward', untrusted: boolean, content: BetaContentBlockParam[]): void {
    let replyToCardId: string | null = null;
    const r = msg.reply_to_message;
    const toBot = !!r && r.from?.id === s.telegram.botInfo.id;
    if (r && toBot) {
      try {
        replyToCardId = s.telegram.links.lookup(msg.chat.id, r.message_id)?.pendingActionId ?? null;
      } catch {
        replyToCardId = null;
      }
    }
    const conv = (!threadId && toBot ? missionReplyConversation(surf, user, msg.chat.id, r!.message_id) : null) ?? dmConversation(surf, user, threadId);
    s.repos.inputs.add({
      conversationId: conv.id, kind, author: 'owner', untrusted, content,
      tgUpdateId: updateId, tgChatId: msg.chat.id, tgMessageId: msg.message_id, fromTgUserId: user.tgUserId, replyToCardId,
    });
    // spec 05 C1 (friend foundation): owner-authored private input → behaviour signals (features only, never stored text)
    if (!untrusted) {
      try {
        const said = content.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
        s.signals.inbound(user.id, { at: s.clock.now(), text: said, replyToTgMessageId: toBot ? r!.message_id : null });
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'dm: signals.inbound failed');
      }
    }
    s.runner.kick(conv.id);
  }

  // ── F11: album buffering (in memory; a crash inside the 1.5 s window loses that album, like an undelivered update)
  const albums = new Map<string, { userId: string; parts: Array<{ msg: Message; updateId: number }>; timer: unknown }>();

  function bufferAlbum(user: UserRow, msg: Message, updateId: number): void {
    const key = `${user.id}:${msg.media_group_id}`;
    const a = albums.get(key) ?? { userId: user.id, parts: [], timer: null };
    if (a.parts.some((p) => p.updateId === updateId)) return; // redelivered update
    a.parts.push({ msg, updateId });
    if (a.timer !== null) s.clock.clearTimeout(a.timer);
    a.timer = null;
    albums.set(key, a);
    if (a.parts.length >= ALBUM_MAX_PARTS) void flushAlbum(key);
    else a.timer = s.clock.setTimeout(() => void flushAlbum(key), ALBUM_WINDOW_MS);
  }

  async function flushAlbum(key: string): Promise<void> {
    const a = albums.get(key);
    if (!a) return;
    albums.delete(key);
    try {
      const user = s.repos.users.getById(a.userId);
      if (!user || user.status === 'deleting') return;
      const parts = [...a.parts].sort((x, y) => x.msg.message_id - y.msg.message_id);
      const first = parts[0]!;
      const msg = first.msg;
      const lang = langOf(user);
      const threadId = msg.message_thread_id && msg.is_topic_message ? msg.message_thread_id : undefined;
      const to = { chatId: msg.chat.id, ...(threadId ? { threadId } : {}), userId: user.id };
      let res: Awaited<ReturnType<typeof s.caps.media.fromMessage>>;
      try {
        res = await s.caps.media.fromAlbum!(parts.map((p) => p.msg), { userId: user.id, dek: `u:${user.id}`, lang });
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'dm: album ingest failed');
        await sendRich(surf, to, st('something_wrong', lang), { idem: `media:${first.updateId}` });
        return;
      }
      if ('rejected' in res) {
        await sendRich(surf, to, res.rejected, { idem: `media:${first.updateId}` });
        return;
      }
      const forwarded = parts.some((p) => p.msg.forward_origin);
      commit(user, msg, first.updateId, threadId, forwarded ? 'forward' : 'photo', forwarded || res.untrusted, res.blocks);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'dm: album flush failed');
    }
  }

  async function onMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
    const updateId = ctx.update.update_id;
    let user = s.repos.users.upsertFromTelegram(msg.from, { dmChatId: msg.chat.id });
    if (user.status === 'deleting') return;
    if (user.botBlocked) {
      s.repos.users.update(user.id, { botBlocked: false });
      user = { ...user, botBlocked: false };
    }
    // 05 A1/A3: the first message records the description's memory notice (once); no onboarding step exists any more.
    user = deps.ob.firstContact(user);
    const lang = langOf(user);
    const threadId = msg.message_thread_id && msg.is_topic_message ? msg.message_thread_id : undefined;
    const chat: ChatRef = { chatId: msg.chat.id, ...(threadId ? { threadId } : {}) };
    const to = { ...chat, userId: user.id };

    if (msg.successful_payment) {
      await deps.payments.onSuccessfulPayment(msg);
      return;
    }
    if (msg.forum_topic_created) {
      if (threadId || msg.message_thread_id) s.telegram.topics.onUserTopicCreated(user.id, user.tgUserId, msg.message_thread_id!, !!msg.forum_topic_created.is_name_implicit);
      return;
    }
    if (msg.forum_topic_edited || msg.forum_topic_closed || msg.forum_topic_reopened || msg.pinned_message) return;

    // §11.8 per-user inbound rate: 20/min (burst handled by the dispatcher); one "slow down" per minute.
    if (!s.quotas.rate(`dm:${user.tgUserId}`, L.userMsgsPerMinute, 60_000)) {
      if (s.quotas.rate(`dmslow:${user.tgUserId}`, 1, 60_000)) await sendRich(surf, to, s.strings.t('slow_down', lang), { idem: `slow:${updateId}` });
      return;
    }

    if (msg.location) {
      // A forwarded pin/venue is someone else's point, and a venue is a place the owner picked, not where they are:
      // neither touches location_state or the time zone, and forwards keep their provenance (untrusted).
      if (msg.forward_origin || msg.venue) {
        deps.location.onPlace(user, { location: msg.location, ...(msg.venue ? { venue: msg.venue } : {}), forwardedFrom: msg.forward_origin ? forwardLabel(msg) : null }, { ...chat, messageId: msg.message_id }, updateId);
        return;
      }
      await deps.location.onShare(user, msg.location, { ...chat, messageId: msg.message_id }, updateId);
      return;
    }

    const text = msg.text ?? null;
    if (text !== null && !msg.forward_origin) {
      // Explicit awaits only (a paste after /import, a city after [Change time zone]); main chat only.
      if (!threadId && (await deps.ob.interceptText(user, text, chat, { ...(msg.reply_to_message ? { replyToMessageId: msg.reply_to_message.message_id } : {}), updateId }))) return;
      // A typed "yes" never approves: it re-shows the pending cards (tap_the_card) — 01 §11.3 item 6.
      if (YES_RE.test(text)) {
        let n = 0;
        try {
          n = await s.approvals.reshowPending(user.id, chat);
        } catch (e) {
          surf.log.warn({ err: errName(e) }, 'dm: reshowPending failed');
        }
        if (n > 0) return;
      }
    }

    // Build the input.
    let content: BetaContentBlockParam[];
    let kind: 'text' | 'voice' | 'photo' | 'document' | 'forward' = 'text';
    let untrusted = false;
    const hasMedia = !!(msg.voice || msg.audio || msg.video_note || msg.photo || msg.document || msg.video || msg.sticker || msg.animation);
    if (msg.media_group_id && msg.photo?.length && s.caps.media.fromAlbum) {
      bufferAlbum(user, msg, updateId); // F11: one input + one vision call per album
      return;
    }
    if (hasMedia) {
      const durationSec = msg.voice?.duration ?? msg.audio?.duration ?? msg.video_note?.duration ?? 0;
      if (durationSec > 0) {
        const q = s.quotas.check(user.id, 'stt_seconds', durationSec);
        if (!q.ok) {
          await s.notices.quotaExceeded(user.id, 'stt_seconds', chat);
          return;
        }
      }
      let res: Awaited<ReturnType<typeof s.caps.media.fromMessage>>;
      try {
        res = await s.caps.media.fromMessage(msg, { userId: user.id, dek: `u:${user.id}`, lang });
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'dm: media ingest failed');
        await sendRich(surf, to, st('something_wrong', lang), { idem: `media:${updateId}` });
        return;
      }
      if ('rejected' in res) {
        await sendRich(surf, to, res.rejected, { idem: `media:${updateId}` });
        return;
      }
      if (res.sttSeconds > 0) s.quotas.consume(user.id, 'stt_seconds', Math.ceil(res.sttSeconds));
      content = res.blocks;
      kind = res.kind === 'voice' || res.kind === 'photo' || res.kind === 'document' ? res.kind : 'text';
      untrusted = res.untrusted;
      if (msg.forward_origin) {
        kind = 'forward';
        untrusted = true;
      }
    } else if (text !== null || msg.caption) {
      const body = text ?? msg.caption ?? '';
      if (msg.forward_origin) {
        kind = 'forward';
        untrusted = true;
        content = [{ type: 'text', text: `[${forwardLabel(msg)}]\n${body}` }];
      } else {
        content = [{ type: 'text', text: body }];
      }
    } else {
      return; // service messages, contacts, polls… are not inputs in v1
    }

    // Unknown slash commands are answered, not sent to the model.
    if (kind === 'text' && text && /^\/[A-Za-z0-9_]+(@\w+)?(\s|$)/.test(text)) {
      await sendRich(surf, to, st('unknown_command', lang), { idem: `unk:${updateId}` });
      return;
    }

    // 05 A6: refresh the best-guess zone before the run (a city the owner names about themselves confirms it silently).
    if (user.tzSource === 'default') user = await deps.tz.refresh(user, !untrusted && text !== null ? { text } : {});

    commit(user, msg, updateId, threadId, kind, untrusted, content);
  }

  async function onEdited(ctx: Context): Promise<void> {
    const msg = ctx.editedMessage;
    if (!msg || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
    const user = s.repos.users.getByTg(msg.from.id);
    if (!user || user.status === 'deleting') return;
    if (msg.location) {
      deps.location.onLiveEdit(user, msg.location);
      return;
    }
    const text = msg.text ?? msg.caption;
    if (!text) return;
    const threadId = msg.message_thread_id && msg.is_topic_message ? msg.message_thread_id : undefined;
    const r = msg.reply_to_message;
    const conv = (!threadId && r && r.from?.id === s.telegram.botInfo.id ? missionReplyConversation(surf, user, msg.chat.id, r.message_id) : null) ?? dmConversation(surf, user, threadId);
    const input = s.repos.inputs.byTgMessage(conv.id, msg.chat.id, msg.message_id);
    if (!input || input.author !== 'owner') return;
    if (input.consumedRunId === null) {
      if (input.untrusted || (input.kind !== 'text' && input.kind !== 'forward')) return;
      if (s.repos.inputs.replaceUnconsumed(input.id, [{ type: 'text', text }])) return;
    }
    const editedAt = (msg.edit_date ?? msg.date) * 1000;
    if (editedAt - input.createdAt > EDIT_APPEND_WINDOW_MS) return;
    s.repos.inputs.add({
      conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: `✏️ Edited: ${text}` }],
      tgUpdateId: ctx.update.update_id, tgChatId: msg.chat.id, tgMessageId: msg.message_id, fromTgUserId: user.tgUserId, replyToCardId: null,
    });
    s.runner.kick(conv.id);
  }

  return { onMessage, onEdited, addOwnerText };
}
