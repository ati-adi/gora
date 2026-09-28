// surfaces/business/digest.ts (WP7b) — the 📥 Inbox digest (01 §10.2 step 3): triaged chats that need a reply but got
// no draft card. One message is edited in place; a NEW digest message is sent at most once per 2 h (job
// business_digest). The per-chat triage summaries are LLM output derived from peer text, so they are kept sealed under
// the connection DEK (kv 'bizdigest:<connId>', AAD 'kv|bizdigest|<connId>'); the job payload holds the connection id only.
import type { InlineKeyboardButton } from 'grammy/types';
import type { JobResult } from '../../contracts/index.ts';
import {
  aadDigest, clip, dekOf, DIGEST_DELAY_MS, DIGEST_NEW_EVERY_MS, digestJobKey, digestKvKey, errName, hhmm, inboxOf, MESSAGE_RETENTION_MS,
  ownerOf, type Biz,
} from './core.ts';
import { canReply, connectionLive, windowOpen } from './drafting.ts';
import { bt } from './text.ts';

/** `drafted`: a draft card was requested for this chat — the line stays hidden unless the run ends without a draft (noDraft). */
export interface DigestItem { summary: string; urgency: number; at: number; noDraft: boolean; drafted: boolean }
interface DigestState { messageId: number | null; chatId: number | null; threadId: number | null; sentAt: number; version: number; enc: string | null }

const EMPTY: DigestState = { messageId: null, chatId: null, threadId: null, sentAt: 0, version: 0, enc: null };
const MAX_LINES = 10;
const MAX_DRAFT_BUTTONS = 6;

function loadState(b: Biz, connectionId: string): DigestState {
  try {
    const v = b.s.repos.kv.get<DigestState>(digestKvKey(connectionId));
    return v && typeof v === 'object' ? { ...EMPTY, ...v } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}
function saveState(b: Biz, connectionId: string, st: DigestState): void {
  b.s.repos.kv.set(digestKvKey(connectionId), st);
}
function loadItems(b: Biz, connectionId: string, st: DigestState): Record<string, DigestItem> {
  if (!st.enc) return {};
  try {
    return b.s.crypto.openJson<Record<string, DigestItem>>(Buffer.from(st.enc, 'base64'), aadDigest(connectionId));
  } catch {
    return {};
  }
}
function sealItems(b: Biz, connectionId: string, items: Record<string, DigestItem>): string | null {
  if (!Object.keys(items).length) return null;
  return Buffer.from(b.s.crypto.sealJson(dekOf(connectionId), items, aadDigest(connectionId))).toString('base64');
}

function scheduleDigest(b: Biz, connectionId: string, userId: string): void {
  try {
    b.s.scheduler.schedule({ kind: 'business_digest', runAt: b.s.clock.now() + DIGEST_DELAY_MS, userId, refId: connectionId, payload: { conn: connectionId }, dedupeKey: digestJobKey(connectionId), maxAttempts: 3 });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: digest schedule failed');
  }
}

/** Adds/replaces the digest line of one chat and (unless it is a hidden `drafted` line) schedules a re-render. */
export function addDigestItem(b: Biz, p: { connectionId: string; userId: string; chatId: number; item: Partial<DigestItem> & { at: number } }): void {
  const st = loadState(b, p.connectionId);
  const items = loadItems(b, p.connectionId, st);
  const prev = items[String(p.chatId)];
  items[String(p.chatId)] = {
    summary: p.item.summary ?? prev?.summary ?? '',
    urgency: p.item.urgency ?? prev?.urgency ?? 0,
    noDraft: p.item.noDraft ?? false,
    drafted: p.item.drafted ?? false,
    at: p.item.at,
  };
  saveState(b, p.connectionId, { ...st, enc: sealItems(b, p.connectionId, items) });
  if (!items[String(p.chatId)]!.drafted) scheduleDigest(b, p.connectionId, p.userId);
}

/** Drops the digest lines of chats (deleted messages, consent revoked) and re-renders when a digest message exists. */
export function removeDigestItems(b: Biz, connectionId: string, userId: string | null, chatIds: number[] | 'all'): void {
  const st = loadState(b, connectionId);
  if (chatIds === 'all') {
    if (st.enc || st.messageId) saveState(b, connectionId, { ...st, enc: null });
  } else {
    const items = loadItems(b, connectionId, st);
    let changed = false;
    for (const id of chatIds) {
      if (items[String(id)]) {
        delete items[String(id)];
        changed = true;
      }
    }
    if (!changed) return;
    saveState(b, connectionId, { ...st, enc: sealItems(b, connectionId, items) });
  }
  if (userId && st.messageId) scheduleDigest(b, connectionId, userId);
}

export function clearDigest(b: Biz, connectionId: string): void {
  try {
    b.s.repos.kv.set(digestKvKey(connectionId), { ...EMPTY });
    b.s.scheduler.cancel(digestJobKey(connectionId));
  } catch {
    /* ignore */
  }
}

/** The business_digest job: re-render the digest of one connection. */
export async function runDigest(b: Biz, connectionId: string): Promise<JobResult> {
  const { s, repo } = b;
  const now = s.clock.now();
  const conn = repo.getConnection(connectionId);
  if (!conn || !connectionLive(conn)) return { status: 'done' };
  const user = ownerOf(b, conn.userId);
  if (!user || user.status === 'deleting') return { status: 'done' };
  const lang = user.languageCode ?? 'en';
  const st = loadState(b, connectionId);
  const items = loadItems(b, connectionId, st);
  const chats = repo.listChats(connectionId, { aiOnly: true, unansweredOnly: true, limit: 50 });
  const keep: Record<string, DigestItem> = {};
  const lines: string[] = [bt('digest_title', lang)];
  const buttons: InlineKeyboardButton[] = [];
  const esc = (t: string) => s.telegram.render.escape(t);
  const shown = chats.filter((c) => {
    const item = items[String(c.chatId)];
    if (!item || item.at <= now - MESSAGE_RETENTION_MS) return false;
    keep[String(c.chatId)] = item; // lines of answered chats (no longer unanswered) are dropped
    return !item.drafted;
  }).slice(0, MAX_LINES);
  for (const c of shown) {
    const item = items[String(c.chatId)];
    const name = repo.title(connectionId, c.chatId) ?? bt('unknown_chat', lang, { id: c.chatId });
    const urgency = Math.max(0, Math.min(3, item?.urgency ?? c.priority));
    const parts = [`**${esc(clip(name, 40))}**`, bt(`urgency_${urgency}` as 'urgency_0', lang)];
    if (c.unansweredSince !== null) parts.push(esc(bt('digest_waiting', lang, { time: hhmm(c.unansweredSince, user.tz) })));
    if (windowOpen(c, now) && c.windowExpiresAt !== null) {
      const when = s.telegram.render.tgTime(Math.floor(c.windowExpiresAt / 1000), 'r', hhmm(c.windowExpiresAt, user.tz));
      parts.push(`${esc(bt('digest_window', lang, { when: '' }).trim())} ${when}`);
    }
    lines.push(`- ${parts.join(' · ')}`);
    if (item?.summary) lines.push(`  ${esc(clip(item.summary, 200))}`);
    if (item?.noDraft) lines.push(`  _${esc(bt('digest_no_draft', lang))}_`);
    if (windowOpen(c, now) && canReply(conn) && buttons.length < MAX_DRAFT_BUTTONS) {
      buttons.push({ text: bt('btn_draft', lang, { name: clip(name, 20) }), callback_data: s.telegram.codec.encode('bz', ['dr', String(c.chatId)], user.tgUserId) });
    }
  }
  if (!shown.length) lines.push(esc(bt('digest_empty', lang)));
  const markdown = lines.join('\n');
  const keyboard: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  const next: DigestState = { ...st, enc: sealItems(b, connectionId, keep), version: st.version + 1 };

  if (st.messageId && st.chatId !== null && now - st.sentAt < DIGEST_NEW_EVERY_MS) {
    s.telegram.outbox.enqueue({
      idempotencyKey: `bizdigest:edit:${connectionId}:${st.messageId}:${next.version}`,
      userId: user.id,
      chatId: st.chatId,
      method: 'editMessageText',
      payload: { message_id: st.messageId, reply_markup: { inline_keyboard: keyboard } },
      markdown,
      priority: 5,
    });
    saveState(b, connectionId, next);
    return { status: 'done' };
  }
  if (!shown.length) {
    saveState(b, connectionId, next); // nothing waiting and no current digest to update: send nothing
    return { status: 'done' };
  }
  const inbox = await inboxOf(b, user);
  try {
    const sent = await s.telegram.outbox.sendNow({
      idempotencyKey: `bizdigest:send:${connectionId}:${next.version}:${now}`,
      userId: user.id,
      chatId: inbox.chatId,
      ...(inbox.threadId ? { threadId: inbox.threadId } : {}),
      method: 'sendRichMessage',
      payload: keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {},
      markdown,
      priority: 5,
    });
    const first = sent[0];
    saveState(b, connectionId, { ...next, messageId: first?.messageId ?? null, chatId: inbox.chatId, threadId: inbox.threadId ?? null, sentAt: now });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: digest send failed');
    saveState(b, connectionId, next);
    return { status: 'retry', error: errName(e) };
  }
  return { status: 'done' };
}
