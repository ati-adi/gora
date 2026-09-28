// ── contracts/behaviour.ts (friend foundation, spec 05 §C) — signals, rhythm/style hints and the learned proactive policy.
// Owned by src/behaviour/ (tables user_signals, user_rhythm, proactive_arms, proactive_log). Zero LLM calls except the
// two per proactive message (compose + friend check, through SideCalls.structured).
import type { Ms, UserId } from './common.ts';

export type SignalKind = 'inbound' | 'gora_sent' | 'reply' | 'reaction' | 'feedback' | 'blocked' | 'unblocked';
/** Who initiated a Gora-first message. Everything here counts toward the shared "1 proactive per 24 h" cap except 'reminder' (user-requested). */
export type GoraSentSource = 'proactive' | 'nudge' | 'brief' | 'reminder' | 'checkin';
export type ProactiveContentType = 'follow_up' | 'useful' | 'checkin' | 'first_hint';
export const PROACTIVE_CONTENT_TYPES: readonly ProactiveContentType[] = ['follow_up', 'useful', 'checkin', 'first_hint'];
export type GapBucket = '<1d' | '1-2d' | '3-5d' | '6-10d' | '11-20d' | '21-45d' | '>45d';
export const GAP_BUCKETS: readonly GapBucket[] = ['<1d', '1-2d', '3-5d', '6-10d', '11-20d', '21-45d', '>45d'];
export type ProactiveLevel = 'off' | 'less' | 'normal' | 'more';
/** C5: τ multiplier per level (off = never). */
export const PROACTIVE_TAU_SCALE: Readonly<Record<ProactiveLevel, number>> = Object.freeze({ off: Number.POSITIVE_INFINITY, less: 1.5, normal: 1, more: 0.7 });

/** C3 derived hints (one `<user_model>` line). Explicit overrides (UserSettings.style) win over these. */
export interface StyleHints { replyLength: 'short' | 'medium' | 'long'; emoji: 'none' | 'light' | 'lots'; register: 'informal' | 'formal' | 'mixed'; languages: string[] }
/** C5 explicit style overrides (user_settings.style_json), written by settings_update. */
export interface StyleOverrides { length?: 'short' | 'medium' | 'long'; emoji?: 'none' | 'light' | 'lots'; register?: 'informal' | 'formal' }

/**
 * C1 capture points. Every method is synchronous, cheap, never throws to its caller (errors are logged), and stores
 * features only (numbers and enums, never text).
 *  - inbound: the DM surface, for every owner-authored private message (text, voice transcript, caption). It also
 *    resolves the reward of an open proactive message (reply ≤ 24 h), resets the unanswered counter, and un-blocks a
 *    user whose status was 'blocked'.
 *  - goraSent: whoever sends a Gora-initiated message (proactive tick, nudges, brief, check-ins, reminders).
 *  - reaction: message_reaction on a Gora message. feedback: an explicit preference ("don't write first" → 'stop').
 *  - blocked: a Telegram 403 "bot was blocked by the user" on any send → users.status='blocked' (stops proactive).
 */
export interface SignalsService {
  inbound(userId: UserId, m: { at: Ms; text: string; replyToTgMessageId?: number | null }): void;
  goraSent(userId: UserId, m: { at: Ms; source: GoraSentSource; arm?: string; refId?: string; tgMessageId?: number }): void;
  reaction(userId: UserId, m: { at: Ms; emoji: string; tgMessageId: number }): void;
  feedback(userId: UserId, m: { at: Ms; kind: 'stop' | 'less' | 'more' | 'style' }): void;
  blocked(userId: UserId, at: Ms): void;
  lastInboundAt(userId: UserId): Ms | null;
  /** C2: P(active | weekday, hour) in the owner's local time at `at`. */
  pActive(userId: UserId, at: Ms): number;
  /** C3: null until enough messages were seen. */
  styleHints(userId: UserId): StyleHints | null;
}

export interface ProactiveDecision {
  userId: UserId;
  send: boolean;
  /** 'not_eligible:<why>' | 'off_peak' | 'cap_24h' | 'hard_stop' | 'below_tau' | 'no_content' | 'judge_veto' | 'sent' | … (ledger / tests; never shown to the user) */
  reason: string;
  contentType?: ProactiveContentType;
  gapBucket?: GapBucket;
  score?: number;
}
/** C4. The `proactive_tick` job (every 30 min) calls tick(); NudgeGate and quiet hours stay authoritative. */
export interface ProactivePolicy {
  tick(now: Ms, o?: { signal?: AbortSignal }): Promise<{ considered: number; sent: number }>;
  /** One user's decision without composing or sending (tests, /why). Uses s.random for the Thompson draws. */
  decide(userId: UserId, now: Ms): ProactiveDecision;
  /**
   * The shared 24 h cap (C4 "Integration"): false when any Gora-initiated message that counts (proactive, nudge, brief,
   * checkin) was sent to the user in the last 24 h, or the user is blocked / paused / proactive 'off'. The brief and the
   * nudges about user-requested items still send (they are not gated by this), but they report through
   * SignalsService.goraSent so they count; the unrequested nudge kinds (e.g. date_from_memory, checkin) ask this first.
   */
  canSendNow(userId: UserId, now: Ms): boolean;
  /**
   * /why on a proactive message. Convention: proactive_log ids start with 'pl_' and the sent message is recorded in
   * tg_links as kind 'nudge' with nudge_id = that id (tg_links.kind has a CHECK list; no migration needed), so
   * surfaces/why.ts routes 'pl_' ids here and the nudge handlers skip them.
   */
  explain(logId: string): { contentType: ProactiveContentType; gapBucket: GapBucket; score: number; reason: string; sentAt: Ms | null } | undefined;
}
/** proactive_log.id prefix (see ProactivePolicy.explain). */
export const PROACTIVE_LOG_PREFIX = 'pl_';
