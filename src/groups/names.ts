// groups/names.ts (GR, spec 07 C4) — pure text detectors for the group surface:
//  - addressedByName: "Гора, …", "Gora what's up", "гора ты тут?", "…, Гора?" — a message that talks TO Gora by name is
//    handled like a mention. The common noun ("поехали в горы", "на горе", "горах") never matches: the name must be
//    followed by a non-letter, and must open the message (optionally after "эй"/"hey"/"ну") or close it after a comma.
//  - chattinessFromWords: "тише" / "не лезь" / "замолчи" → quieter; "можешь чаще" / "активнее" → louder; "только когда
//    позовут" → quiet. Only meaningful for a message already addressed to Gora (the surface checks that first).
import type { GroupChattiness } from '../contracts/index.ts';

const NOT_LETTER = '(?![\\p{L}\\p{N}_])';
const NAMES = '(?:гора|горушка|gora)';
/** Opening address: "Гора, …", "gora what's up", "эй гора", "hey Gora!". */
const LEADING = new RegExp(`^[\\s"'«(]*(?:(?:эй|ей|ну|слушай|hey|hi|yo|ok|ок)[\\s,!]+)?${NAMES}${NOT_LETTER}`, 'iu');
/** Closing vocative: "как думаешь, Гора?", "thanks, Gora!". */
const TRAILING = new RegExp(`[,—-]\\s*${NAMES}\\s*[?!.)]*\\s*$`, 'iu');

export function addressedByName(text: string): boolean {
  const t = text.slice(0, 500);
  if (!t.trim()) return false;
  return LEADING.test(t) || TRAILING.test(t);
}

/** The text with a leading "Гора," / "@bot" address removed (for word commands and catch-up phrases). */
export function stripAddress(text: string, botUsername?: string): string {
  let t = text;
  if (botUsername) t = t.replace(new RegExp(`@${botUsername.replace(/[^A-Za-z0-9_]/g, '')}\\b`, 'gi'), ' ');
  t = t.replace(new RegExp(`^[\\s"'«(]*(?:(?:эй|ей|ну|слушай|hey|hi|yo|ok|ок)[\\s,!]+)?${NAMES}${NOT_LETTER}[\\s,!:.—-]*`, 'iu'), '');
  t = t.replace(new RegExp(`[,—-]\\s*${NAMES}\\s*([?!.)]*)\\s*$`, 'iu'), '$1');
  return t.replace(/\s+/g, ' ').trim();
}

const QUIET_ONLY = [
  /только\s+(?:когда|если)\s+(?:тебя\s+)?(?:позовут|зовут|упомянут|спросят)/iu,
  /(?:не\s+пиши|молчи)\s+(?:сама|сам|первой|первым)/iu,
  /only\s+(?:when|if)\s+(?:you(?:'re| are)\s+)?(?:asked|mentioned|called|tagged)/i,
  /don'?t\s+(?:chime\s+in|speak\s+up|write)\s+(?:at\s+all|unless)/i,
];
const QUIETER = [
  /(?:^|[^\p{L}])(?:по)?тише(?![\p{L}])/iu,
  /не\s+(?:лезь|встревай|вмешивайся|влезай|перебивай)/iu,
  /(?:^|[^\p{L}])(?:за|по)?молчи(?![\p{L}])/iu,
  /заткнись|помолчи|пореже|меньше\s+(?:пиши|болтай|встревай)|хватит\s+(?:встревать|болтать|лезть)/iu,
  /\b(?:be\s+quiet(?:er)?|quiet\s+down|shut\s+up|hush|stop\s+(?:chiming\s+in|interrupting)|less\s+often|talk\s+less|butt\s+out|chime\s+in\s+less)\b/i,
];
const LOUDER = [
  /(?:можешь|можно)\s+(?:писать\s+|встревать\s+|говорить\s+)?(?:по)?чаще/iu,
  /(?:^|[^\p{L}])(?:будь\s+)?активнее(?![\p{L}])/iu,
  /говори\s+больше|пиши\s+(?:по)?чаще|встревай\s+(?:по)?чаще|больше\s+(?:пиши|участвуй)|не\s+стесняйся/iu,
  /\b(?:chime\s+in\s+more|speak\s+up\s+more|be\s+more\s+active|more\s+often|talk\s+more|feel\s+free\s+to\s+(?:chime|jump)\s+in)\b/i,
];

/** A negation before the phrase in the same clause ("не пиши чаще", "you don't need to chime in more often"). */
const NEGATION_BEFORE = /(?:^|[^\p{L}])(?:не|нет|ни|никогда|незачем|не\s+надо|не\s+нужно|don'?t|do\s+not|doesn'?t|does\s+not|no\s+need|not|never|stop)(?![\p{L}])[^.!?;]*$/iu;

/**
 * A chattiness command in a message addressed to Gora. Long messages are not commands ("не лезь к нему со своими
 * советами, лучше расскажи…" is a question): only short ones (≤ 80 chars after the address) count.
 * s07 lead fix (red team): quieter wins over louder, and a negated "louder" phrase ("не пиши чаще", "don't talk more
 * than needed") means quieter — when in doubt Gora never steps UP.
 */
export function chattinessFromWords(text: string): GroupChattiness | 'quieter' | 'louder' | null {
  const t = stripAddress(text);
  if (!t || t.length > 80) return null;
  if (QUIET_ONLY.some((r) => r.test(t))) return 'quiet';
  if (QUIETER.some((r) => r.test(t))) return 'quieter';
  for (const r of LOUDER) {
    const m = r.exec(t);
    if (!m) continue;
    const phrase = m[0].replace(/^[^\p{L}]+/u, '');
    if (/^не\s+стесняйся/iu.test(phrase)) return 'louder'; // "don't be shy" is itself the louder request
    return NEGATION_BEFORE.test(t.slice(0, m.index + (m[0].length - phrase.length))) ? 'quieter' : 'louder';
  }
  return null;
}

/** quiet < less < normal < more. */
export const CHATTINESS_ORDER: readonly GroupChattiness[] = ['quiet', 'less', 'normal', 'more'];
export function stepChattiness(cur: GroupChattiness, dir: 'quieter' | 'louder'): GroupChattiness {
  const i = CHATTINESS_ORDER.indexOf(cur);
  const j = dir === 'quieter' ? Math.max(0, i - 1) : Math.min(CHATTINESS_ORDER.length - 1, i + 1);
  return CHATTINESS_ORDER[j]!;
}
