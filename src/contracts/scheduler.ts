// ── contracts/scheduler.ts (WP0, frozen) — 01 §4.4
import type { Ms, UserId } from './common.ts';
import type { Priority } from './llm.ts';

/**
 * WP0 additions: 'backup' (§11.7 nightly backup of gora.db + keys.db, 7-day retention; WP1 registers it and upserts the
 * cron job with dedupeKey 'sys:backup') and 'nudge_deferred' (§8.4 NudgeGate step 6: a nudge deferred to
 * nextOutsideQuiet + jitter is re-proposed by this job; WP6, refId = nudge id).
 */
export type JobKind = 'run_wake' | 'resume_run' | 'epoch_rotate' | 'handoff_fork' | 'shred_epoch' | 'approval_expire' | 'first_look' | 'reminder_fire' | 'checkin_fire' | 'brief' | 'proactive_scan' | 'nudge_ignore' | 'watcher_check' | 'memory_extract' | 'followup_due' | 'incognito_end' | 'business_triage' | 'business_window' | 'business_digest' | 'subscription_reconcile' | 'rename_topic' | 'retention_sweep' | 'backup' | 'nudge_deferred'
  // friend-mode additions (spec 05): C4 policy tick (every 30 min, src/behaviour/), B4 profile consolidation (nightly per user
  // + after 15 new facts, src/memory/), B2 embedding backfill (local CPU, no LLM, src/memory/)
  | 'proactive_tick' | 'profile_consolidate' | 'memory_embed'
  // s07 additions (spec 07): BR browser_sweep (every 60 s: close sessions of ended tasks/missions, the 15-min wall clock,
  // crash recovery; no LLM); CAL integration_poll (every 5 s for 10 min per pending connect link; no LLM); GR
  // group_summarize (rolling summary + group fact extraction, batched: 40 messages or 10 idle min), group_chime (the
  // 45 s lull check: local heuristic → fast judge → main compose) and group_feedback (closes a chime-in's 10-min reward window; no LLM)
  | 'browser_sweep' | 'integration_poll' | 'group_summarize' | 'group_chime' | 'group_feedback';
export type JobPayload = Record<string, string | number | boolean | null>;
export interface NewJob { kind: JobKind; runAt: Ms; userId?: UserId; refId?: string; cron?: string; tz?: string; payload?: JobPayload /* ids & enums only, never content */; dedupeKey?: string; priority?: number; maxAttempts?: number }
export interface JobRow { id: string; kind: JobKind; runAt: Ms; userId: UserId | null; refId: string | null; cron: string | null; tz: string | null; payload: JobPayload; attempts: number; maxAttempts: number }
export type JobResult = { status: 'done' } | { status: 'reschedule'; runAt: Ms } | { status: 'retry'; error: string } | { status: 'dead'; error: string };
export type JobHandler = (job: JobRow, ctx: { now: Ms; signal: AbortSignal }) => Promise<JobResult>;
export interface Scheduler {
  schedule(j: NewJob): string; /* upsert by dedupeKey */
  cancel(idOrDedupeKey: string): void;
  register(kind: JobKind, h: JobHandler): void;
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<number>; /* tests */
  /** WP0 addition (Mini App Home / Planned): scheduled jobs of a user, soonest first. */
  list(q: { userId: UserId; kinds?: JobKind[]; limit: number }): Array<Pick<JobRow, 'id' | 'kind' | 'runAt' | 'refId' | 'cron' | 'tz'>>;
  /** WP0 addition (/healthz "last scheduler tick within 10 s"): Clock time of the last completed loop iteration; null before start(). */
  health(): { lastTickAt: Ms | null };
}

/**
 * 03 R6: the LLM priority of each job kind. Before claiming a job whose value is non-null, the scheduler asks
 * `s.llmBudget.allow(priority)`; when it says no, the job is re-queued with backoff instead of run. `null` means the
 * handler never calls the LLM itself and is never paused (reminder_fire must fire even when the budget is exhausted).
 * Handlers that start runs pass the same value as `startEventRun(..., {priority})`.
 */
export const JOB_LLM_PRIORITY: Readonly<Record<JobKind, Priority | null>> = Object.freeze({
  run_wake: 'approval', resume_run: 'approval', first_look: 'interactive', checkin_fire: 'reminder',
  brief: 'proactive', proactive_scan: 'proactive',
  memory_extract: 'background', business_triage: 'background', watcher_check: 'background', handoff_fork: 'background', epoch_rotate: 'background', rename_topic: 'background',
  shred_epoch: null, approval_expire: null, reminder_fire: null, nudge_ignore: null, followup_due: null, incognito_end: null,
  business_window: null, business_digest: null, subscription_reconcile: null, retention_sweep: null, backup: null, nudge_deferred: null,
  // friend-mode (spec 05 C6: proactive and consolidation pause at ≥ 85% of the daily quota; embeddings use no LLM)
  proactive_tick: 'proactive', profile_consolidate: 'background', memory_embed: null,
  // s07 (spec 07 C7: everything group-proactive is 'background' and pauses with llmBudget)
  browser_sweep: null, integration_poll: null, group_summarize: 'background', group_chime: 'background', group_feedback: null,
});
