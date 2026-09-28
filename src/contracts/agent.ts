// ── contracts/agent.ts (WP0, frozen) — 01 §4.4
import type { ChannelKind, Surface, TaintSource, UserId } from './common.ts';
import type { ConversationRow, EpochReason, ReplyRef, RunRow } from './storage.ts';
import type { Extracted, FactKind } from './memory.ts';
import type { ZodType } from 'zod';
import type { CallMeta, Priority } from './llm.ts';
import type { ToolkitId } from './tools.ts';
import type { UntrustedSource } from './trust.ts';

export type ConversationKey =
  | { kind: 'dm'; tgUserId: number; threadId?: number }
  | { kind: 'mission'; missionId: string }
  | { kind: 'group'; chatId: number; threadId?: number }
  | { kind: 'guest'; guestQueryId: string }
  | { kind: 'biz_draft' };
export interface ConversationService {
  resolve(key: ConversationKey, owner: { userId: UserId | null; tgChatId: number | null; threadId?: number; businessConnectionId?: string }): ConversationRow;
  scopeKeyOf(key: ConversationKey): string;
}
/**
 * `untrusted` parts are raw third-party text. WP3 passes each one through `s.untrusted.wrap()` (WP4, 01 §11.3, 03 R5)
 * when it builds the event row, exactly as it does for `InputRow.untrusted=true` inputs when it builds user rows;
 * nothing reaches a transcript row without that wrapper.
 */
export interface GoraEvent {
  type: 'checkin' | 'brief' | 'nudge_do' | 'first_look' | 'mission_start' | 'continue' | 'context_rotated' | 'guest_continue' | 'me_question' | 'draft_business_reply' | 'retry';
  ref?: string;
  body: string;
  untrusted?: Array<{ source: UntrustedSource; label: string; text: string }>;
}
export type WakePayload =
  | { reason: 'approval'; approvalId: string; decision: 'approved' | 'denied' | 'expired' | 'superseded'; executed: boolean; summary?: string }
  | { reason: 'watcher'; watcherId: string; summary: string }
  | { reason: 'user_input' }
  | { reason: 'timeout' }
  | { reason: 'cancelled' }
  | { reason: 'budget'; spentUsd: number; budgetUsd: number };
export interface AgentRunner {
  /**
   * Debounce 700 ms (max 2 s); starts a run if none is active. WP3 derives the run's replyRef from the conversation and
   * its newest pending input; `o.replyRef`, when given, is used instead for the next run this kick starts (WP7 passes
   * it for guest runs: guestQueryId, placeholder/inline ids and `continueUrl`).
   */
  kick(conversationId: string, o?: { replyRef?: ReplyRef }): void;
  /** `priority` (03 R6) is persisted as runs.priority and passed to every transport call of the run; default 'interactive'. */
  startEventRun(conversationId: string, ev: GoraEvent, o: { channel: ChannelKind; replyRef: ReplyRef; taint?: TaintSource[]; priority?: Priority }): string;
  wake(token: string, p: WakePayload): Promise<number>;
  stopByDraft(chatId: number, threadId: number, draftId: number): Promise<boolean>;
  stopRun(runId: string, by: 'user' | 'system'): Promise<boolean>;
  recover(): Promise<void>;
  idle(): Promise<void>;
  shutdown(timeoutMs: number): Promise<void>;
  /**
   * WP0 addition (§5.9 forget rotation): sets rotate_pending=reason and schedules `epoch_rotate`. `excludeTexts`
   * (the forgotten fact texts) are held in memory only — never persisted, never in a job payload — and passed to the
   * handoff regeneration as texts to exclude. After a restart they are gone, so the rotation falls back to the
   * deterministic seed, which contains no model text.
   */
  requestRotation(conversationId: string, reason: EpochReason, o?: { excludeTexts?: string[] }): void;
}

/**
 * 03 R3 use_toolkit state (WP3: agent/…, table `conversation_toolkits` + the per-conversation user-turn counter in
 * `conversation_turns`). `use_toolkit`'s execute (WP5, tools/impl/useToolkit.ts) calls `s.toolkits.load`.
 */
export interface ToolkitState {
  /** Upserts (conversation, kit) with expires_after_turn = userTurn(conversation) + 6. */
  load(conversationId: string, kit: Exclude<ToolkitId, 'core'>): { expiresAfterTurn: number };
  /** 'core' plus every kit whose expires_after_turn ≥ userTurn(conversation). Preloads (03 R3) are the request builder's job. */
  active(conversationId: string): ToolkitId[];
  /** Number of user_input runs started in the conversation (incremented by WP3 when a run consumes owner input). */
  userTurn(conversationId: string): number;
}
/**
 * 'user_model' (friend-mode addition, spec 05 A4/B3/C3): facts about the owner — the profile card head, the top retrieved
 * facts and one style-hint line. agent/context.ts renders these lines inside a <user_model> block (a reserved tag, so
 * owner text cannot forge it); the prompts say it is data about the owner, not instructions. Private surfaces only.
 */
export interface ContextPart { key: 'profile' | 'capabilities' | 'memories' | 'open' | 'events' | 'budget' | 'onboarding' | 'surface' | 'location' | 'quota' | 'group' | 'mission' | 'user_model'; lines: string[] }
export interface ContextProvider { name: string; surfaces: readonly Surface[]; parts(conv: ConversationRow, run: RunRow, query: string): Promise<ContextPart[]> }
export interface Triage {
  needs_reply: boolean; urgency: number /*0..3*/; summary: string; category: 'question' | 'request' | 'info' | 'social' | 'spam' | 'other';
  /** source_message_id (review F5): the transcript '#<id>' of the message holding the promise; null/absent when unsure. */
  commitment: { direction: 'i_owe' | 'they_owe'; text: string; due_local: string | null; source_message_id?: number | null } | null;
}
/** WP0 addition: optional last parameter of every SideCalls method (usage attribution + 03 R6 priority, default 'background'). */
/** `signal` (review X1/F6): a job's lease loss or timeout aborts the side call's LLM request. */
export type SideCallMeta = CallMeta & { priority?: Priority; signal?: AbortSignal };
export interface SideCalls {
  triage(i: { transcript: string; peerName: string; nowLocal: string; lang: string }, meta?: SideCallMeta): Promise<Triage | null>;
  extract(i: { inputs: Array<{ id: string; text: string }>; existing: Array<{ id: string; text: string }>; nowLocal: string; lang: string }, meta?: SideCallMeta): Promise<Extracted | null>;
  importFacts(text: string, lang: string, meta?: SideCallMeta): Promise<Array<{ text: string; kind: FactKind; sensitivity: 'normal' | 'sensitive' }>>;
  topicTitle(firstMessage: string, lang: string, meta?: SideCallMeta): Promise<string | null>;
  semanticCheck(description: string, before: string, after: string, meta?: SideCallMeta): Promise<{ met: boolean; summary: string } | null>;
  /**
   * Friend-mode addition: a structured call whose prompt and schema belong to the caller (src/memory/ 'consolidate',
   * src/behaviour/ 'compose' + 'judge'). Records usage (llm_calls purpose 'side') with `meta` like every side call;
   * null on a parse failure; TransientLlmError / AbortedError propagate. Priority defaults to 'background'.
   */
  structured<T>(req: { purpose: 'consolidate' | 'compose' | 'judge'; system: string; user: string; schema: ZodType<T>; role?: 'fast' | 'main'; maxTokens?: number }, meta?: SideCallMeta): Promise<T | null>;
}
