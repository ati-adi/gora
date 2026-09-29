// groups/feedback.ts (GR, spec 07 C4 learning) — the per-group Thompson bandit over chime-in kinds (Beta posteriors).
//  - reward (α+1): a positive reaction on the chime-in, or a reply to it / a message addressing Gora within 10 min;
//  - penalty (β+1): ignored (the 10-min window closes, job group_feedback) or a negative reaction;
//  - strong penalty (β+3, chattiness one step down, threshold up): "тише / не лезь / замолчи".
// The stored arms are the group's EVIDENCE only; the prior is the conservative population prior Beta(1,3) plus the other
// groups' pooled evidence (capped), added at decision time. Draws only through the injected Random (seeded in tests).
import type { GroupChattiness, GroupChimeKind, JobHandler, Ms, Random } from '../contracts/index.ts';
import { GROUP_CHIME_KINDS } from '../contracts/index.ts';
import { sampleBeta } from '../kernel/random.ts';
import type { GroupCtx } from './ctx.ts';
import { CHATTINESS_ORDER } from './names.ts';
import type { ArmEvidence } from './repo.ts';

export const POSITIVE_REACTIONS: readonly string[] = ['👍', '❤', '❤️', '🔥', '😂', '👏', '🙏', '🥰', '😁', '🤣', '💯', '🤝', '⚡', '🏆', '👌'];
export const NEGATIVE_REACTIONS: readonly string[] = ['👎', '🤡', '😴', '💩', '🙄', '🥱', '😐', '🤨'];
export const STRONG_PENALTY = 3;
/** Pooled evidence of other groups counts at most this many pseudo-observations (hierarchical prior cap). */
export const POOLED_CAP = 10;
/** θ gate per chattiness: a sampled θ below it means "not this time" (the bandit's send decision). */
export const THETA_GATE: Readonly<Record<GroupChattiness, number>> = Object.freeze({ quiet: 1, less: 0.25, normal: 0.15, more: 0.08 });

export function posterior(kind: GroupChimeKind, own: ArmEvidence, pooled: ArmEvidence, prior: { alpha: number; beta: number }): { a: number; b: number } {
  const [ps, pf] = pooled[kind];
  const n = ps + pf;
  const scale = n > POOLED_CAP ? POOLED_CAP / n : 1;
  return { a: prior.alpha + ps * scale + own[kind][0], b: prior.beta + pf * scale + own[kind][1] };
}

/** One Thompson draw per kind in GROUP_CHIME_KINDS order (fixed, so a seeded Random reproduces), returns θ of each. */
export function drawThetas(r: Random, own: ArmEvidence, pooled: ArmEvidence, prior: { alpha: number; beta: number }): Record<GroupChimeKind, number> {
  const out = {} as Record<GroupChimeKind, number>;
  for (const k of GROUP_CHIME_KINDS) {
    const p = posterior(k, own, pooled, prior);
    out[k] = sampleBeta(r, p.a, p.b);
  }
  return out;
}

export function createFeedback(g: GroupCtx) {
  const { s } = g;
  const window = () => g.L().groupRewardWindowMs;

  const bump = (chatId: number, kind: GroupChimeKind, success: number, failure: number, extra: Parameters<ReturnType<GroupCtx['repo']>['updatePolicy']>[1] = {}) => {
    const p = g.repo().policy(chatId);
    if (!p) return;
    const arms = { ...p.arms, [kind]: [p.arms[kind][0] + success, p.arms[kind][1] + failure] as [number, number] };
    g.repo().updatePolicy(chatId, { ...extra, arms });
    g.log().info({ chatId, kind, success, failure }, 'groups: bandit update');
  };
  const closeWindow = { openChimeTgMessageId: null, openChimeKind: null, openChimeAt: null } as const;

  /** Opens the 10-min reward window for a chime-in just sent (and arms the ignore check). */
  function openWindow(chatId: number, tgMessageId: number, kind: GroupChimeKind, at: Ms): void {
    g.repo().updatePolicy(chatId, { openChimeTgMessageId: tgMessageId, openChimeKind: kind, openChimeAt: at });
    s.scheduler.schedule({ kind: 'group_feedback', runAt: at + window(), refId: String(chatId), payload: { chatId, msg: tgMessageId }, dedupeKey: `gfb:${chatId}` });
  }

  /** A member's message: a reply to the open chime-in, or addressing Gora, within the window → reward. */
  function onMemberMessage(m: { chatId: number; replyToBot: boolean; replyToTgMessageId: number | null; addressed: string | null; at: Ms }): void {
    const p = g.repo().policy(m.chatId);
    if (!p?.openChimeTgMessageId || !p.openChimeKind || p.openChimeAt === null) return;
    const now = s.clock.now();
    if (now > p.openChimeAt + window()) return; // the job closes it as ignored
    const engages = (m.replyToBot && m.replyToTgMessageId === p.openChimeTgMessageId) || m.addressed === 'mention' || m.addressed === 'name' || (m.addressed === 'reply' && m.replyToTgMessageId === p.openChimeTgMessageId);
    if (!engages) return;
    bump(m.chatId, p.openChimeKind, 1, 0, closeWindow);
    s.scheduler.cancel(`gfb:${m.chatId}`);
  }

  function onReaction(p: { chatId: number; tgMessageId: number; fromTgId: number; emoji: readonly string[]; at: Ms }): void {
    try {
      if (!g.readsAll() || p.fromTgId === s.telegram.botInfo.id) return;
      const pol = g.repo().policy(p.chatId);
      if (!pol?.openChimeTgMessageId || pol.openChimeTgMessageId !== p.tgMessageId || !pol.openChimeKind) return;
      const pos = p.emoji.some((e) => POSITIVE_REACTIONS.includes(e));
      const neg = p.emoji.some((e) => NEGATIVE_REACTIONS.includes(e));
      if (!pos && !neg) return;
      bump(p.chatId, pol.openChimeKind, pos && !neg ? 1 : 0, neg ? 1 : 0, closeWindow);
      s.scheduler.cancel(`gfb:${p.chatId}`);
    } catch (e) {
      g.log().warn({ err: e instanceof Error ? e.name : 'error' }, 'groups: reaction failed');
    }
  }

  /** "тише" & co: β += 3 for the chime-in being told off (the open one, else the last within an hour). */
  function strongPenalty(chatId: number): void {
    const p = g.repo().policy(chatId);
    if (!p) return;
    const now = s.clock.now();
    const kind = p.openChimeKind ?? g.repo().lastChime(chatId, now - 60 * 60_000)?.kind ?? null;
    const adj = Math.min(0.3, p.thresholdAdj + 0.05);
    if (kind) bump(chatId, kind, 0, STRONG_PENALTY, { ...closeWindow, thresholdAdj: adj });
    else g.repo().updatePolicy(chatId, { thresholdAdj: adj });
    s.scheduler.cancel(`gfb:${chatId}`);
  }

  function setChattiness(chatId: number, level: GroupChattiness, o: { reason?: 'words' | 'settings' } = {}): GroupChattiness {
    g.repo().ensurePolicy(chatId);
    const prev = g.repo().policy(chatId)!.chattiness;
    const down = CHATTINESS_ORDER.indexOf(level) < CHATTINESS_ORDER.indexOf(prev);
    const up = CHATTINESS_ORDER.indexOf(level) > CHATTINESS_ORDER.indexOf(prev);
    if (down && o.reason === 'words') strongPenalty(chatId);
    const patch: { chattiness: GroupChattiness; thresholdAdj?: number } = { chattiness: level };
    // "можешь чаще": forget the learned caution (a negative offset never goes below the chattiness base)
    if (up) patch.thresholdAdj = Math.min(0, g.repo().policy(chatId)!.thresholdAdj);
    g.repo().updatePolicy(chatId, patch);
    if (level === 'quiet') s.scheduler.cancel(`gchime:${chatId}`);
    g.log().info({ chatId, from: prev, to: level, reason: o.reason ?? 'settings' }, 'groups: chattiness');
    return level;
  }

  /** group_feedback: the 10-min window closed with no engagement → ignored (β+1). No LLM. */
  const job: JobHandler = async (jobRow) => {
    const chatId = Number(jobRow.payload['chatId']);
    const msg = Number(jobRow.payload['msg']);
    if (!Number.isFinite(chatId)) return { status: 'done' };
    const p = g.repo().policy(chatId);
    if (!p?.openChimeTgMessageId || p.openChimeTgMessageId !== msg || !p.openChimeKind || p.openChimeAt === null) return { status: 'done' };
    const due = p.openChimeAt + window();
    if (s.clock.now() < due) return { status: 'reschedule', runAt: due };
    bump(chatId, p.openChimeKind, 0, 1, closeWindow);
    return { status: 'done' };
  };

  /** Retention sweep: windows left open (the job was lost) close as ignored. */
  function closeStale(chatId: number, now: Ms): void {
    const p = g.repo().policy(chatId);
    if (p?.openChimeKind && p.openChimeAt !== null && now > p.openChimeAt + window()) bump(chatId, p.openChimeKind, 0, 1, closeWindow);
  }

  return { openWindow, onMemberMessage, onReaction, setChattiness, job, closeStale };
}
export type Feedback = ReturnType<typeof createFeedback>;
