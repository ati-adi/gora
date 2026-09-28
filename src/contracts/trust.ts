// ── contracts/trust.ts (WP0, frozen) — 01 §4.4
import type { Ms, PermissionLevel, Surface, TaintSource, UserId } from './common.ts';
import type { BetaToolResultBlockParam, BetaToolUseBlock, Priority } from './llm.ts';
import type { ConversationRow, RunRow } from './storage.ts';
import type { ApprovalDiff, Classification, Effect, Target, ToolCtx, ToolSpec } from './tools.ts';
import type { QuotaKind } from './billing.ts';
import type { ReplyChannel } from './telegram.ts';

export interface ProposedAction { toolName: string; toolUseId: string; cls: Classification; targets: Target[]; surface: Surface; phase: 'propose' | 'execute'; approvedPendingActionId?: string }
export interface GrantView { id: string; toolName: string; targetHmac: string; scope: '24h' | 'always'; expiresAt: Ms | null }
export interface SentinelSnapshot {
  userStatus: 'active' | 'paused'; memoryConsent: boolean; incognito: boolean; tzConfirmed: boolean;
  permissions: Record<'gmail' | 'gcal', PermissionLevel>; connected: Record<'gmail' | 'gcal', boolean>;
  grants: readonly GrantView[]; trustedTargetHmacs: ReadonlySet<string>; taint: ReadonlySet<TaintSource>;
  quotaOk: (k: QuotaKind) => boolean;
  business: { consented: boolean; enabled: boolean; canReply: boolean; windowOpen: boolean } | null;
  now: Ms;
}
export type Decision =
  | { kind: 'allow'; ruleId: string; reason: string; grantId?: string; undo: boolean }
  | { kind: 'deny'; ruleId: string; reason: string; code: 'paused' | 'surface' | 'not_connected' | 'permission' | 'forbidden_v1' | 'quota' | 'business' | 'memory_off' | 'tz_unconfirmed' }
  | { kind: 'ask'; ruleId: string; reason: string; grantable: boolean; warnings: string[] };
export interface SentinelDecisionView {
  toolUseId: string | null; toolName: string; decision: 'allow' | 'deny' | 'ask'; ruleId: string; reason: string;
  phase: 'propose' | 'execute'; tainted: boolean; createdAt: Ms;
}
export interface Sentinel {
  evaluate(a: ProposedAction, s: SentinelSnapshot): Decision; /* pure */
  snapshot(userId: UserId | null, run: RunRow | null, a: ProposedAction): SentinelSnapshot;
  /** WP0 addition (/why, F8): the sentinel_decisions rows of a run, oldest first. */
  decisionsFor(runId: string): SentinelDecisionView[];
}
/**
 * `effects` (WP0 addition): every Effect of the round's executed tools — `ctx.effects.push(...)`, `ToolOutput.effects`
 * and the executor's own effect lines (Undo) — in tool_use order. The engine accumulates them for `ch.finalize`.
 */
export interface RoundOutcome { results: BetaToolResultBlockParam[]; park: { wakeOn: string[]; wakeAt: Ms | null } | null; taintAdded: TaintSource[]; effects: Effect[] }
export interface ToolExecutor {
  processRound(run: RunRow, conv: ConversationRow, assistantSeq: number, uses: BetaToolUseBlock[], ch: ReplyChannel, signal: AbortSignal): Promise<RoundOutcome>;
  finishInterruptedRound(run: RunRow, conv: ConversationRow, assistantSeq: number): Promise<RoundOutcome>; // crash recovery
  cancelUnstarted(runId: string, assistantSeq: number): BetaToolResultBlockParam[]; // Stop
  executeApproved(pendingActionId: string): Promise<{ status: 'executed' | 'superseded' | 'denied_by_policy' | 'failed' | 'unknown'; summary: string }>;
}
/**
 * WP0 additions: `runId` / `conversationId` (finalize's "pending approvals from this run" footer, /why) and `targets`
 * (display form + provenance; step-up's phrase is 'ALWAYS <FIRST WORD OF targets[0].display>' → StepUpService.verifyPhrase `expected`).
 */
export interface PendingActionView {
  id: string; toolName: string; title: string; summary: string; rows: Array<[string, string]>; body?: { label: string; text: string };
  warnings: string[]; status: string; expiresAt: Ms; grantable: boolean; ladderOffer: boolean; editableFields: string[];
  runId: string | null; conversationId: string | null;
  targets: Array<{ kind: Target['kind']; display: string; provenance: Target['provenance'] }>;
  /** Integration addition (WP7b request): where the Telegram card is, so its owner WP can edit it in place (e.g. ⌛ window closed). */
  card?: { chatId: number; threadId: number | null; messageId: number | null };
}
export interface ApprovalService {
  create(p: { run: RunRow; conv: ConversationRow; toolUseId: string; spec: ToolSpec; input: unknown; cls: Classification; diff: ApprovalDiff; decision: Extract<Decision, { kind: 'ask' }>; expiresAt: Ms; card: { chatId: number; threadId?: number }; sourceRefs?: string[] }): Promise<{ id: string }>;
  resolve(id: string, d: { decision: 'approve' | 'deny'; scope: 'once' | '24h'; byTgId: number; via: 'callback' | 'miniapp'; editedInput?: unknown }): Promise<{ status: string; message: string }>;
  revise(id: string, newInput: unknown, ctx: ToolCtx): Promise<{ newId: string } | { error: string }>;
  expireDue(now: Ms): Promise<number>;
  voidBySourceRef(ref: string, reason: string): Promise<number>;
  listPending(userId: UserId): PendingActionView[];
  /** WP0 addition (GET /api/approvals/:id): any status; undefined when missing or owned by another user. */
  get(id: string, userId: UserId): PendingActionView | undefined;
  /**
   * WP0 addition (§11.3 item 6): a typed "yes"/"approve" never resolves anything. WP7's DM handler calls this instead:
   * it replies "Tap the button on the card" (strings 'tap_the_card') and re-sends the user's pending cards into `chat`
   * (newest first, at most 3). Returns the number of cards re-shown (0 → the caller treats the text as normal input).
   */
  reshowPending(userId: UserId, chat: { chatId: number; threadId?: number }): Promise<number>;
}
export interface UndoService {
  issue(p: { userId: UserId; toolUseId: string; toolName: string; payload: unknown; ttlMs: number }): string;
  undo(id: string, byTgId: number): Promise<{ ok: boolean; message: string }>;
}
export interface StepUpService {
  enroll(userId: UserId): { token: string };
  verifyBiometric(userId: UserId, token: string): { grantId: string } | null;
  /** `pendingActionId` (TRUST-11): binds a phrase grant to that exact action, not only to its phrase. */
  verifyPhrase(userId: UserId, typed: string, expected: string, initDataAgeMs: number, pendingActionId?: string): { grantId: string } | null;
  /** Phrase grants need the phrase (and, when minted with one, the pendingActionId) of the action they are spent on. */
  consume(userId: UserId, grantId: string, expectedPhrase?: string, pendingActionId?: string): boolean;
}

// ── WP0 additions: untrusted wrapping (01 §11.3, 03 R5), grants and trusted targets (§11.1, §11.2, §12)

/** Wrapper sources: every taint source plus 'guest_reply' (the replied-to text of a guest summon; it taints as 'guest'). */
export type UntrustedSource = TaintSource | 'guest_reply';
/**
 * trust/untrusted.ts (WP4). The ONLY way third-party text reaches the model: redaction (§11.6), reserved-tag
 * neutralization (kernel/tags.ts) and PromptGuard (03 R5: ≥0.9 → chunk replaced by '[removed: likely prompt injection]'
 * + ledger 'guard_block' when userId is known; ≥0.5 → suspicious="true"; guard unavailable → passes).
 * Callers outside WP4: WP3 (InputRow.untrusted=true inputs and GoraEvent.untrusted parts when it builds rows),
 * WP5 (tool outputs are wrapped by the executor, not by the tool), WP7 (business transcripts in draft events,
 * guest replied-to text, group reply targets, forwards).
 */
export interface UntrustedWrapper {
  wrap(p: { source: UntrustedSource; label: string; text: string; userId?: UserId | null; runId?: string | null; priority?: Priority }): Promise<{
    /** '<untrusted source="…" label="…"[ suspicious="true"]>…</untrusted>' */
    text: string;
    suspicious: boolean;
    removedChunks: number;
  }>;
  /** Redaction only (§11.6), e.g. for text shown back to the owner. */
  redact(text: string): string;
}

/** grants (WP4). Used by the Mini App (WP8: GET/DELETE/POST /api/grants). */
export interface GrantService {
  list(userId: UserId): GrantView[];
  revoke(userId: UserId, grantId: string): boolean;
  /** POST /api/grants: consumes the step-up grant, re-checks S16 eligibility for the pending action's (tool, targets). */
  createAlways(userId: UserId, pendingActionId: string, stepupGrantId: string): Promise<{ id: string } | { error: 'not_eligible' | 'stepup_invalid' | 'not_found' }>;
}

export type TrustedTargetSource = 'user_message' | 'memory' | 'approved_action' | 'miniapp' | 'business_chat';
/**
 * trusted_targets (WP4, §11.2). Writers outside WP4: WP6 (memory facts, source 'memory'), WP7 (consented business
 * chats, 'business_chat'), WP8 (Mini App entries, 'miniapp'). 'approved_action' is written only by WP4 itself.
 * WP6's inbox_important signal uses `isTrusted` for "trusted sender".
 */
export interface TrustedTargetService {
  list(userId: UserId): Array<{ hmac: string; kind: Target['kind']; value: string; source: TrustedTargetSource; createdAt: Ms }>;
  add(userId: UserId, t: { kind: Target['kind']; value: string; source: Exclude<TrustedTargetSource, 'approved_action'>; sourceRef?: string }): void;
  remove(userId: UserId, hmac: string): boolean;
  isTrusted(userId: UserId, kind: Target['kind'], value: string): boolean;
}
