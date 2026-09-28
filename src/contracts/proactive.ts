// ── contracts/proactive.ts (WP0, frozen) — 01 §4.4
import type { InlineKeyboardButton } from 'grammy/types';
import type { Ms, Scope, TaintSource, UserId } from './common.ts';

export interface ReminderView { id: string; kind: 'reminder' | 'checkin' | 'followup'; text: string; display: string; status: string; cron: string | null }
export interface TodoView { id: string; text: string; done: boolean; position: number }
export interface ReminderService {
  create(p: { scope: Scope; userId: UserId | null; kind: 'reminder' | 'checkin' | 'followup'; text: string; atLocal?: string; cron?: string; tz: string; chatId: number; threadId?: number; sourceToolUseId?: string }): { id: string; display: string; unixSec: number; adjusted: 'none' | 'gap_shifted' | 'overlap_earlier' };
  list(scope: Scope, includeDone: boolean): ReminderView[];
  manage(id: string, scope: Scope, action: 'cancel' | 'snooze' | 'reschedule' | 'pause' | 'resume', arg?: { snoozeMin?: number; atLocal?: string; cron?: string }): ReminderView;
  rescheduleForTz(userId: UserId, tz: string): number;
}
export interface TodoService {
  apply(scope: Scope, authorUserId: UserId | null, a: { action: 'add' | 'complete' | 'reopen' | 'remove' | 'list'; text?: string; id?: string }): TodoView[];
  toggle(id: string, scope: Scope): TodoView[];
  /** WP0 addition (PATCH /api/todos/:id {done}): idempotent — sets done/undone; returns the scope's list. */
  setDone(id: string, scope: Scope, done: boolean): TodoView[];
  render(scope: Scope, lang: string): { markdown: string; buttons: InlineKeyboardButton[][] };
}
/** Every kind, in 01 §8.4 order (WP0 addition; prefs() returns them in this order). */
export const NUDGE_KINDS: readonly NudgeKind[] = ['commitment_due', 'they_owe_stale', 'unanswered_business', 'calendar_conflict', 'inbox_important', 'date_from_memory', 'watcher_hit', 'checkin'];
export type NudgeKind = 'commitment_due' | 'they_owe_stale' | 'unanswered_business' | 'calendar_conflict' | 'inbox_important' | 'date_from_memory' | 'watcher_hit' | 'checkin';
export interface NudgeCandidate { userId: UserId; kind: NudgeKind; dedupeKey: string; refId?: string; why: string; body: string; score: number /*0..1*/; priority: 'low' | 'normal' | 'high'; countsAgainstBudget: boolean }
export interface NudgeService {
  propose(c: NudgeCandidate): Promise<'sent' | 'deferred' | 'dropped'>;
  outcome(nudgeId: string, o: 'do' | 'snooze' | 'never' | 'ignored' | 'reaction_up' | 'reaction_down'): Promise<void>;
  remainingToday(userId: UserId): number;
  /** WP0 addition (/why "nudge reason"). */
  get(nudgeId: string): { id: string; userId: UserId; kind: NudgeKind; why: string; score: number; sentAt: Ms | null } | undefined;
  /** WP0 addition (/nudges, Mini App Settings): nudge_prefs per kind, one entry for every NudgeKind (defaults when no row). */
  prefs(userId: UserId): Array<{ kind: NudgeKind; muted: boolean; snoozeUntil: Ms | null }>;
  /** WP0 addition: upserts nudge_prefs (muted / snooze_until); weight and ignored_streak are untouched. */
  setPref(userId: UserId, kind: NudgeKind, p: { muted?: boolean; snoozeUntil?: Ms | null }): void;
}
export interface BriefService { run(userId: UserId, o: { preview: boolean }): Promise<void>; setDaily(userId: UserId, hhmm: string | null): void }
export interface CommitmentService {
  add(c: { userId: UserId; source: 'dm' | 'business'; direction: 'i_owe' | 'they_owe'; text: string; counterpart?: string; dueLocal?: string | null; businessConnectionId?: string; chatId?: number; sourceMessageId?: number; sourceInputId?: string }): string;
  deleteBySourceMessages(connectionId: string, chatId: number, messageIds: number[]): number;
}
export type WatchCondition =
  | { type: 'changed' }
  | { type: 'contains'; text: string }
  | { type: 'absent'; text: string }
  | { type: 'number_below'; near_text: string; threshold: number }
  | { type: 'semantic'; description: string };
export interface MissionView {
  id: string; title: string; status: 'active' | 'parked' | 'done' | 'failed' | 'cancelled' | 'budget_exhausted';
  threadId: number | null; conversationId: string; budgetUsd: number; spentUsd: number; deadlineAt: Ms | null;
  checklist: Array<{ text: string; done: boolean }>; createdAt: Ms;
}
export interface WatcherView {
  id: string; missionId: string | null; kind: 'page' | 'inbox'; target: string; condition: WatchCondition; intervalMin: number;
  status: 'active' | 'paused' | 'done' | 'cancelled'; nextCheckAt: Ms; lastCheckedAt: Ms | null; failCount: number;
}
export interface MissionService {
  start(p: { userId: UserId; tgUserId: number; title: string; goal: string; criteria: string[]; deadlineLocal?: string; budgetUsd?: number; taint: TaintSource[] }): Promise<{ missionId: string; threadId: number | null; conversationId: string }>;
  report(missionId: string, note: string, checklist?: Array<{ text: string; done: boolean }>): Promise<void>;
  finish(missionId: string, outcome: 'done' | 'failed' | 'cancelled', summary: string): Promise<void>;
  stop(missionId: string, byTgId: number): Promise<void>;
  addBudget(missionId: string, usd: number): Promise<void>;
  chargeCost(missionId: string, micros: number): { exhausted: boolean };
  // ── WP0 additions (Mini App, §5.5 notify channel, §5.6 approval expiry)
  get(missionId: string): MissionView | undefined;
  list(userId: UserId, o?: { active?: boolean }): MissionView[];
  /** The notify channel's status label on the mission status card (null clears it); WP6 coalesces edits to once per 3 s. */
  setStatusLine(missionId: string, label: string | null): Promise<void>;
}
export interface WatcherService {
  create(p: { userId: UserId; missionId?: string; kind: 'page' | 'inbox'; target: string; condition: WatchCondition; intervalMin: number; threadId?: number }): Promise<{ id: string }>;
  manage(id: string, userId: UserId, action: 'pause' | 'resume' | 'cancel'): void;
  check(id: string): Promise<void>;
  /** WP0 addition (Mini App Tasks / Planned). */
  list(userId: UserId): WatcherView[];
}
