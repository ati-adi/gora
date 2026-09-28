// surfaces/business/send.ts (WP7b) — sending an approved reply (01 §10.2 step 5) and the 24 h window (step 6).
// Consent, is_enabled, can_reply and window_expires_at > now are re-checked right before the send (Sentinel S07 does
// the same on propose and execute). Send: sendChatAction('typing') then sendMessage(text, entities) with
// business_connection_id (rich only behind FEATURE_BUSINESS_RICH, ⚠U6). The business_window job closes the cards at
// the window's end and hands the owner the draft to copy ([📋 Copy] only when ≤ 256 chars).
import type { InlineKeyboardButton } from 'grammy/types';
import type { JobResult, Ms, SentRef, UserId } from '../../contracts/index.ts';
import {
  chatRef, chatSourceRef, codeFence, COPY_TEXT_MAX, DAY_MS, errName, inboxOf, ledger, ownerOf, parseChatRef, windowJobKey, type Biz,
} from './core.ts';
import { canReply, connectionLive, draftCards, windowOpen } from './drafting.ts';
import { bt } from './text.ts';

export type BizContext = { connectionId: string; chatId: number; consented: boolean; enabled: boolean; canReply: boolean; windowOpen: boolean; windowExpiresAt: Ms | null };

export function contextOf(b: Biz, userId: UserId, ref: string): BizContext | null {
  const p = parseChatRef(ref);
  if (!p) return null;
  const conn = b.repo.getConnection(p.connectionId);
  if (!conn || conn.userId !== userId) return null;
  const chat = b.repo.getChat(p.connectionId, p.chatId);
  const now = b.s.clock.now();
  return {
    connectionId: conn.id,
    chatId: p.chatId,
    consented: !!chat?.aiEnabled && chat.consentId !== null,
    enabled: connectionLive(conn),
    canReply: canReply(conn),
    windowOpen: windowOpen(chat, now),
    windowExpiresAt: chat?.windowExpiresAt ?? null,
  };
}

export type SendResult = { messageId: number } | { error: 'window_closed' | 'no_rights' | 'disabled' | 'not_consented' };

/** Idempotent per idemKey (outbox idempotency keys 'biz:send:<idemKey>:<part>'). */
export async function sendReply(b: Biz, p: { userId: UserId; ref: string; text: string; idemKey: string; replyTo?: number }): Promise<SendResult> {
  const { s, repo } = b;
  const ctx = contextOf(b, p.userId, p.ref);
  if (!ctx || !ctx.consented) return { error: 'not_consented' };
  if (!ctx.enabled) return { error: 'disabled' };
  if (!ctx.canReply) return { error: 'no_rights' };
  if (!ctx.windowOpen) return { error: 'window_closed' };
  const text = p.text.trim();
  if (!text) throw new Error('empty reply');
  const base = { userId: p.userId, chatId: ctx.chatId, businessConnectionId: ctx.connectionId, priority: 0 as const };
  try {
    await s.telegram.outbox.sendNow({ ...base, idempotencyKey: `biz:typing:${p.idemKey}`, method: 'sendChatAction', payload: { action: 'typing' } });
  } catch (e) {
    b.log.debug({ err: errName(e) }, 'business: typing action failed');
  }
  const replyTo = p.replyTo && repo.messageIds(ctx.connectionId, ctx.chatId, [p.replyTo]).length ? p.replyTo : undefined;
  const replyParams = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
  const sent: SentRef[] = [];
  if (s.config.features.businessRich) {
    sent.push(...(await s.telegram.outbox.sendNow({ ...base, idempotencyKey: `biz:send:${p.idemKey}:0`, method: 'sendRichMessage', payload: { ...replyParams }, markdown: text })));
  } else {
    const chunks = s.telegram.render.toEntities(text);
    if (!chunks.length) throw new Error('empty reply');
    for (const [i, c] of chunks.entries()) {
      const payload: Record<string, unknown> = { text: c.text, ...(c.entities.length ? { entities: c.entities } : {}), ...(i === 0 ? replyParams : {}) };
      sent.push(...(await s.telegram.outbox.sendNow({ ...base, idempotencyKey: `biz:send:${p.idemKey}:${i}`, method: 'sendMessage', payload })));
    }
  }
  const first = sent[0];
  if (!first) throw new Error('send returned no message');
  const now = s.clock.now();
  let fresh = false;
  for (const [i, r] of sent.entries()) {
    try {
      const inserted = repo.addMessage({ connectionId: ctx.connectionId, chatId: ctx.chatId, messageId: r.messageId, fromOwner: true, viaBot: true, date: now, text: i === 0 ? text : '', mediaKind: i === 0 ? null : 'continuation', now });
      if (i === 0) fresh = inserted;
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: storing the sent reply failed');
    }
  }
  if (!fresh && repo.messageIds(ctx.connectionId, ctx.chatId, [first.messageId]).length) return { messageId: first.messageId }; // a repeat of an idempotent send
  repo.noteOwner(ctx.connectionId, ctx.chatId, now);
  ledger(b, { userId: p.userId, actor: 'agent', kind: 'message_sent', summary: 'Secretary reply sent', detail: { chat: chatRef(ctx.connectionId, ctx.chatId), messageId: first.messageId } });
  return { messageId: first.messageId };
}

/** Schedules (or moves) the business_window job of a consented chat to the window's end. */
export function scheduleWindow(b: Biz, userId: UserId, connectionId: string, chatId: number, windowEnd: Ms): void {
  try {
    b.s.scheduler.schedule({ kind: 'business_window', runAt: windowEnd, userId, refId: chatRef(connectionId, chatId), payload: { conn: connectionId, chat: chatId }, dedupeKey: windowJobKey(connectionId, chatId), maxAttempts: 5 });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: window job schedule failed');
  }
}

/**
 * The copy fallback: the closed-window notice with the draft as a code block and [📋 Copy] when ≤ 256 chars. When the
 * approval card's message is known (PendingActionView.card) the card itself is edited into it (01 §10.2 step 6);
 * otherwise a new message goes to the Inbox topic.
 */
export async function sendCopyFallback(b: Biz, p: { userId: UserId; pendingActionId: string; draft: string; chat: { chatId: number; threadId?: number }; card?: { chatId: number; messageId: number | null } }): Promise<void> {
  const { s } = b;
  const u = ownerOf(b, p.userId);
  const lang = u?.languageCode ?? 'en';
  const markdown = `${s.telegram.render.escape(bt('window_closed', lang))}\n\n${codeFence(p.draft)}`;
  const keyboard: InlineKeyboardButton[][] = p.draft.length <= COPY_TEXT_MAX ? [[{ text: bt('btn_copy', lang), copy_text: { text: p.draft } } as InlineKeyboardButton]] : [];
  if (p.card && p.card.messageId !== null) {
    s.telegram.outbox.enqueue({
      idempotencyKey: `bizwin:${p.pendingActionId}`,
      userId: p.userId,
      chatId: p.card.chatId,
      method: 'editMessageText',
      payload: { message_id: p.card.messageId, rich_message: { markdown, skip_entity_detection: true }, reply_markup: { inline_keyboard: keyboard } },
      markdown,
      priority: 1,
    });
    return;
  }
  s.telegram.outbox.enqueue({
    idempotencyKey: `bizwin:${p.pendingActionId}`,
    userId: p.userId,
    chatId: p.chat.chatId,
    ...(p.chat.threadId ? { threadId: p.chat.threadId } : {}),
    method: 'sendRichMessage',
    payload: keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {},
    markdown,
    priority: 1,
  });
}

/** Statuses whose card never delivered the draft (voided cards were superseded or deleted: no fallback for those). */
const UNSENT = new Set(['pending', 'expired', 'failed']);

/**
 * The business_window job (01 §10.2 step 6), at window_expires_at of a chat. A window that a newer incoming message
 * extended moves the job. Otherwise every pending draft card of the chat is closed (voided with the window reason, so
 * no Approve can race the deadline) and the owner gets the copy fallback for each draft that was never sent.
 */
export async function runWindow(b: Biz, connectionId: string, chatId: number): Promise<JobResult> {
  const { s, repo } = b;
  const now = s.clock.now();
  const conn = repo.getConnection(connectionId);
  if (!conn) return { status: 'done' };
  const chat = repo.getChat(connectionId, chatId);
  if (!chat) return { status: 'done' };
  if (chat.windowExpiresAt !== null && chat.windowExpiresAt > now) return { status: 'reschedule', runAt: chat.windowExpiresAt };
  const user = ownerOf(b, conn.userId);
  if (!user || user.status === 'deleting') return { status: 'done' };
  const lang = user.languageCode ?? 'en';
  // cards of this window only (their expiry is the window end); older windows were handled by their own job
  const cards = draftCards(b, user.id, connectionId, chatId).filter((v) => UNSENT.has(v.status) && v.expiresAt >= now - DAY_MS);
  if (!cards.length) return { status: 'done' };
  try {
    await s.approvals.voidBySourceRef(chatSourceRef(connectionId, chatId), bt('window_void_reason', lang));
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: closing window cards failed');
  }
  const inbox = await inboxOf(b, user);
  for (const v of cards) {
    const draft = v.body?.text ?? '';
    if (!draft.trim()) continue;
    try {
      await sendCopyFallback(b, { userId: user.id, pendingActionId: v.id, draft, chat: inbox, ...(v.card ? { card: v.card } : {}) });
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: copy fallback failed');
    }
  }
  ledger(b, { userId: user.id, actor: 'system', kind: 'business_event', summary: 'Telegram closed a reply window; drafts handed back to copy', detail: { chat: chatRef(connectionId, chatId), drafts: cards.length } });
  return { status: 'done' };
}
