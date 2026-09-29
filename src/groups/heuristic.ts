// groups/heuristic.ts (GR, spec 07 C4 step 1) — the local, zero-LLM score of a group window after a burst ends.
// Positive signals: an open question to the group unanswered ≥ 2 min, a factual disagreement, planning / scheduling, a
// recommendation request, an explicit help request. Negative: a personal or emotional conversation (venting → veto: Gora
// never chimes in there) and a fast back-and-forth (≥ 6 messages a minute). Only windows over the chattiness threshold
// go on to the fast judge. Pure: no I/O, no clock, no randomness.
import type { GroupChattiness, GroupChimeKind, Ms } from '../contracts/index.ts';

export interface WindowMessage {
  tgMessageId: number;
  fromTgId: number;
  /** Gora's own message (kind 'bot'). */
  isBot: boolean;
  text: string;
  at: Ms;
  replyToTgMessageId: number | null;
  /**
   * The message addressed Gora (mention, reply to Gora, name, command): it gets the addressed reply, so it is never an
   * "open question to the group" nor a recommendation/help signal (s07 lead fix: no double answer on a slow run).
   */
  addressed?: boolean;
}

export interface WindowScore {
  score: number;
  /** The kind the strongest signal suggests (the judge may choose another). */
  kind: GroupChimeKind | null;
  reasons: string[];
  /** Venting / a personal conversation: never chime in, whatever the score. */
  veto: boolean;
  /** A positive open question that is not yet old enough (< unansweredMs): the chime check should come back at this time. */
  recheckAt: Ms | null;
}

export interface ScoreOptions { unansweredMs: number }

const QUESTION_WORDS_RU = /^(?:а\s+)?(?:кто|что|чё|где|куда|когда|как|какой|какая|какое|какие|почему|зачем|сколько|чей|чья|откуда|есть\s+ли|можно\s+ли|кто-нибудь|кто-то|никто\s+не)(?![\p{L}])/iu;
const QUESTION_WORDS_EN = /^(?:who|what|where|when|how|why|which|does\s+anyone|anyone|is\s+there|are\s+there|can\s+someone|do\s+you\s+guys|should\s+we)\b/i;
const TO_GROUP = /(?:кто[-\s]?(?:нибудь|то)|кто\s+знает|ребят|ребята|народ|друзья|все\b|anyone|anybody|someone|guys|folks|y'?all|does\s+anyone)/iu;

const DISAGREE = [
  /(?:^|[^\p{L}])(?:нет|неа),?\s+(?:это\s+)?не\s+так/iu,
  /это\s+не\s+(?:так|правда)|неправда|ты\s+не\s+прав|вы\s+не\s+правы|на\s+самом\s+деле|вообще-то|ошибаешься|не\s+может\s+быть/iu,
  /\b(?:actually|that'?s\s+(?:not\s+(?:true|right)|wrong)|you'?re\s+wrong|no\s+way|not\s+true|incorrect|i\s+don'?t\s+think\s+so)\b/i,
];
const PLANNING = [
  /когда\s+(?:соберёмся|соберемся|встречаемся|встретимся|увидимся|едем|идём|идем)|где\s+(?:встречаемся|встретимся|собираемся|соберёмся|соберемся)|во\s+сколько|давайте\s+(?:в|соберёмся|соберемся|встретимся|сходим|пойдём|пойдем|поедем)/iu,
  /(?:^|[^\p{L}])(?:в|во|на)\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|выходных|выходные)(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:завтра|послезавтра|сегодня\s+вечером)(?![\p{L}])|(?:^|\s)(?:в|к)\s+\d{1,2}(?:[:.]\d{2})?(?:\s|$)/iu,
  /\b(?:when\s+(?:should|shall|do|can)\s+we|where\s+(?:should|shall|do)\s+we\s+meet|let'?s\s+(?:meet|go|do)|what\s+time|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+weekend|tomorrow)\b/i,
];
const RECOMMEND = [
  /посоветуйте|посоветуешь|порекомендуйте|что\s+посмотреть|куда\s+(?:сходить|пойти|поехать)|какой\s+(?:лучше|выбрать)|что\s+лучше|что\s+почитать/iu,
  /\b(?:recommend|recommendation|any\s+suggestions|suggest|which\s+(?:one\s+)?is\s+better|what'?s\s+a\s+good|where\s+to\s+(?:eat|go))\b/i,
];
const HELP = [
  /помогите|подскажите|кто\s+знает|кто\s+шарит|не\s+могу\s+(?:найти|понять|разобраться)/iu,
  /\b(?:help|anyone\s+know|does\s+anyone\s+know|can\s+someone\s+explain|how\s+do\s+i)\b/i,
];
/** Venting / personal / emotional: a veto (C4 "never in a thread where someone is venting"). */
const VENTING = [
  /устал[аи]?\s+(?:от|жить|так)|всё\s+достало|все\s+достало|бесит|ненавижу|плачу|плакать|депресс|тревог|одиноко|обидно|грустно|тоскливо|мне\s+(?:плохо|тяжело|хреново|больно|страшно)|расстал(?:ись|ся|ась)|развод|умер(?:ла)?|похорон|болею|в\s+больнице|паническ|выгорани|сорвал(?:ся|ась)\s+на|не\s+хочу\s+жить/iu,
  /\b(?:i'?m\s+(?:so\s+)?(?:sad|depressed|exhausted|anxious|lonely|devastated|heartbroken)|i\s+feel\s+(?:awful|terrible|so\s+alone|like\s+crying)|breakup|broke\s+up|passed\s+away|funeral|panic\s+attack|burn(?:ed|t)?\s*out|hate\s+my\s+life|crying)\b/i,
];

const has = (rs: readonly RegExp[], t: string) => rs.some((r) => r.test(t));

export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /\?\s*[)\p{Emoji_Presentation}]*\s*$/u.test(t) || /\?/.test(t) || QUESTION_WORDS_RU.test(t) || QUESTION_WORDS_EN.test(t);
}
export const isVenting = (text: string): boolean => has(VENTING, text);

/** Chattiness → base threshold; 'quiet' = mention-only (never chime in). */
export const BASE_THRESHOLD: Readonly<Record<GroupChattiness, number>> = Object.freeze({ quiet: Number.POSITIVE_INFINITY, less: 0.7, normal: 0.5, more: 0.35 });
export function thresholdOf(level: GroupChattiness, adj: number): number {
  const base = BASE_THRESHOLD[level];
  if (!Number.isFinite(base)) return base;
  return Math.min(0.95, Math.max(0.2, base + Math.max(-0.2, Math.min(0.3, adj))));
}

/**
 * Scores the members' messages of a window (Gora's own lines split it: only what came after Gora's last message counts
 * as open). `now` is the lull check time.
 */
export function scoreWindow(all: readonly WindowMessage[], now: Ms, o: ScoreOptions): WindowScore {
  const lastBot = [...all].reverse().find((m) => m.isBot);
  const msgs = all.filter((m) => !m.isBot && (!lastBot || m.at >= lastBot.at));
  const out: WindowScore = { score: 0, kind: null, reasons: [], veto: false, recheckAt: null };
  if (msgs.length === 0) return out;

  // ── veto: venting / personal in the recent part of the window
  const recent = msgs.slice(-12);
  if (recent.some((m) => isVenting(m.text))) {
    out.veto = true;
    out.reasons.push('venting');
    return out;
  }

  // the positive signals only look at what was said to the group, never at what was said to Gora
  const toGroup = msgs.filter((m) => !m.addressed);
  if (toGroup.length === 0) return out;

  let bestW = 0;
  const add = (w: number, kind: GroupChimeKind, reason: string) => {
    out.score += w;
    out.reasons.push(reason);
    if (!out.kind || w > bestW) {
      out.kind = kind;
      bestW = w;
    }
  };

  // ── an open question to the group: nobody else wrote a reply to it / after it
  const byId = new Map(msgs.map((m) => [m.tgMessageId, m]));
  for (let i = msgs.length - 1; i >= 0; i--) {
    const q = msgs[i]!;
    if (q.addressed) continue;
    if (!isQuestion(q.text) || q.text.trim().length < 6) continue;
    // a question that replies to another member is addressed to that member, not to the group
    const target = q.replyToTgMessageId !== null ? byId.get(q.replyToTgMessageId) : undefined;
    if (target && target.fromTgId !== q.fromTgId && !TO_GROUP.test(q.text)) continue;
    const answered = msgs.slice(i + 1).some((m) => m.fromTgId !== q.fromTgId && (m.replyToTgMessageId === q.tgMessageId || m.replyToTgMessageId === null));
    if (answered) continue;
    const age = now - q.at;
    if (age >= o.unansweredMs) add(0.55, 'answer', 'open_question');
    else out.recheckAt = q.at + o.unansweredMs;
    break;
  }

  const texts = toGroup.map((m) => m.text);
  const joined = texts.join('\n');
  // ── a factual disagreement (two members at least)
  if (texts.some((t) => has(DISAGREE, t)) && new Set(toGroup.map((m) => m.fromTgId)).size >= 2) add(0.35, 'fact_check', 'disagreement');
  // ── planning / scheduling
  const planHits = texts.filter((t) => has(PLANNING, t)).length;
  if (planHits >= 1) add(planHits >= 2 ? 0.4 : 0.3, 'plan_help', 'planning');
  // ── a recommendation request / an explicit help request
  if (has(RECOMMEND, joined)) add(0.4, 'answer', 'recommendation');
  if (has(HELP, joined)) add(0.35, 'answer', 'help');

  // ── a fast back-and-forth: ≥ 6 messages within the last minute of the window
  const last = msgs.at(-1)!.at;
  const burst = msgs.filter((m) => m.at >= last - 60_000).length;
  if (burst >= 6) {
    out.score -= 0.3;
    out.reasons.push('fast_back_and_forth');
  }
  // a 1:1 exchange between two members only, many turns: probably a private conversation → damp
  const senders = new Set(msgs.slice(-8).map((m) => m.fromTgId));
  if (msgs.length >= 8 && senders.size === 2 && !out.reasons.includes('open_question')) {
    out.score -= 0.15;
    out.reasons.push('one_to_one');
  }
  out.score = Math.max(0, Math.min(1, out.score));
  return out;
}
