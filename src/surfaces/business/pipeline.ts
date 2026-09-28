// surfaces/business/pipeline.ts (WP7b) — business_message / edited_business_message / deleted_business_messages
// (01 §10.1 rows, §10.2 step 2). Before consent for a chat only METADATA is kept (arrival time, unanswered-since,
// the 24 h window end, an encrypted title): no content and no LLM call. After consent the text is stored sealed for
// 30 days and triage is debounced 45 s. Messages sent by this bot (sender_business_bot) and by any bot are ignored.
import type { BusinessMessagesDeleted, Message } from 'grammy/types';
import {
  chatRef, errName, ledger, msgSourceRef, ownerOf, TRIAGE_DEBOUNCE_MS, triageJobKey, WINDOW_MS, type Biz,
} from './core.ts';
import { setChatAi } from './consent.ts';
import { removeDigestItems } from './digest.ts';
import { connectionLive, shredDrafts } from './drafting.ts';
import { scheduleWindow } from './send.ts';

const MEDIA_KEYS = ['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'animation', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'checklist'] as const;

function mediaKind(msg: Message): string | null {
  const m = msg as unknown as Record<string, unknown>;
  for (const k of MEDIA_KEYS) if (m[k] !== undefined) return k;
  return null;
}

function chatTitle(msg: Message): string {
  const c = msg.chat as unknown as { title?: string; first_name?: string; last_name?: string; username?: string };
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return (c.title ?? name) || (c.username ? `@${c.username}` : '');
}

export async function onMessage(b: Biz, msg: Message, edited: boolean): Promise<void> {
  const { s, repo } = b;
  const connId = (msg as { business_connection_id?: string }).business_connection_id;
  if (!connId) return;
  // Never react to our own sends (recorded by send.ts) or to any bot.
  const senderBot = (msg as { sender_business_bot?: { id: number } }).sender_business_bot;
  if (senderBot && senderBot.id === s.telegram.botInfo.id) return;
  if (!msg.from || msg.from.is_bot) return;
  const conn = repo.getConnection(connId);
  if (!conn || !connectionLive(conn)) return; // unknown or disconnected: stop processing
  const owner = ownerOf(b, conn.userId);
  if (!owner || owner.status === 'deleting') return;
  const chatId = msg.chat.id;
  const now = s.clock.now();
  const date = (msg.date ?? Math.floor(now / 1000)) * 1000;
  const text = (msg.text ?? msg.caption ?? '').toString();
  const media = mediaKind(msg);

  if (edited) {
    // Consented chats only: update the stored copy. No metadata change, no LLM.
    const at = ((msg as { edit_date?: number }).edit_date ?? Math.floor(now / 1000)) * 1000;
    repo.editMessage(connId, chatId, msg.message_id, text, at);
    return;
  }

  const isNew = repo.ensureChat(connId, chatId, now, msg.chat.type === 'private' ? chatId : null);
  const title = chatTitle(msg);
  if (title) repo.setTitle(connId, chatId, title);
  if (isNew && conn.aiDefault === 'new_chats') {
    try {
      await setChatAi(b, conn.userId, chatRef(connId, chatId), true, 'blanket');
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: blanket consent failed');
    }
  }

  const fromOwner = msg.from.id === conn.tgUserId;
  if (fromOwner) repo.noteOwner(connId, chatId, date);
  else repo.notePeer(connId, chatId, date, date + WINDOW_MS);

  const chat = repo.getChat(connId, chatId);
  if (!chat?.aiEnabled) return; // metadata only: no content, no LLM
  repo.addMessage({ connectionId: connId, chatId, messageId: msg.message_id, fromOwner, viaBot: false, date, text, mediaKind: media, now });
  if (!fromOwner && chat.windowExpiresAt !== null) scheduleWindow(b, conn.userId, connId, chatId, chat.windowExpiresAt);
  try {
    s.scheduler.schedule({
      kind: 'business_triage', runAt: now + TRIAGE_DEBOUNCE_MS, userId: conn.userId, refId: chatRef(connId, chatId),
      payload: { conn: connId, chat: chatId }, dedupeKey: triageJobKey(connId, chatId), maxAttempts: 3,
    });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: triage schedule failed');
  }
}

/** Purges the stored copies, voids cards that quote them, deletes commitments from them, shreds the drafts that included them. */
export async function onDeleted(b: Biz, ev: BusinessMessagesDeleted): Promise<void> {
  const { s, repo } = b;
  const conn = repo.getConnection(ev.business_connection_id);
  if (!conn) return;
  const chatId = ev.chat.id;
  const ids = (ev.message_ids ?? []).filter((x) => Number.isSafeInteger(x));
  if (!ids.length) return;
  const purged = repo.deleteMessages(conn.id, chatId, ids);
  let voided = 0;
  for (const id of ids) {
    try {
      voided += await s.approvals.voidBySourceRef(msgSourceRef(conn.id, chatId, id), 'the message was deleted');
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: voiding cards of a deleted message failed');
    }
  }
  let commitments = 0;
  try {
    commitments = s.commitments.deleteBySourceMessages(conn.id, chatId, ids);
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: deleting commitments failed');
  }
  const shredded = await shredDrafts(b, repo.draftsWithMessages(conn.id, chatId, ids), 'business:message_deleted');
  if (purged || voided || shredded) removeDigestItems(b, conn.id, conn.userId, [chatId]);
  if (purged || voided || commitments || shredded) {
    ledger(b, { userId: conn.userId, actor: 'system', kind: 'business_event', summary: 'Deleted business messages purged', detail: { chat: chatRef(conn.id, chatId), messages: purged, cards: voided, commitments, drafts: shredded } });
  }
}
