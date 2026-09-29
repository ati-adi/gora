// groups/chime.ts (GR, spec 07 C4) — the group_chime job: after a burst ends (a 45 s lull) decide whether Gora says
// something unprompted. Order (cheapest first, C7): caps (≤ 1 per 30 min, ≤ 6 per local day, never at night in the
// group's zone, no zone → none) → llmBudget('background') → the local heuristic (venting vetoes) → the fast judge (only
// windows over the chattiness threshold) → the per-group Thompson draw for the judge's kind → the main-model compose
// (≤ 2 sentences, sanitized) → send, then open the 10-min reward window. Everything runs at priority 'background'.
import type { GroupChattiness, GroupChimeKind, JobHandler, Ms } from '../contracts/index.ts';
import { sanitizeDraft } from '../behaviour/compose.ts';
import { inQuietHours, localDay, wallTimeOf } from '../kernel/timeMath.ts';
import type { GroupCtx } from './ctx.ts';
import type { Feedback } from './feedback.ts';
import { drawThetas, THETA_GATE } from './feedback.ts';
import { scoreWindow, thresholdOf, type WindowMessage } from './heuristic.ts';
import { capSentences, COMPOSE_SYSTEM, ComposeSchema, composeUser, JUDGE_SYSTEM, JudgeSchema, judgeUser, transcript, withSummary } from './prompts.ts';
import type { PolicyRow, StoredMessage } from './repo.ts';

export type CapReason = 'spacing' | 'daily' | 'night' | 'no_tz';
export interface CapLimits { groupChimeMinGapMs: number; groupChimeMaxPerDay: number; groupNightStart: string; groupNightEnd: string }

/** C4 caps, pure. `today` is the chime counter's local day in the group zone. */
export function capsCheck(p: Pick<PolicyRow, 'lastChimeAt' | 'chimesDay' | 'chimesToday'>, now: Ms, tz: string | null, L: CapLimits): { ok: true; day: string; today: number } | { ok: false; reason: CapReason } {
  if (!tz) return { ok: false, reason: 'no_tz' };
  if (p.lastChimeAt !== null && now - p.lastChimeAt < L.groupChimeMinGapMs) return { ok: false, reason: 'spacing' };
  if (inQuietHours(now, tz, L.groupNightStart, L.groupNightEnd)) return { ok: false, reason: 'night' };
  const day = localDay(now, tz);
  const today = p.chimesDay === day ? p.chimesToday : 0;
  if (today >= L.groupChimeMaxPerDay) return { ok: false, reason: 'daily' };
  return { ok: true, day, today };
}

const toWindow = (m: StoredMessage): WindowMessage => ({ tgMessageId: m.tgMessageId, fromTgId: m.fromTgId, isBot: m.kind === 'bot', text: m.text, at: m.at, replyToTgMessageId: m.replyToTgMessageId, addressed: m.addressed !== null });

export function createChime(g: GroupCtx, fb: Feedback, o: { onSent: (p: { chatId: number; threadId: number | null; tgMessageId: number; text: string; at: Ms; kind: GroupChimeKind }) => void }) {
  const { s } = g;

  /** Why a chime check stopped (tests and logs; never member text). */
  type Outcome = 'off' | 'quiet' | CapReason | 'budget' | 'empty' | 'veto' | 'below' | 'recheck' | 'judge_no' | 'bandit_no' | 'compose_failed' | 'sent';

  async function check(chatId: number, signal?: AbortSignal): Promise<Outcome> {
    if (!g.readsAll()) return 'off';
    const L = g.L();
    const pol = g.repo().policy(chatId);
    if (!pol) return 'empty';
    const level: GroupChattiness = pol.chattiness;
    if (level === 'quiet') return 'quiet';
    const now = s.clock.now();
    const tz = g.tzOf(chatId);
    if (tz && tz !== pol.tz) g.repo().updatePolicy(chatId, { tz });
    const caps = capsCheck(pol, now, tz, L);
    if (!caps.ok) return caps.reason;

    // the window: what members wrote in the last 30 minutes (≤ 30 messages)
    const msgs = g.repo().recent(chatId, { sinceAt: now - 30 * 60_000, limit: L.groupWindowMaxMessages });
    if (!msgs.some((m) => m.kind !== 'bot')) return 'empty';
    const score = scoreWindow(msgs.map(toWindow), now, { unansweredMs: L.groupUnansweredQuestionMs });
    if (score.veto) return 'veto';
    const threshold = thresholdOf(level, pol.thresholdAdj);
    if (score.score < threshold) {
      if (score.recheckAt !== null && score.recheckAt > now) {
        s.scheduler.schedule({ kind: 'group_chime', runAt: score.recheckAt, refId: String(chatId), payload: { chatId }, dedupeKey: `gchime:${chatId}` });
        return 'recheck';
      }
      return 'below';
    }
    if (!s.llmBudget.allow('background')) return 'budget';

    const lang = g.langOf(chatId);
    const sum = g.repo().summary(chatId);
    const lines = transcript(msgs, { tz, maxCharsPerLine: 400 });
    const judgeIn = await s.untrusted.wrap({ source: 'group_member', label: 'group chat', text: withSummary(sum?.summary ?? null, lines, 800), priority: 'background' });
    const judge = await s.side.structured(
      { purpose: 'group_judge', role: 'fast', system: JUDGE_SYSTEM, user: judgeUser({ wrapped: judgeIn.text, lang, localTime: localTimeOf(now, tz ?? 'UTC'), hint: score.kind, reasons: score.reasons }), schema: JudgeSchema, maxTokens: 200 },
      { priority: 'background', ...(signal ? { signal } : {}) },
    );
    if (!judge?.should_speak) return 'judge_no';
    const value = judge.value.slice(0, L.groupJudgeValueMaxChars);

    // C4 learning: Thompson draw for the judge's kind; a low θ = "this group does not want that kind now"
    const thetas = drawThetas(s.random, pol.arms, g.repo().pooledArms(chatId), { alpha: L.groupPriorAlpha, beta: L.groupPriorBeta });
    const theta = thetas[judge.kind];
    if (theta < THETA_GATE[level]) {
      g.log().info({ chatId, kind: judge.kind, theta: Math.round(theta * 1000) / 1000 }, 'groups: bandit skipped a chime-in');
      return 'bandit_no';
    }

    const composed = await s.side.structured(
      { purpose: 'group_compose', role: 'main', system: COMPOSE_SYSTEM, user: composeUser({ wrapped: judgeIn.text, lang, kind: judge.kind, value }), schema: ComposeSchema, maxTokens: 200 },
      { priority: 'background', ...(signal ? { signal } : {}) },
    );
    const clean = composed ? sanitizeDraft(composed.text) : null;
    const text = clean ? capSentences(clean, L.groupChimeMaxSentences) : '';
    if (!text) return 'compose_failed';

    // the caps again: the model calls took time, and another chime may have gone out meanwhile
    const pol2 = g.repo().policy(chatId);
    const caps2 = pol2 ? capsCheck(pol2, s.clock.now(), tz, L) : ({ ok: false, reason: 'spacing' } as const);
    if (!caps2.ok || pol2?.chattiness === 'quiet') return caps2.ok ? 'quiet' : caps2.reason;

    const anchor = msgs.filter((m) => m.kind !== 'bot').at(-1)!;
    const threadId = anchor.threadId;
    const sent = await s.telegram.outbox.sendNow({
      idempotencyKey: `gchime:${chatId}:${anchor.tgMessageId}`,
      chatId,
      ...(threadId ? { threadId } : {}),
      method: 'sendMessage',
      payload: { text, link_preview_options: { is_disabled: true } },
      priority: 5,
    });
    const ref = sent[0];
    if (!ref) return 'compose_failed';
    const at = s.clock.now();
    g.repo().updatePolicy(chatId, { lastChimeAt: at, chimesDay: caps2.day, chimesToday: caps2.today + 1 });
    o.onSent({ chatId, threadId, tgMessageId: ref.messageId, text, at, kind: judge.kind });
    fb.openWindow(chatId, ref.messageId, judge.kind, at);
    g.log().info({ chatId, kind: judge.kind, score: Math.round(score.score * 100) / 100 }, 'groups: chimed in');
    return 'sent';
  }

  const job: JobHandler = async (jobRow, ctx) => {
    const chatId = Number(jobRow.payload['chatId']);
    if (!Number.isFinite(chatId)) return { status: 'done' };
    try {
      const out = await check(chatId, ctx.signal);
      if (out !== 'off' && out !== 'empty') g.log().debug({ chatId, out }, 'groups: chime check');
    } catch (e) {
      const name = e instanceof Error ? e.name : 'error';
      if (name === 'TransientLlmError') return { status: 'retry', error: name };
      g.log().warn({ chatId, err: name }, 'groups: chime check failed');
    }
    return { status: 'done' };
  };

  return { check, job };
}

function localTimeOf(now: Ms, tz: string): string {
  const w = wallTimeOf(now, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)} (${tz})`;
}
