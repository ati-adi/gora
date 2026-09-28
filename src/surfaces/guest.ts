// src/surfaces/guest.ts (WP7a) — `@gora` guest mode (01 F13, §10.4): rate limits (10/caller/h, 30/chat/h, the daily
// guest_answer quota for Gora users) answered once with a "limit reached" article; guest_invocations holds ids only
// (a primary-key conflict means "already answered" → drop); a single-shot GUEST conversation; the replied-to text stays
// untrusted; the "🔒 Continue privately" deep link is bound to the caller, single-use, 24 h. WP2's guest channel races
// the run against 3 s, answers with answerGuestQuery exactly once and edits the placeholder (⚠U1/U2), calling
// GuestService.mark. `/start g_<token>` (continueGuest) turns the stored summon into DM inputs.
import type { Context } from 'grammy';
import type { InlineQueryResult, Message } from 'grammy/types';
import type { ChatRef, UserRow } from '../contracts/index.ts';
import { escapeAttr, neutralizeReservedTags } from '../kernel/tags.ts';
import type { DmHandlers } from './dm.ts';
import { st } from './strings.ts';
import { deepLink, dmConversation, errName, langOf, sendRich, type Surf } from './util.ts';

export const GUEST_TOKEN_TTL_MS = 24 * 3_600_000;
const HOUR = 3_600_000;

export interface GuestPayload { s: string; r?: string; n?: string }

/** The summon text without the bot mention(s). */
export function stripMention(text: string, botUsername: string): string {
  const re = new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  return text.replace(re, ' ').replace(/\s+/g, ' ').trim();
}

export function createGuest(surf: Surf, deps: { dm: DmHandlers }) {
  const { s } = surf;
  const L = s.config.limits;

  async function answerLimited(gqid: string, lang: string | undefined): Promise<void> {
    const result: InlineQueryResult = { type: 'article', id: 'g1', title: st('guest_limit_title', lang), input_message_content: { message_text: st('guest_limit', lang) } };
    try {
      await s.telegram.api.answerGuestQuery(gqid, result);
      surf.guests.mark(gqid, 'answered');
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'guest: limit answer failed');
    }
  }

  async function onGuestMessage(ctx: Context): Promise<void> {
    const gm = (ctx.update as { guest_message?: Message & { guest_query_id?: string } }).guest_message;
    if (!gm || !gm.from || gm.from.is_bot || !gm.guest_query_id) return;
    if (!s.config.features.guest) return;
    const gqid = gm.guest_query_id;
    const from = gm.from;
    const now = s.clock.now();
    const chatRef = s.crypto.hmac('chat_ref', String(gm.chat.id));
    const user = s.repos.users.getByTg(from.id);
    const lang = user?.languageCode ?? from.language_code;

    let limited = surf.guests.countSince({ callerTgId: from.id, since: now - HOUR }) >= L.guestPerCallerPerHour || surf.guests.countSince({ chatRefHmac: chatRef, since: now - HOUR }) >= L.guestPerChatPerHour;
    if (!limited && user && user.status !== 'deleting') limited = !s.quotas.check(user.id, 'guest_answer', 1).ok;
    if (limited) {
      if (!surf.guests.insert({ guestQueryId: gqid, callerTgId: from.id, chatRefHmac: chatRef, status: 'rate_limited' })) return;
      await answerLimited(gqid, lang);
      return;
    }
    if (!surf.guests.insert({ guestQueryId: gqid, callerTgId: from.id, chatRefHmac: chatRef, status: 'received' })) return; // already answered

    const summon = stripMention(gm.text ?? gm.caption ?? '', s.telegram.botInfo.username);
    const r = gm.reply_to_message;
    const replied = r ? (r.text ?? r.caption ?? '').slice(0, 4000) : '';
    const payload: GuestPayload = { s: summon.slice(0, 2000), ...(replied ? { r: replied } : {}), ...(r?.from?.first_name ? { n: r.from.first_name } : {}) };
    const token = surf.deepLinks.create('guest', from.id, payload, GUEST_TOKEN_TTL_MS);
    const continueUrl = deepLink(surf, `g_${token}`);

    let convId: string;
    try {
      const conv = s.conversations.resolve({ kind: 'guest', guestQueryId: gqid }, { userId: null, tgChatId: gm.chat.id });
      convId = conv.id;
      const request = `<guest_request caller="${escapeAttr(from.first_name)}">${neutralizeReservedTags(summon || '(no question)')}</guest_request>`;
      s.repos.inputs.add({ conversationId: conv.id, kind: 'guest', author: 'owner', untrusted: false, content: [{ type: 'text', text: request }], tgUpdateId: ctx.update.update_id, tgChatId: gm.chat.id, tgMessageId: gm.message_id, fromTgUserId: from.id, replyToCardId: null });
      if (replied) {
        s.repos.inputs.add({ conversationId: conv.id, kind: 'guest', author: 'peer', untrusted: true, content: [{ type: 'text', text: replied }], tgUpdateId: ctx.update.update_id, tgChatId: gm.chat.id, tgMessageId: r?.message_id ?? null, fromTgUserId: r?.from?.id ?? null, replyToCardId: null });
      }
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'guest: ingest failed');
      surf.guests.mark(gqid, 'failed');
      return;
    }
    if (user && user.status !== 'deleting') s.quotas.consume(user.id, 'guest_answer', 1);
    s.runner.kick(convId, { replyRef: { chatId: gm.chat.id, guestQueryId: gqid, continueUrl } });
  }

  /** `/start g_<token>` in the DM (§10.4 step 6). */
  async function continueGuest(user: UserRow, token: string, chat: ChatRef, updateId: number | null): Promise<void> {
    const lang = langOf(user);
    const res = surf.deepLinks.consume(token, 'guest', user.tgUserId);
    const to = { ...chat, userId: user.id };
    if ('error' in res) {
      await sendRich(surf, to, st(res.error === 'not_owner' ? 'link_other' : 'link_expired', lang), { idem: `g:${token}:${updateId ?? 'c'}` });
      return;
    }
    const p = (res.payload ?? {}) as GuestPayload;
    const summon = typeof p.s === 'string' ? p.s : '';
    // The caller's own words are owner-authored; the replied-to text stays untrusted (source guest).
    const conv = dmConversation(surf, user);
    deps.dm.addOwnerText(user, summon || '…', { updateId, chat, kind: 'text' });
    if (typeof p.r === 'string' && p.r) {
      s.repos.inputs.add({ conversationId: conv.id, kind: 'guest', author: 'peer', untrusted: true, content: [{ type: 'text', text: p.r }], tgUpdateId: updateId, tgChatId: chat.chatId, tgMessageId: null, fromTgUserId: null, replyToCardId: null });
    }
    s.runner.kick(conv.id);
  }

  return { onGuestMessage, continueGuest };
}
export type Guest = ReturnType<typeof createGuest>;
