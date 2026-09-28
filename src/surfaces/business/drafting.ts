// surfaces/business/drafting.ts (WP7b) — single-shot drafting (01 §10.2 step 4) and the draft bookkeeping other steps
// need: which biz_draft conversations included which messages (business_drafts), which approval cards belong to a chat,
// and shredding drafting conversations on deletion, consent revocation and disconnect.
import type { ConversationRow, GoraEvent, PendingActionView, UserRow } from '../../contracts/index.ts';
import type { ChatRow, ConnRow, MsgRow } from './repo.ts';
import {
  chatRef, chatSourceRef, clip, errName, hhmm, inboxOf, ledger, localStamp, STYLE_SAMPLES, TRANSCRIPT_MESSAGES, type Biz,
} from './core.ts';
import { bt } from './text.ts';

export const DRAFT_TOOL = 'business_draft_reply';

export function canReply(conn: Pick<ConnRow, 'rights'>): boolean {
  return conn.rights['can_reply'] === true;
}
export function connectionLive(conn: Pick<ConnRow, 'isEnabled' | 'disconnectedAt'>): boolean {
  return conn.isEnabled && conn.disconnectedAt === null;
}
export function windowOpen(chat: Pick<ChatRow, 'windowExpiresAt'> | undefined, now: number): boolean {
  return !!chat && chat.windowExpiresAt !== null && chat.windowExpiresAt > now;
}

/** One transcript line (message ids let the model pass reply_to_message_id). */
export function transcriptLine(m: MsgRow, peerName: string, tz: string): string {
  const who = m.fromOwner ? (m.viaBot ? 'Owner (sent via Gora)' : 'Owner') : peerName;
  const body = m.text.trim() ? m.text.trim() : '';
  const media = m.mediaKind ? `[${m.mediaKind}]${body ? ' ' : ''}` : '';
  return `#${m.messageId} [${hhmm(m.date, tz)}] ${who}: ${media}${body}`;
}

/**
 * Style samples: the owner's last ≤ 15 own messages in this chat, topped up ONLY from other consented chats. `sources`
 * are the (chat, message) ids embedded, recorded with the draft so deleting any of them (or revoking that chat's
 * consent) shreds this drafting conversation too (01 F12, §10.2 step 7).
 */
export function styleSamples(b: Biz, connectionId: string, chatId: number): { lines: string[]; sources: Array<{ chatId: number; messageId: number }> } {
  const here = b.repo.ownerSamples(connectionId, { chatId, otherChats: false }, STYLE_SAMPLES);
  const more = b.repo.ownerSamples(connectionId, { chatId, otherChats: true }, STYLE_SAMPLES - here.length);
  const used = [...here, ...more].filter((m) => m.text.trim());
  return { lines: used.map((m) => `- ${clip(m.text, 300)}`), sources: used.map((m) => ({ chatId: m.chatId, messageId: m.messageId })) };
}

/**
 * Starts the single-shot drafting run for a consented chat. Returns the run id, or null when drafting is not possible
 * (connection off, chat not consented, no can_reply, window closed, nothing stored).
 */
export async function startDraft(b: Biz, p: { conn: ConnRow; chat: ChatRow; user: UserRow; reason: 'triage' | 'owner' }): Promise<string | null> {
  const { s, repo } = b;
  const now = s.clock.now();
  const { conn, chat, user } = p;
  if (!connectionLive(conn) || !chat.aiEnabled || !canReply(conn) || !windowOpen(chat, now)) return null;
  if (user.status !== 'active') return null;
  const msgs = repo.lastMessages(conn.id, chat.chatId, TRANSCRIPT_MESSAGES);
  if (!msgs.length) return null;
  const ref = chatRef(conn.id, chat.chatId);
  const lang = user.languageCode ?? 'en';
  const peerName = repo.title(conn.id, chat.chatId) ?? bt('peer', lang);

  // A newer draft replaces any card still pending for this chat.
  try {
    await s.approvals.voidBySourceRef(chatSourceRef(conn.id, chat.chatId), 'a newer draft replaces this one');
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: voiding older drafts failed');
  }

  const inbox = await inboxOf(b, user);
  const conv = s.conversations.resolve({ kind: 'biz_draft' }, { userId: user.id, tgChatId: inbox.chatId, ...(inbox.threadId ? { threadId: inbox.threadId } : {}), businessConnectionId: conn.id });
  const { lines: samples, sources } = styleSamples(b, conn.id, chat.chatId);
  repo.addDraft(conv.id, conn.id, chat.chatId, msgs.map((m) => m.messageId), now, sources);

  const transcript = msgs.map((m) => transcriptLine(m, peerName, user.tz)).join('\n');
  const tone = repo.tone(conn.id, chat.chatId);
  const closes = chat.windowExpiresAt !== null ? localStamp(chat.windowExpiresAt, user.tz) : 'unknown';
  const body = [
    `Draft a reply for the owner in their own Telegram chat (chat_ref "${ref}").`,
    'Call business_draft_reply exactly once with this chat_ref and the reply text only, written as the owner, in the language of the conversation, matching the owner\'s style samples. Do not address the owner and do not explain.',
    'Use reply_to_message_id (a #id from the transcript) only when replying to an older message. If no reply is needed, do not call the tool.',
    `The Telegram reply window closes at ${closes} (${user.tz}).`,
    tone ? `Owner's tone notes for this chat: ${clip(tone.replace(/[<>]/g, ' '), 500)}` : 'No tone notes for this chat.',
    samples.length ? 'The owner\'s own past messages (style samples) follow the transcript.' : 'There are no style samples yet; keep the reply short and neutral.',
  ].join('\n');
  const untrusted: NonNullable<GoraEvent['untrusted']> = [{ source: 'business_peer', label: 'chat transcript', text: transcript }];
  if (samples.length) untrusted.push({ source: 'business_peer', label: 'owner style samples', text: samples.join('\n') });
  const ev: GoraEvent = { type: 'draft_business_reply', ref, body, untrusted };
  const runId = s.runner.startEventRun(conv.id, ev, {
    channel: 'biz_owner',
    replyRef: { chatId: inbox.chatId, ...(inbox.threadId ? { threadId: inbox.threadId } : {}) },
    taint: ['business_peer'],
    priority: p.reason === 'owner' ? 'interactive' : 'background',
  });
  ledger(b, { userId: user.id, actor: p.reason === 'owner' ? 'user' : 'system', kind: 'business_event', summary: 'Secretary is drafting a reply', detail: { chat: ref, messages: msgs.length, reason: p.reason }, runId });
  return runId;
}

/** Approval cards (any status) of drafts for one chat: from the chat's drafting conversations, plus pending cards targeting it. */
export function draftCards(b: Biz, userId: string, connectionId: string, chatId: number): PendingActionView[] {
  const { s } = b;
  const ref = chatRef(connectionId, chatId);
  const ids = new Set<string>();
  for (const convId of b.repo.draftsOfChat(connectionId, chatId)) {
    let conv: ConversationRow | undefined;
    try {
      conv = s.repos.conversations.get(convId);
    } catch {
      conv = undefined;
    }
    if (!conv) continue;
    const runIds = new Set<string>();
    for (let e = 1; e <= conv.epoch; e++) {
      try {
        for (const m of s.repos.messages.load(conv.id, e)) if (m.runId) runIds.add(m.runId);
      } catch {
        /* shredded epoch */
      }
    }
    for (const runId of runIds) {
      try {
        for (const tc of s.repos.runs.toolCallsFor(runId)) if (tc.name === DRAFT_TOOL && tc.pendingActionId) ids.add(tc.pendingActionId);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    for (const v of s.approvals.listPending(userId)) {
      if (v.toolName === DRAFT_TOOL && v.targets.some((t) => t.kind === 'biz_chat' && t.display === ref)) ids.add(v.id);
    }
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: listPending failed');
  }
  const out: PendingActionView[] = [];
  for (const id of ids) {
    try {
      const v = s.approvals.get(id, userId);
      if (v && v.toolName === DRAFT_TOOL) out.push(v);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Shreds drafting conversations (stopping a run still in flight) and drops their business_drafts rows. */
export async function shredDrafts(b: Biz, conversationIds: string[], reason: string): Promise<number> {
  const { s } = b;
  let n = 0;
  for (const id of conversationIds) {
    try {
      const conv = s.repos.conversations.get(id);
      if (conv?.activeRunId) await s.runner.stopRun(conv.activeRunId, 'system').catch(() => false);
      if (conv && conv.status !== 'purged') await s.privacy.shredConversation(id, reason);
      n++;
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: shredding a drafting conversation failed');
    } finally {
      b.repo.deleteDraft(id);
    }
  }
  return n;
}
