// behaviour/features.ts (friend set B, spec 05 C1/C3) — cheap, deterministic features of an owner message. Only these
// numbers and enums are stored (user_signals); the text itself is never kept or logged.

export type Script = 'cyrillic' | 'latin' | 'other';
export interface TextFeatures { length: number; emoji: number; script: Script | null; question: boolean; register: 'informal' | 'formal' | null }

const EMOJI = /\p{Extended_Pictographic}/gu;
const CYR = /\p{Script=Cyrillic}/gu;
const LAT = /\p{Script=Latin}/gu;
const LETTER = /\p{L}/gu;
const w = (words: string) => new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, 'iu');
// ты / вы markers (the owner addressing Gora). "Вы" is formal; the plural "вы" is rare when talking to a bot.
const INFORMAL = w('ты|тебя|тебе|тобой|тобою|твой|твоя|твоё|твое|твои|твоего|твоей|твоих|привет|прив|пж|плиз|спс|го|давай|слушай|смотри|скажи|напомни|найди');
const FORMAL = w('вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашего|вашей|ваших|здравствуйте|скажите|напомните|найдите|подскажите|будьте добры|благодарю');
const QUESTION_START = w(
  'что|как|где|когда|почему|зачем|кто|какой|какая|какое|какие|сколько|можно|можешь|можете|есть ли|what|how|where|when|why|who|which|can|could|should|would|is|are|do|does|did|will',
);

export function textFeatures(text: string): TextFeatures {
  const t = text.trim();
  const length = Array.from(t).length;
  const emoji = (t.match(EMOJI) ?? []).length;
  const letters = (t.match(LETTER) ?? []).length;
  const cyr = (t.match(CYR) ?? []).length;
  const lat = (t.match(LAT) ?? []).length;
  let script: Script | null = null;
  if (letters >= 2) script = cyr >= lat && cyr > 0 ? 'cyrillic' : lat > 0 ? 'latin' : 'other';
  const firstWords = t.slice(0, 40);
  const question = t.includes('?') || QUESTION_START.test(firstWords.split(/[\s,]+/).slice(0, 2).join(' '));
  const inf = INFORMAL.test(t);
  const frm = FORMAL.test(t);
  const register = inf && !frm ? 'informal' : frm && !inf ? 'formal' : null;
  return { length, emoji, script, question, register };
}

/** The language the owner writes in, from the script and the Telegram language code (script wins on conflict). */
export function langOf(script: Script | null, languageCode: string | null): string | null {
  const lc = (languageCode ?? '').toLowerCase().slice(0, 2);
  const CYR_LANGS = new Set(['ru', 'uk', 'be', 'kk', 'ky', 'bg', 'sr', 'mk', 'mn', 'tg']);
  if (script === 'cyrillic') return CYR_LANGS.has(lc) ? lc : 'ru';
  if (script === 'latin') return lc && !CYR_LANGS.has(lc) ? lc : 'en';
  if (script === 'other') return lc || null;
  return null;
}
