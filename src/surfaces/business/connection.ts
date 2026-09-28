// surfaces/business/connection.ts (WP7b) — business_connection updates (01 §10.2 step 1): upsert the row (rights kept
// as the raw API JSON; v1 reads only can_reply), and on a NEW enabled connection DM the owner the consent card required
// by ToS 5.4(ii)/(iv) at user_chat_id (the one chat Gora may open without a /start, §11.8). is_enabled → false stops
// processing, purges the Secretary data (retention "until disconnect", §10.1) and tells the owner.
import type { InlineKeyboardButton } from 'grammy/types';
import type { BusinessConnection } from 'grammy/types';
import type { UserRow } from '../../contracts/index.ts';
import { CONSENT_TEXT_VERSION, errName, ledger, type Biz } from './core.ts';
import { purgeConnectionData } from './consent.ts';
import { canReply } from './drafting.ts';
import { bt } from './text.ts';

/** ToS 5.4(i): the processor named on the card is the one actually configured. */
function processorName(b: Biz): string {
  const id = b.s.config.profile?.id ?? 'anthropic';
  return id === 'anthropic' ? 'Anthropic (Claude)' : 'Groq';
}

export function consentCard(b: Biz, u: UserRow): { markdown: string; keyboard: InlineKeyboardButton[][] } {
  const { s } = b;
  const lang = u.languageCode ?? 'en';
  const esc = (t: string) => s.telegram.render.escape(t);
  const body = bt('consent_body', lang, { processor: processorName(b) });
  // The body carries its own emphasis; everything else is escaped.
  const markdown = [bt('consent_title', lang), body, `_${esc(bt('consent_version', lang, { version: CONSENT_TEXT_VERSION }))}_`].join('\n\n');
  const keyboard: InlineKeyboardButton[][] = [];
  const base = s.config.publicUrl;
  if (/^https:\/\//.test(base ?? '')) keyboard.push([{ text: bt('btn_choose', lang), web_app: { url: `${base}/app/?screen=secretary` } }]);
  keyboard.push([{ text: bt('btn_all_new', lang), callback_data: s.telegram.codec.encode('bz', ['new', 'on'], u.tgUserId) }]);
  keyboard.push([{ text: bt('btn_keep_off', lang), callback_data: s.telegram.codec.encode('bz', ['off'], u.tgUserId) }]);
  return { markdown, keyboard };
}

export async function onConnection(b: Biz, bc: BusinessConnection): Promise<void> {
  const { s, repo } = b;
  const now = s.clock.now();
  const owner = bc.user;
  if (!owner || owner.is_bot) return;
  const u = s.repos.users.upsertFromTelegram(
    { id: owner.id, first_name: owner.first_name, ...(owner.username ? { username: owner.username } : {}), ...(owner.language_code ? { language_code: owner.language_code } : {}) },
    { dmChatId: bc.user_chat_id },
  );
  if (u.status === 'deleting') return;
  const prev = repo.getConnection(bc.id);
  const rightsJson = JSON.stringify(bc.rights ?? {});
  repo.upsertConnection({ id: bc.id, userId: u.id, tgUserId: owner.id, userChatId: bc.user_chat_id, rightsJson, isEnabled: bc.is_enabled === true, now });
  const conn = repo.getConnection(bc.id)!;
  const lang = u.languageCode ?? 'en';
  const wasOn = !!prev && prev.isEnabled && prev.disconnectedAt === null;
  const isOn = bc.is_enabled === true;
  ledger(b, {
    userId: u.id, actor: 'user', kind: 'connection',
    summary: !prev ? (isOn ? 'Chat Automation connected' : 'Chat Automation connection received (disabled)') : wasOn && !isOn ? 'Chat Automation disconnected' : !wasOn && isOn ? 'Chat Automation reconnected' : 'Chat Automation settings changed',
    detail: { connection: bc.id, enabled: isOn, canReply: canReply(conn) },
  });

  if (wasOn && !isOn) {
    await purgeConnectionData(b, conn, 'disconnected');
    enqueue(b, u, `bizconn:off:${bc.id}:${now}`, s.telegram.render.escape(bt('disconnected', lang)), []);
    return;
  }
  if (isOn && (!prev || !wasOn)) {
    // New connection, or a reconnect after a disconnect purged everything: the disclosure is shown again.
    const card = consentCard(b, u);
    enqueue(b, u, `bizconn:consent:${bc.id}:${conn.connectedAt}`, card.markdown, card.keyboard, bc.user_chat_id);
  }
}

function enqueue(b: Biz, u: UserRow, key: string, markdown: string, keyboard: InlineKeyboardButton[][], chatId?: number): void {
  try {
    b.s.telegram.outbox.enqueue({
      idempotencyKey: key,
      userId: u.id,
      chatId: chatId ?? u.dmChatId ?? u.tgUserId,
      method: 'sendRichMessage',
      payload: keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {},
      markdown,
      priority: 1,
    });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: owner notice failed');
  }
}
