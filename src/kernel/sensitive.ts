// kernel/sensitive.ts (friend mode, spec 05 B1 "sensitive facts … are never used in proactive messages") — a
// deterministic belt-and-braces check for health, fertility, mental-health, money-trouble and intimate matters (EN + RU).
// It backs the memory layer's sensitivity flag wherever Gora writes FIRST (proactive policy, date nudges): an item, a
// profile summary, a recent turn or a composed draft that trips it is never used. False positives only cost a message.
// Pure; no I/O.

/** Stems that must start a word ("rak" must not match "prakticheski"). */
const PREFIX = [
  // health (EN)
  'doctor', 'hospital', 'clinic', 'diagnos', 'surgery', 'surgeon', 'pregnan', 'cancer', 'chemo', 'oncolog', 'tumou?r', 'biops', 'medicat',
  'illness', 'sick', 'disease', 'symptom', 'infection', 'covid', 'diabet', 'insulin', 'mri(?!\\p{L})', 'hiv(?!\\p{L})', 'aids(?!\\p{L})',
  'std(?!\\p{L})', 'ivf(?!\\p{L})', 'miscarr', 'abortion', 'contracept', 'gyn(?:a)?ecolog', 'urolog', 'rehab', 'overdose', 'addict',
  'alcoholi', 'relapse', 'injur', 'erectile', 'viagra',
  // mental health (EN)
  'psychiatr', 'psycholog', 'psychother', 'panic attack', 'anxiety disorder', 'adhd(?!\\p{L})', 'bipolar', 'schizo', 'autis', 'suicid',
  'self[- ]?harm', 'eating disorder', 'anorex', 'bulimi', 'ptsd(?!\\p{L})', 'counsel+ing',
  // money trouble (EN)
  'salary', 'debt', 'loan', 'mortgage', 'bankrupt', 'owe[sd]?(?!\\p{L})', 'owing(?!\\p{L})', 'overdraft', 'debt collector', 'evict',
  'foreclos', 'lawsuit', 'arrest',
  // intimate (EN)
  'sex', 'porn', 'divorce', 'love affair', 'cheated on', 'escort',
  // health (RU)
  'врач', 'больниц', 'клиник', 'диагноз', 'операци', 'хирург', 'беремен', 'химио', 'онколог', 'опухол', 'биопси', 'лекарств', 'болезн',
  'болею', 'заболел', 'симптом', 'инфекц', 'диабет', 'инсулин', 'мрт(?!\\p{L})', 'вич(?!\\p{L})', 'спид(?!\\p{L})', 'эко(?!\\p{L})',
  'выкидыш', 'аборт', 'гинеколог', 'уролог', 'реабилит', 'передоз', 'наркот', 'наркол', 'алкоголи', 'травм',
  'рак(?:а|ом|у|е)?(?!\\p{L})',
  // mental health (RU)
  'психиатр', 'психолог', 'паническ', 'суицид', 'самоповрежд', 'биполяр', 'шизофрен', 'аутизм', 'анорекс', 'булими', 'птср(?!\\p{L})',
  // money trouble (RU)
  'зарплат', 'долг(?:и|а|ов|у|ом|ами)?(?!\\p{L})', 'задолж', 'кредит', 'ипотек', 'займ(?:а|ы|ов|ом)?(?!\\p{L})', 'микрозайм', 'коллектор', 'банкрот', 'выселен',
  'арест',
  // intimate (RU)
  'секс', 'порно', 'развод', 'интим', 'любовниц', 'любовник',
];
/** Stems that also match inside a word (chemoTHERAPy, психоТЕРАПевт, antiDEPRESSants, inFERTILity). */
const INFIX = ['therap', 'терап', 'depress', 'депресс', 'fertil', 'бесплод'];

const SENSITIVE = new RegExp([...PREFIX.map((x) => `(?<!\\p{L})${x}`), ...INFIX].join('|'), 'iu');

export function looksSensitive(text: string): boolean {
  return SENSITIVE.test(text);
}
