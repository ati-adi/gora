// proactive/util.ts (WP6b) — small helpers shared by the proactive services (no SQL).
import type { InlineKeyboardButton } from 'grammy/types';
import type { CallbackKind, ConversationRow, Services, UserRow } from '../contracts/index.ts';
import { uiLang, type UiLang } from '../contracts/index.ts';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function langOf(u: Pick<UserRow, 'languageCode'> | undefined): UiLang {
  return uiLang(u?.languageCode ?? null);
}

/** The owner's private chat id (the DM chat id equals the user id in private chats). */
export function dmChatOf(u: Pick<UserRow, 'dmChatId' | 'tgUserId'>): number {
  return u.dmChatId ?? u.tgUserId;
}

/** ☀️ Today topic thread (created lazily by WP2), or null → the main DM. Never throws. */
export async function todayThread(s: Services, u: UserRow): Promise<number | null> {
  try {
    return await s.telegram.topics.ensureFixed(u.id, u.tgUserId, 'today');
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'proactive: ensureFixed(today) failed; using the DM');
    return null;
  }
}

/** The Today conversation (or the main DM conversation when topics are unavailable). */
export function todayConversation(s: Services, u: UserRow, threadId: number | null): ConversationRow {
  const chatId = dmChatOf(u);
  return s.conversations.resolve(
    { kind: 'dm', tgUserId: u.tgUserId, ...(threadId !== null ? { threadId } : {}) },
    { userId: u.id, tgChatId: chatId, ...(threadId !== null ? { threadId } : {}) },
  );
}

export function cbButton(s: Services, text: string, kind: CallbackKind, parts: string[], ownerTgId: number): InlineKeyboardButton {
  return { text, callback_data: s.telegram.codec.encode(kind, parts, ownerTgId) };
}

export function planOf(s: Services, u: Pick<UserRow, 'plan'>) {
  return s.config.plans[u.plan] ?? s.config.plans.free;
}

/** Clip for display (never splits a surrogate pair). */
export function clipText(t: string, n: number): string {
  const a = Array.from(t.replace(/\s+/g, ' ').trim());
  return a.length <= n ? a.join('') : `${a.slice(0, n - 1).join('')}…`;
}
