// surfaces/business/consent.ts (WP7b) — per-chat consent and settings (01 §10.2 steps 1, 7, 8): enabling AI for a
// chat records a 'business_llm' consent (subject = chat ref, text version biz-v1) and makes the chat a trusted target;
// revoking deletes the chat's stored messages, voids its pending drafts and shreds its drafting conversations. The
// blanket 'AI for all new chats' is the 'business_llm_new_chats' consent (subject = connection id). Also the
// per-chat card of `/start bizChat<id>` and every `bz:` callback.
import type { InlineKeyboardButton } from 'grammy/types';
import type { CallbackAnswer, CallbackCtx, UserId, UserRow } from '../../contracts/index.ts';
import {
  chatRef, chatSourceRef, CONSENT_TEXT_VERSION, errName, ledger, ownerOf, parseChatRef, safe, safeName, triageJobKey, windowJobKey, type Biz,
} from './core.ts';
import { clearDigest, removeDigestItems } from './digest.ts';
import { startDraft, shredDrafts } from './drafting.ts';
import type { ConnRow } from './repo.ts';
import { bt } from './text.ts';

export class BizError extends Error {
  code: 'not_found' | 'disabled' | 'no_connection';
  constructor(code: 'not_found' | 'disabled' | 'no_connection') {
    super(`business: ${code}`);
    this.name = 'BizError';
    this.code = code;
  }
}

/** Resolves a chat ref owned by `userId`; throws BizError('not_found') otherwise. */
export function ownedChat(b: Biz, userId: UserId, ref: string): { conn: ConnRow; chatId: number; ref: string } {
  const p = parseChatRef(ref);
  const conn = p ? b.repo.getConnection(p.connectionId) : undefined;
  if (!p || !conn || conn.userId !== userId) throw new BizError('not_found');
  return { conn, chatId: p.chatId, ref: chatRef(conn.id, p.chatId) };
}

function removeTrustedTarget(b: Biz, userId: UserId, ref: string): void {
  try {
    const t = b.s.trustedTargets.list(userId).find((x) => x.kind === 'biz_chat' && x.value === ref);
    if (t) b.s.trustedTargets.remove(userId, t.hmac);
  } catch {
    /* trust module unavailable: nothing to remove */
  }
}

/**
 * Step 7: everything derived from one chat's content goes — stored messages, pending draft cards (voided), drafting
 * conversations (shredded), queued triage and window jobs, the digest line. Metadata stays (it is not content).
 */
export async function purgeChatContent(b: Biz, conn: ConnRow, chatId: number, reason: string): Promise<void> {
  const { s, repo } = b;
  const ref = chatRef(conn.id, chatId);
  try {
    await s.approvals.voidBySourceRef(chatSourceRef(conn.id, chatId), reason);
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: voiding chat drafts failed');
  }
  await shredDrafts(b, repo.draftsTouchingChat(conn.id, chatId), `business:${reason}`.slice(0, 64)); // incl. drafts of other chats embedding its samples
  repo.deleteChatMessages(conn.id, chatId);
  safe(() => s.scheduler.cancel(triageJobKey(conn.id, chatId)), undefined);
  safe(() => s.scheduler.cancel(windowJobKey(conn.id, chatId)), undefined);
  removeDigestItems(b, conn.id, conn.userId, [chatId]);
  removeTrustedTarget(b, conn.userId, ref);
}

/** Disconnect (is_enabled → false) and deletion: all chats of the connection, consents included. The DEK stays unless `destroyDek`. */
export async function purgeConnectionData(b: Biz, conn: ConnRow, reason: string): Promise<void> {
  const { s, repo } = b;
  for (const chat of repo.listChats(conn.id, { aiOnly: false, unansweredOnly: false, limit: 500 })) {
    await purgeChatContent(b, conn, chat.chatId, reason);
    if (chat.aiEnabled) safe(() => s.repos.users.revokeConsent(conn.userId, 'business_llm', chatRef(conn.id, chat.chatId)), undefined);
  }
  await shredDrafts(b, repo.draftsOfConnection(conn.id), `business:${reason}`.slice(0, 64));
  safe(() => s.repos.users.revokeConsent(conn.userId, 'business_llm_new_chats', conn.id), undefined);
  repo.setAiDefault(conn.id, 'off', s.clock.now());
  clearDigest(b, conn.id);
  repo.purgeConnection(conn.id, false);
}

export async function setChatAi(b: Biz, userId: UserId, ref: string, enabled: boolean, via: 'callback' | 'miniapp' | 'blanket'): Promise<void> {
  const { s, repo } = b;
  const oc = ownedChat(b, userId, ref);
  const { conn, chatId } = oc;
  const now = s.clock.now();
  if (enabled) {
    if (!conn.isEnabled || conn.disconnectedAt !== null) throw new BizError('disabled');
    repo.ensureChat(conn.id, chatId, now, chatId > 0 ? chatId : null);
    const cur = repo.getChat(conn.id, chatId);
    if (cur?.aiEnabled && cur.consentId) return;
    const consentId = s.repos.users.grantConsent({ userId, kind: 'business_llm', subject: oc.ref, textVersion: CONSENT_TEXT_VERSION, via });
    repo.setAi(conn.id, chatId, true, consentId);
    try {
      s.trustedTargets.add(userId, { kind: 'biz_chat', value: oc.ref, source: 'business_chat', sourceRef: consentId });
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: trusted target add failed');
    }
    ledger(b, { userId, actor: via === 'blanket' ? 'system' : 'user', kind: 'consent', summary: 'Secretary AI enabled for a chat', detail: { chat: oc.ref, via, version: CONSENT_TEXT_VERSION } });
    return;
  }
  const cur = repo.getChat(conn.id, chatId);
  safe(() => s.repos.users.revokeConsent(userId, 'business_llm', oc.ref), undefined);
  if (cur) repo.setAi(conn.id, chatId, false, null);
  await purgeChatContent(b, conn, chatId, 'consent revoked');
  ledger(b, { userId, actor: 'user', kind: 'consent', summary: 'Secretary AI disabled for a chat; its stored messages were deleted', detail: { chat: oc.ref, via } });
}

export async function setDefault(b: Biz, userId: UserId, aiDefault: 'off' | 'new_chats', via: 'callback' | 'miniapp'): Promise<void> {
  const { s, repo } = b;
  const conn = repo.connectionOfUser(userId);
  if (!conn) throw new BizError('no_connection');
  if (aiDefault === 'new_chats') {
    if (!conn.isEnabled || conn.disconnectedAt !== null) throw new BizError('disabled');
    s.repos.users.grantConsent({ userId, kind: 'business_llm_new_chats', subject: conn.id, textVersion: CONSENT_TEXT_VERSION, via });
  } else safe(() => s.repos.users.revokeConsent(userId, 'business_llm_new_chats', conn.id), undefined);
  repo.setAiDefault(conn.id, aiDefault, s.clock.now());
  ledger(b, { userId, actor: 'user', kind: 'consent', summary: aiDefault === 'new_chats' ? 'Secretary AI enabled for all new chats' : 'Secretary AI kept off for new chats', detail: { via, version: CONSENT_TEXT_VERSION } });
}

export async function updateChat(b: Biz, userId: UserId, ref: string, patch: { mode?: 'triage' | 'draft'; toneNotes?: string | null }, via: 'callback' | 'miniapp'): Promise<void> {
  const { s, repo } = b;
  const oc = ownedChat(b, userId, ref);
  repo.ensureChat(oc.conn.id, oc.chatId, s.clock.now(), oc.chatId > 0 ? oc.chatId : null);
  if (patch.mode === 'triage' || patch.mode === 'draft') repo.setMode(oc.conn.id, oc.chatId, patch.mode);
  if (patch.toneNotes !== undefined) repo.setTone(oc.conn.id, oc.chatId, patch.toneNotes);
  ledger(b, { userId, actor: 'user', kind: 'settings', summary: 'Secretary chat settings changed', detail: { chat: oc.ref, via, mode: patch.mode ?? null, tone: patch.toneNotes === undefined ? 'unchanged' : patch.toneNotes ? 'set' : 'cleared' } });
}

// ── the per-chat card (/start bizChat<id>) and bz: callbacks

function chatCard(b: Biz, u: UserRow, conn: ConnRow, chatId: number): { markdown: string; keyboard: InlineKeyboardButton[][] } {
  const { s, repo } = b;
  const lang = u.languageCode ?? 'en';
  const chat = repo.getChat(conn.id, chatId);
  const esc = (t: string) => s.telegram.render.escape(t);
  const name = safeName(repo.title(conn.id, chatId), bt('unknown_chat', lang, { id: chatId }));
  const mode = chat?.mode ?? 'triage';
  const lines = [
    bt('chat_card_title', lang, { name: esc(name) }),
    esc(chat?.aiEnabled ? bt('chat_ai_on', lang) : bt('chat_ai_off', lang)),
    esc(bt('chat_mode', lang, { mode: bt(mode === 'draft' ? 'mode_draft' : 'mode_triage', lang) })),
    esc(bt('chat_tone', lang, { state: bt(chat?.hasTone ? 'tone_set' : 'tone_none', lang) })),
  ];
  const enc = (parts: string[]) => s.telegram.codec.encode('bz', parts, u.tgUserId);
  const id = String(chatId);
  const keyboard: InlineKeyboardButton[][] = [];
  if (!chat?.aiEnabled) keyboard.push([{ text: bt('btn_enable', lang), callback_data: enc(['on', id]) }]);
  keyboard.push([{ text: bt('btn_mode', lang, { mode: mode === 'draft' ? 'draft' : 'triage' }), callback_data: enc(['m', id, mode === 'draft' ? 't' : 'd']) }]);
  const base = s.config.publicUrl;
  const toneBtn: InlineKeyboardButton = /^https:\/\//.test(base ?? '')
    ? { text: bt('btn_tone', lang), web_app: { url: `${base}/app/?screen=secretary&chat=${encodeURIComponent(chatRef(conn.id, chatId))}` } }
    : { text: bt('btn_tone', lang), callback_data: enc(['tn', id]) };
  keyboard.push([toneBtn]);
  if (chat?.aiEnabled) keyboard.push([{ text: bt('btn_off', lang), callback_data: enc(['x', id]) }]);
  return { markdown: lines.join('\n'), keyboard };
}

export async function sendChatCard(b: Biz, u: UserRow, chatId: number, idem: string): Promise<void> {
  const { s, repo } = b;
  const lang = u.languageCode ?? 'en';
  const dm = u.dmChatId ?? u.tgUserId;
  const conn = repo.connectionOfUser(u.id);
  if (!conn || !conn.isEnabled || conn.disconnectedAt !== null) {
    s.telegram.outbox.enqueue({ idempotencyKey: idem, userId: u.id, chatId: dm, method: 'sendRichMessage', payload: {}, markdown: s.telegram.render.escape(bt('no_connection', lang)) });
    return;
  }
  repo.ensureChat(conn.id, chatId, s.clock.now(), chatId > 0 ? chatId : null);
  const card = chatCard(b, u, conn, chatId);
  s.telegram.outbox.enqueue({ idempotencyKey: idem, userId: u.id, chatId: dm, method: 'sendRichMessage', payload: { reply_markup: { inline_keyboard: card.keyboard } }, markdown: card.markdown });
}

function refreshCard(b: Biz, c: CallbackCtx, u: UserRow, conn: ConnRow, chatId: number): void {
  if (!c.message) return;
  const card = chatCard(b, u, conn, chatId);
  try {
    b.s.telegram.outbox.enqueue({
      idempotencyKey: `bzcard:${c.callbackQueryId}`,
      userId: u.id,
      chatId: c.message.chatId,
      method: 'editMessageText',
      payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: card.keyboard } },
      markdown: card.markdown,
      priority: 1,
    });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: card refresh failed');
  }
}

/** bz:new:on · bz:off · bz:on:<chat> · bz:x:<chat> · bz:m:<chat>:<t|d> · bz:tn:<chat> · bz:dr:<chat> */
export async function onBzCallback(b: Biz, c: CallbackCtx): Promise<CallbackAnswer> {
  const u = c.user;
  if (!u || u.status === 'deleting') return { text: bt('no_connection', null) };
  const lang = u.languageCode ?? 'en';
  const conn = b.repo.connectionOfUser(u.id);
  if (!conn) return { text: bt('no_connection', lang), alert: true };
  const [action, arg, arg2] = c.parts;
  try {
    if (action === 'new' && arg === 'on') {
      await setDefault(b, u.id, 'new_chats', 'callback');
      return { text: bt('new_chats_on', lang), alert: true };
    }
    if (action === 'off' && arg === undefined) {
      await setDefault(b, u.id, 'off', 'callback');
      return { text: bt('ai_kept_off', lang) };
    }
    const chatId = Number(arg);
    if (!Number.isSafeInteger(chatId) || chatId === 0) return { text: bt('not_found', lang) };
    const ref = chatRef(conn.id, chatId);
    switch (action) {
      case 'on':
        await setChatAi(b, u.id, ref, true, 'callback');
        refreshCard(b, c, u, conn, chatId);
        return { text: bt('chat_enabled', lang) };
      case 'x':
        await setChatAi(b, u.id, ref, false, 'callback');
        refreshCard(b, c, u, conn, chatId);
        return { text: bt('chat_disabled', lang) };
      case 'm': {
        const mode = arg2 === 'd' ? 'draft' : 'triage';
        await updateChat(b, u.id, ref, { mode }, 'callback');
        refreshCard(b, c, u, conn, chatId);
        return { text: bt('mode_set', lang, { mode: bt(mode === 'draft' ? 'mode_draft' : 'mode_triage', lang) }) };
      }
      case 'tn':
        return { text: bt('tone_hint', lang), alert: true };
      case 'dr': {
        const chat = b.repo.getChat(conn.id, chatId);
        const owner = ownerOf(b, u.id) ?? u;
        const runId = chat ? await startDraft(b, { conn, chat, user: owner, reason: 'owner' }) : null;
        return { text: bt(runId ? 'drafting' : 'draft_unavailable', lang) };
      }
      default:
        return { text: bt('not_found', lang) };
    }
  } catch (e) {
    if (e instanceof BizError) return { text: bt(e.code === 'not_found' ? 'not_found' : 'no_connection', lang), alert: true };
    throw e;
  }
}
