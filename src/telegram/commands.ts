// telegram/commands.ts (WP2; friend mode 05 A1/A5) — setMyCommands + setChatMenuButton + setMyDescription +
// setMyShortDescription (en default + ru) (01 §4.5 boot step 6), applied only when the SHA-256 of the definitions
// (texts included) differs from kv.commands_hash. Failures are logged and retried at the next boot (the hash is only stored
// after every call succeeded).
import { createHash } from 'node:crypto';
import type { Api } from 'grammy';
import type { KvRepo, Logger } from '../contracts/index.ts';
import { errInfo, rawOf } from './render/fallback.ts';

interface Cmd { command: string; en: string; ru: string; is_ephemeral?: boolean }

/**
 * The private-chat menu published to Telegram (spec 05 A5): only /memory and /settings. Every other command
 * (/start, /new, /why, /ledger, …) still works when typed — the handler table lives in surfaces/commands.ts.
 */
export const PRIVATE_COMMANDS: readonly Cmd[] = Object.freeze([
  { command: 'memory', en: 'What I know about you', ru: 'Что я о тебе знаю' },
  { command: 'settings', en: 'Settings', ru: 'Настройки' },
]);

/**
 * spec 05 A1: what an empty chat shows before START (≤ 512 chars) and the profile/share blurb (≤ 120 chars). The
 * description carries the memory notice that replaced the consent card (consents row 'memory', text_version desc-v1).
 */
export const BOT_DESCRIPTION: Readonly<Record<'en' | 'ru', string>> = Object.freeze({
  ru: 'Гора — друг в Telegram. Пиши или отправь голосовое: посоветую, напомню, найду, запомню. Я запоминаю важное из наших разговоров, чтобы лучше тебя понимать — посмотреть или стереть можно в любой момент (/memory).',
  en: 'Gora is a friend in Telegram. Write or send a voice note: I’ll give advice, remind you, look things up and remember. I remember what matters from our chats to understand you better — you can see or erase it anytime (/memory).',
});
export const BOT_SHORT_DESCRIPTION: Readonly<Record<'en' | 'ru', string>> = Object.freeze({
  ru: 'Гора — друг в Telegram: посоветую, напомню, найду. Запоминаю важное; посмотреть или стереть — /memory.',
  en: 'Gora, a friend in Telegram: advice, reminders, answers. I remember what matters; see or erase it with /memory.',
});

export const GROUP_COMMANDS: readonly Cmd[] = Object.freeze([
  { command: 'gora', en: 'What Gora does here', ru: 'Что Gora делает здесь' },
  { command: 'remember', en: 'Save to group memory', ru: 'Запомнить для группы' },
  { command: 'forget', en: 'Forget from group memory', ru: 'Забыть из памяти группы' },
  { command: 'groupmemory', en: 'Show group memory', ru: 'Память группы' },
  { command: 'me', en: 'Ask privately — answered in our DM', ru: 'Спросить лично — отвечу в личке', is_ephemeral: true },
]);

function defs(publicUrl: string) {
  const list = (cmds: readonly Cmd[], lang: 'en' | 'ru') => cmds.map((c) => ({ command: c.command, description: c[lang], ...(c.is_ephemeral ? { is_ephemeral: true } : {}) }));
  return {
    calls: [
      { method: 'setMyCommands', payload: { commands: list(PRIVATE_COMMANDS, 'en'), scope: { type: 'all_private_chats' } } },
      { method: 'setMyCommands', payload: { commands: list(PRIVATE_COMMANDS, 'ru'), scope: { type: 'all_private_chats' }, language_code: 'ru' } },
      { method: 'setMyCommands', payload: { commands: list(GROUP_COMMANDS, 'en'), scope: { type: 'all_group_chats' } } },
      { method: 'setMyCommands', payload: { commands: list(GROUP_COMMANDS, 'ru'), scope: { type: 'all_group_chats' }, language_code: 'ru' } },
      { method: 'setChatMenuButton', payload: { menu_button: { type: 'web_app', text: 'Gora', web_app: { url: `${publicUrl}/app/` } } } },
      { method: 'setMyDescription', payload: { description: BOT_DESCRIPTION.en } },
      { method: 'setMyDescription', payload: { description: BOT_DESCRIPTION.ru, language_code: 'ru' } },
      { method: 'setMyShortDescription', payload: { short_description: BOT_SHORT_DESCRIPTION.en } },
      { method: 'setMyShortDescription', payload: { short_description: BOT_SHORT_DESCRIPTION.ru, language_code: 'ru' } },
    ],
  };
}

/** Exported for tests: every call syncCommands makes, in order. */
export const commandDefs = (publicUrl: string) => defs(publicUrl);

export function commandsHash(publicUrl: string): string {
  return createHash('sha256').update(JSON.stringify(defs(publicUrl))).digest('hex');
}

/** Applies the commands and the menu button when their hash changed. Returns true when calls were made. */
export async function syncCommands(api: Api, kv: KvRepo, publicUrl: string, log: Logger): Promise<boolean> {
  const hash = commandsHash(publicUrl);
  let stored: string | undefined;
  try {
    stored = kv.get<string>('commands_hash');
  } catch {
    stored = undefined;
  }
  if (stored === hash) return false;
  const raw = rawOf(api);
  try {
    for (const c of defs(publicUrl).calls) await raw[c.method]!(c.payload);
    kv.set('commands_hash', hash);
    log.info({ hash: hash.slice(0, 12) }, 'bot commands and menu button updated');
  } catch (e) {
    log.warn({ err: errInfo(e) }, 'setMyCommands / setChatMenuButton / setMyDescription failed; will retry at next boot');
  }
  return true;
}
