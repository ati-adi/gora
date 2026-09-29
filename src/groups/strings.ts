// groups/strings.ts (GR) — the module-private texts of src/groups (04 §2 i18n: text no other module needs stays local and
// picks its language with uiLang()). The surface-side group texts (acks, catch-up delivery, the add-to-group button) are
// in surfaces/strings.ts SURF.
import { uiLang } from '../contracts/index.ts';

/** C2: the ONE join line (ToS transparency: members must know the bot reads the chat). RU is the spec text verbatim. */
export const JOIN_LINE = Object.freeze({
  ru: 'Привет! Я Гора — читаю чат, чтобы помогать: отвечу, если позовёте, и иногда подскажу сама. „Гора, тише“ — и я буду реже встревать.',
  en: 'Hi! I’m Gora — I read this chat to help: I answer when you call me and sometimes chime in on my own. Say “Gora, quieter” and I’ll chime in less.',
});
export const joinLine = (lang: string | null | undefined): string => JOIN_LINE[uiLang(lang)];

/** C5 fallback when the catch-up model call fails: a plain count, never member text. */
export function catchupFallback(lang: string | null | undefined, n: number, names: string[]): string {
  const who = names.slice(0, 4).join(', ');
  return uiLang(lang) === 'ru' ? `• ${n} сообщ. с вашего последнего${who ? ` — пишут: ${who}` : ''}` : `• ${n} messages since you last wrote${who ? ` — from ${who}` : ''}`;
}

/** The add-to-group url (C6): no admin rights requested (`admin=` empty). */
export const addToGroupUrl = (botUsername: string): string => `https://t.me/${botUsername}?startgroup=g&admin=`;
