// src/surfaces/util.ts (WP7a) — shared plumbing for the surfaces module: the internal context object, send/edit
// helpers over the outbox (the rich → entities → plain chain lives in WP2's outbox), buttons and callback encoding.
import type { Bot } from 'grammy';
import type { ForceReply, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, ReplyKeyboardRemove } from 'grammy/types';
import type { CallbackKind, Logger, OutboxRequest, SentRef, Services, UserId, UserRow } from '../contracts/index.ts';
import type { BillingRepo, createChoices, createDeepLinks, createGroupsRepo, createGuestRepo } from './repo.ts';

export interface Surf {
  s: Services;
  log: Logger;
  deepLinks: ReturnType<typeof createDeepLinks>;
  choices: ReturnType<typeof createChoices>;
  groups: ReturnType<typeof createGroupsRepo>;
  guests: ReturnType<typeof createGuestRepo>;
  billing: BillingRepo;
  /** Set by registerHandlers (used to replay a stored /start payload after consent). */
  bot: Bot | null;
}

export type Button = InlineKeyboardButton & { style?: 'success' | 'danger' | 'primary' };
export type Keyboard = Button[][];

export const langOf = (u: Pick<UserRow, 'languageCode'> | undefined | null): string => u?.languageCode ?? 'en';

export function cb(surf: Surf, kind: CallbackKind, parts: string[], ownerTgId: number): string {
  return surf.s.telegram.codec.encode(kind, parts, ownerTgId);
}
export function cbBtn(surf: Surf, text: string, kind: CallbackKind, parts: string[], ownerTgId: number, style?: Button['style']): Button {
  const b = { text, callback_data: cb(surf, kind, parts, ownerTgId) } as Button;
  if (style) b.style = style;
  return b;
}
export const urlBtn = (text: string, url: string): Button => ({ text, url }) as Button;
export const webAppBtn = (text: string, url: string): Button => ({ text, web_app: { url } }) as Button;
export const appUrl = (surf: Surf, screen: string): string => `${surf.s.config.publicUrl}/app/?screen=${encodeURIComponent(screen)}`;
export const botUsername = (surf: Surf): string => surf.s.telegram.botInfo.username;
export const deepLink = (surf: Surf, payload: string): string => `https://t.me/${botUsername(surf)}?start=${payload}`;

export interface Target { chatId: number; threadId?: number; userId?: UserId | null }

export type Markup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply;

interface SendOpts { idem: string; keyboard?: Keyboard; markup?: Markup; replyTo?: number; silent?: boolean; priority?: 0 | 1 | 5 | 9 }

function base(to: Target, o: SendOpts): Omit<OutboxRequest, 'method' | 'payload'> & { payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {};
  if (o.keyboard) payload['reply_markup'] = { inline_keyboard: o.keyboard };
  else if (o.markup) payload['reply_markup'] = o.markup;
  if (o.replyTo) payload['reply_parameters'] = { message_id: o.replyTo, allow_sending_without_reply: true };
  return {
    idempotencyKey: o.idem,
    ...(to.userId ? { userId: to.userId } : {}),
    chatId: to.chatId,
    ...(to.threadId ? { threadId: to.threadId } : {}),
    ...(o.silent ? { disableNotification: true } : {}),
    priority: o.priority ?? 0,
    payload,
  };
}

/** A rich message (markdown) sent now through the outbox; the caller usually needs the message id. Never throws. */
export async function sendRich(surf: Surf, to: Target, markdown: string, o: SendOpts): Promise<SentRef[]> {
  try {
    return await surf.s.telegram.outbox.sendNow({ ...base(to, o), method: 'sendRichMessage', markdown });
  } catch (e) {
    surf.log.warn({ err: errName(e), chatId: to.chatId, idem: o.idem }, 'surfaces: rich send failed');
    return [];
  }
}

/** A plain text message (reply keyboards, force_reply prompts). Never throws. */
export async function sendPlain(surf: Surf, to: Target, text: string, o: SendOpts): Promise<SentRef[]> {
  try {
    const b = base(to, o);
    return await surf.s.telegram.outbox.sendNow({ ...b, method: 'sendMessage', payload: { text, ...b.payload } });
  } catch (e) {
    surf.log.warn({ err: errName(e), chatId: to.chatId, idem: o.idem }, 'surfaces: send failed');
    return [];
  }
}

/** Queue (not send now) a rich message; for notices that need no message id. */
export function enqueueRich(surf: Surf, to: Target, markdown: string, o: SendOpts & { refKind?: string; refId?: string }): void {
  try {
    surf.s.telegram.outbox.enqueue({ ...base(to, o), method: 'sendRichMessage', markdown, ...(o.refKind ? { refKind: o.refKind } : {}), ...(o.refId ? { refId: o.refId } : {}) });
  } catch (e) {
    surf.log.warn({ err: errName(e), chatId: to.chatId, idem: o.idem }, 'surfaces: enqueue failed');
  }
}

/** Replace a card's text (and keyboard; `null` removes it). Sent now so it lands before any follow-up card; never throws. */
export async function editCard(surf: Surf, to: Target & { messageId: number }, markdown: string, keyboard: Keyboard | null, idem: string): Promise<void> {
  try {
    await surf.s.telegram.outbox.sendNow({
      idempotencyKey: idem,
      ...(to.userId ? { userId: to.userId } : {}),
      chatId: to.chatId,
      method: 'editMessageText',
      payload: { message_id: to.messageId, reply_markup: { inline_keyboard: keyboard ?? [] } },
      markdown,
      priority: 0,
    });
  } catch (e) {
    surf.log.warn({ err: errName(e), chatId: to.chatId }, 'surfaces: edit failed');
  }
}

/** Remove (or replace) only the inline keyboard of a message. Sent now; never throws (⚠U7 400s are logged). */
export async function setKeyboard(surf: Surf, to: Target & { messageId: number }, keyboard: Keyboard | null, idem: string): Promise<void> {
  try {
    await surf.s.telegram.outbox.sendNow({
      idempotencyKey: idem,
      ...(to.userId ? { userId: to.userId } : {}),
      chatId: to.chatId,
      method: 'editMessageReplyMarkup',
      payload: { message_id: to.messageId, reply_markup: { inline_keyboard: keyboard ?? [] } },
      priority: 0,
    });
  } catch (e) {
    surf.log.warn({ err: errName(e), chatId: to.chatId }, 'surfaces: keyboard edit failed');
  }
}

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** Plain text of a markdown answer, for TTS and previews: drops tags, code fences, links' urls and emphasis marks. */
export function plainOf(md: string): string {
  return md
    .replace(/<details>[\s\S]*?<\/details>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~#>|]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cut at a sentence (or word) boundary, ≤ max chars. */
export function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('.\n'));
  if (sentence > max * 0.5) return head.slice(0, sentence + 1);
  const sp = head.lastIndexOf(' ');
  return (sp > max * 0.5 ? head.slice(0, sp) : head).trimEnd() + '…';
}

/** The owner's DM conversation (main chat or a DM topic; a mission topic routes to 'mission:<id>', 01 §5.1). */
export function dmConversation(surf: Surf, user: UserRow, threadId?: number): import('../contracts/index.ts').ConversationRow {
  const { s } = surf;
  const chatId = user.dmChatId ?? user.tgUserId;
  if (threadId) {
    let kind: ReturnType<Services['telegram']['topics']['lookup']> = null;
    try {
      kind = s.telegram.topics.lookup(user.id, threadId);
    } catch {
      kind = null;
    }
    if (kind?.kind === 'mission' && kind.missionId) {
      return s.conversations.resolve({ kind: 'mission', missionId: kind.missionId }, { userId: user.id, tgChatId: chatId, threadId });
    }
    return s.conversations.resolve({ kind: 'dm', tgUserId: user.tgUserId, threadId }, { userId: user.id, tgChatId: chatId, threadId });
  }
  return s.conversations.resolve({ kind: 'dm', tgUserId: user.tgUserId }, { userId: user.id, tgChatId: chatId });
}

/**
 * F8: a topic-less (fallback) mission lives in the main DM as conversation 'mission:<id>'. An owner message in the main
 * DM (no thread) that replies to a bot message recorded for such a mission's conversation (its status card, kind
 * 'status', or anything its run sent) goes to that mission conversation, so a run parked on task_wait(['user_input'])
 * wakes. Missions with a topic, or that are no longer active/parked, keep the normal DM routing. Null → DM routing.
 */
export function missionReplyConversation(surf: Surf, user: UserRow, chatId: number, replyToMessageId: number | undefined): import('../contracts/index.ts').ConversationRow | null {
  const { s } = surf;
  if (!replyToMessageId) return null;
  try {
    const link = s.telegram.links.lookup(chatId, replyToMessageId);
    if (!link?.conversationId || (link.userId !== null && link.userId !== user.id)) return null;
    const conv = s.repos.conversations.get(link.conversationId);
    if (!conv || conv.kind !== 'mission' || conv.userId !== user.id || conv.status !== 'active' || conv.threadId !== null) return null;
    const missionId = conv.scopeKey.startsWith('mission:') ? conv.scopeKey.slice('mission:'.length) : null;
    if (!missionId) return null;
    const m = s.missions.get(missionId);
    if (!m || m.threadId !== null || (m.status !== 'active' && m.status !== 'parked')) return null;
    return s.conversations.resolve({ kind: 'mission', missionId }, { userId: user.id, tgChatId: user.dmChatId ?? user.tgUserId });
  } catch {
    return null;
  }
}

/** "UTC+5", "UTC−3:30", "UTC". */
export function utcOffsetLabel(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC';
  const sign = offsetMin > 0 ? '+' : '−';
  const a = Math.abs(offsetMin);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}
