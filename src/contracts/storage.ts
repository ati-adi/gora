// ── contracts/storage.ts (WP0, frozen) — 01 §4.4 + 03 R7
import type { DatabaseSync } from 'node:sqlite';
import type { ChannelKind, Ms, PermissionLevel, PlanId, Route, TaintSource, ToolsetId, UserId } from './common.ts';
import type { BetaContentBlockParam, BetaMessageParam, Priority, UsageNumbers } from './llm.ts';
import type { StyleOverrides } from './behaviour.ts';

export type SqlValue = null | number | bigint | string | Uint8Array;
export interface Stmt {
  run(...p: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = Record<string, SqlValue>>(...p: SqlValue[]): T | undefined;
  all<T = Record<string, SqlValue>>(...p: SqlValue[]): T[];
}
/** Named-parameter variants (`:name`) are available through `db.raw.prepare(sql)` directly. */
export interface Db {
  readonly raw: DatabaseSync;
  prepare(sql: string): Stmt; /* cached */
  exec(sql: string): void;
  tx<T>(fn: () => T): T; /* BEGIN IMMEDIATE; nested → SAVEPOINT; fn MUST be sync (a returned Promise rolls back and throws) */
  close(): void;
}

/** DEK ids: 'u:<userId>' | 'm:<userId>:<gen>' | 'e:<conversationId>:<epoch>' | 'g:<chatId>' | 'mg:<chatId>:<gen>' | 'b:<connectionId>' | 'sys' */
export type DekId = string;

/**
 * keys.db wrapper (db/keystore.ts, WP1). Not spelled out in 01; WP0 defines the minimum Crypto needs.
 * DEKs are 32 random bytes wrapped with the KEK (AES-256-GCM) and cached unwrapped in an LRU (10k, 10 min).
 */
export interface KeyStore {
  readonly path: string;
  readonly kekVersion: number;
  /** Returns the unwrapped DEK, creating it lazily. Throws DekDestroyedError when it was destroyed (never re-created). */
  getOrCreate(id: DekId, owner: string, purpose: string): Uint8Array;
  /** Returns the unwrapped DEK or undefined when it never existed. Throws DekDestroyedError when destroyed. */
  get(id: DekId): Uint8Array | undefined;
  destroy(id: DekId): void;
  destroyOwner(owner: string): number;
  isDestroyed(id: DekId): boolean;
  /** Re-wraps every live DEK under a new KEK (scripts/admin.ts rewrap). Returns the number re-wrapped. */
  rewrap(newKek: Uint8Array, newVersion: number): number;
  /** WP0 addition (§11.7 nightly backup, job 'backup'): online copy of keys.db to `destPath` (node:sqlite backup()). */
  backup(destPath: string): Promise<void>;
  close(): void;
}

/**
 * DEK owners (the `owner` column of keys.db, used by destroyOwner): '<userId>' for u:/m: DEKs and for the epoch DEKs of
 * that user's conversations; 'grp:<chatId>' for g:/mg: DEKs and group conversations; 'biz:<connId>' for b: DEKs;
 * 'guest' for guest conversations; 'sys' for 'sys'. seal() derives the owner from the id when it creates a DEK lazily,
 * which is impossible for 'e:<conversationId>:<epoch>' — so epoch DEKs MUST be created with ensureDek() first
 * (WP1: ConversationsRepo.create and startEpoch call ensureDek(e:<id>:<n>, conv.userId ?? 'guest' | 'grp:<chatId>', 'epoch')).
 */
export interface Crypto {
  seal(dek: DekId, plaintext: Uint8Array | string, aad: string): Uint8Array; // creates the DEK lazily; throws DekDestroyedError if destroyed
  open(ct: Uint8Array, aad: string): Uint8Array; // DEK id is inside the envelope
  openText(ct: Uint8Array, aad: string): string;
  sealJson(dek: DekId, v: unknown, aad: string): Uint8Array;
  openJson<T>(ct: Uint8Array, aad: string): T;
  hmac(domain: string, data: string | Uint8Array): string; // hex HMAC-SHA256 under GORA_HASH_KEY, domain-separated
  destroyDek(dek: DekId): void;
  destroyOwner(owner: string): number; // owner = userId | 'grp:<chatId>' | 'biz:<connId>' | 'guest'
  isDestroyed(dek: DekId): boolean;
  /** WP0 addition: creates the DEK with this owner if missing (idempotent; an existing DEK keeps its owner). Throws DekDestroyedError if destroyed. */
  ensureDek(dek: DekId, owner: string, purpose: string): void;
}
// AAD convention: '<table>|<column>|<row key>' (e.g. 'messages|content_enc|<conv>:<epoch>:<seq>')
// HMAC domains (01 §11.7): 'content' | 'target' | 'fp' | 'ledger' | 'chat_ref' | 'anthropic-user' (+ 'diff', 'input' used by WP4)

export type OnboardingStep = 'consent' | 'tz' | 'first_task' | 'name' | 'import' | 'connect' | 'brief' | 'hooks' | 'done';
export type ConsentKind = 'terms' | 'memory' | 'business_llm' | 'business_llm_new_chats' | 'import' | 'location' | 'inbox_checkins';
export interface UserRow {
  id: UserId; tgUserId: number; dmChatId: number | null; firstName: string | null; username: string | null; languageCode: string | null;
  tz: string; tzSource: 'miniapp' | 'location' | 'city' | 'manual' | 'default';
  personaName: string; personaStyle: 'friendly' | 'concise' | 'professional' | 'coach';
  plan: PlanId; status: 'active' | 'paused' | 'blocked' | 'deleting';
  memoryConsent: boolean | null; incognitoUntil: Ms | null; memoryGen: number; onboardingStep: OnboardingStep; botBlocked: boolean;
  /** 03 R4/R7: users.voice_replies */
  voiceReplies: boolean;
  /** Friend-mode additions (003): users.proactive_level (C5, default 'normal') and users.tz_hint_at (A6 lazy tz button, last shown). */
  proactiveLevel: 'off' | 'less' | 'normal' | 'more';
  tzHintAt: Ms | null;
  createdAt: Ms;
  /** users.last_seen_at (any update from the user). Optional so hand-built rows in tests stay valid. */
  lastSeenAt?: Ms | null;
}
/**
 * `homeCity` (WP0 addition, DDL user_settings.home_city_enc = sealed JSON under 'u:<userId>'): the owner's city for
 * weather_get without a place and the brief's weather line. Written by WP7 (typed city at onboarding / tz card, /settings)
 * and WP8 (Mini App Settings) through updateSettings; null when unknown.
 */
export interface HomeCity { name: string; lat: number; lon: number }
/** `style` (friend-mode addition, 003 user_settings.style_json): explicit style overrides set by words (C5); null = learned only. */
export interface UserSettings { nudgeBudget: number; quietStart: string; quietEnd: string; briefTime: string | null; inboxCheckins: boolean; approvalExpiryMin: number; showTranscripts: boolean; homeCity: HomeCity | null; style: StyleOverrides | null }
export interface UsersRepo {
  getById(id: UserId): UserRow | undefined;
  getByTg(tgUserId: number): UserRow | undefined;
  upsertFromTelegram(u: { id: number; first_name: string; username?: string; language_code?: string }, o?: { dmChatId?: number; refSource?: string }): UserRow;
  update(id: UserId, patch: Partial<Omit<UserRow, 'id' | 'tgUserId' | 'createdAt'>>): void;
  settings(id: UserId): UserSettings;
  updateSettings(id: UserId, patch: Partial<UserSettings>): void;
  grantConsent(c: { userId: UserId; kind: ConsentKind; subject?: string; textVersion: string; via: 'callback' | 'miniapp' | 'command' | 'blanket' }): string;
  revokeConsent(userId: UserId, kind: ConsentKind, subject?: string): void;
  hasConsent(userId: UserId, kind: ConsentKind, subject?: string): boolean;
  permissions(userId: UserId): Record<'gmail' | 'gcal', PermissionLevel>;
  setPermission(userId: UserId, integration: 'gmail' | 'gcal', level: PermissionLevel, via: 'miniapp' | 'callback' | 'system'): void;
  // ── WP0 additions (proactive_scan per user, admin stats, retention): keyset pagination by id (ULID order)
  /** Users with id > afterId (all when omitted), ascending id, at most `limit`; optionally filtered by status. */
  list(q: { status?: UserRow['status']; afterId?: UserId; limit: number }): UserRow[];
  /** Iterates every user (optionally one status) in pages of `batchSize` (default 200) through list(); safe to write between items. */
  iterate(q?: { status?: UserRow['status']; batchSize?: number }): Iterable<UserRow>;
}

/** 'user_new' (WP0 addition): plain `/new` — a fresh epoch without forgetting (`/new wipe` uses 'wipe'). */
export type EpochReason = 'initial' | 'idle' | 'size' | 'forget' | 'upgrade' | 'model_switch' | 'context_exceeded' | 'incognito_start' | 'incognito_end' | 'wipe' | 'system_role_unsupported' | 'user_new';
/** ConversationRow.model holds the Claude model id or 'groq:<model>' (03 R2). */
export interface ConversationRow {
  id: string; scopeKey: string; kind: 'dm' | 'topic' | 'mission' | 'group' | 'guest' | 'biz_draft';
  userId: UserId | null; tgChatId: number | null; threadId: number | null; businessConnectionId: string | null;
  route: Route; model: string; effort: 'low' | 'medium' | 'high'; toolset: ToolsetId; toolsHash: string; systemVersion: string; betas: string[];
  contextMode: 'system' | 'inline'; epoch: number; rotatePending: string | null; activeRunId: string | null; singleShot: boolean;
  status: 'active' | 'closed' | 'purged'; createdAt: Ms; lastActivityAt: Ms;
}
export interface EpochRow {
  conversationId: string; epoch: number; dekId: DekId; reason: EpochReason; seedKind: 'none' | 'handoff' | 'deterministic';
  handoffSummary: string | null; handoffMadeAt: Ms | null; taint: TaintSource[]; inputTokensLast: number; lastRequestAt: Ms | null;
  nextSeq: number; startedAt: Ms; closedAt: Ms | null; shreddedAt: Ms | null;
}
export type MessageKind = 'user_input' | 'event' | 'seed' | 'context' | 'assistant' | 'tool_results' | 'synthetic';
export interface MessageRow { conversationId: string; epoch: number; seq: number; role: 'user' | 'assistant' | 'system'; kind: MessageKind; content: BetaMessageParam; runId: string | null; stopReason: string | null; hasClientToolUse: boolean; createdAt: Ms }
export interface ConversationsRepo {
  get(id: string): ConversationRow | undefined;
  byScopeKey(scopeKey: string): ConversationRow | undefined;
  create(c: Pick<ConversationRow, 'scopeKey' | 'kind' | 'userId' | 'tgChatId' | 'threadId' | 'businessConnectionId' | 'route' | 'model' | 'effort' | 'toolset' | 'toolsHash' | 'systemVersion' | 'betas' | 'contextMode' | 'singleShot'>): ConversationRow; // also creates epoch 1 with DEK e:<id>:1
  update(id: string, patch: Partial<Pick<ConversationRow, 'rotatePending' | 'status' | 'lastActivityAt' | 'contextMode' | 'model' | 'effort' | 'toolset' | 'toolsHash' | 'systemVersion' | 'betas'>>): void;
  casActiveRun(id: string, expected: string | null, next: string | null): boolean;
  currentEpoch(id: string): EpochRow;
  getEpoch(id: string, epoch: number): EpochRow | undefined;
  startEpoch(id: string, reason: EpochReason, seedKind: EpochRow['seedKind'], taint: TaintSource[]): EpochRow; // closes the previous epoch; new DEK
  updateEpoch(id: string, epoch: number, patch: Partial<Pick<EpochRow, 'handoffSummary' | 'handoffMadeAt' | 'taint' | 'inputTokensLast' | 'lastRequestAt'>>): void;
  closedEpochsOlderThan(ms: Ms): Array<{ conversationId: string; epoch: number }>;
  /** WP0 addition (Mini App "Forget everything from a chat"): the user's conversations, newest activity first (default limit 50). */
  listByUser(userId: UserId, o?: { status?: ConversationRow['status']; limit?: number }): ConversationRow[];
  /**
   * s07 lead addition (spec 07 C3 retention / "/forget всё"): the conversations of one Telegram chat (every forum
   * thread), optionally of one kind, newest activity first.
   */
  listByChat(tgChatId: number, o?: { kind?: ConversationRow['kind']; status?: ConversationRow['status']; limit?: number }): ConversationRow[];
}
export interface MessagesRepo {
  append(conversationId: string, epoch: number, rows: Array<{ role: MessageRow['role']; kind: MessageKind; content: BetaMessageParam; runId?: string; stopReason?: string; hasClientToolUse?: boolean }>): number[]; // one tx; runs the injected grammar validator; returns seqs
  load(conversationId: string, epoch: number): MessageRow[];
  last(conversationId: string, epoch: number): MessageRow | undefined;
  setValidator(v: (existing: MessageRow[], added: Array<{ role: string; kind: MessageKind; content: BetaMessageParam }>) => void): void;
  putBlob(b: { ownerUserId: UserId | null; dek: DekId; mime: string; bytes: Uint8Array }): string; // 'b_<ulid>'
  getBlob(id: string): { mime: string; bytes: Uint8Array } | undefined;
  refBlobs(conversationId: string, epoch: number, blobIds: string[]): void;
}
export type InputKind = 'text' | 'voice' | 'photo' | 'document' | 'forward' | 'location' | 'choice' | 'command' | 'event' | 'guest' | 'member';
/**
 * `untrusted=true` inputs hold RAW third-party text; WP3 wraps them with `s.untrusted.wrap()` (WP4) when it builds the
 * user row. `tgUpdateId` (WP0 addition, DDL column tg_update_id) makes ingest idempotent across re-delivery.
 */
export interface InputRow {
  id: string; conversationId: string; kind: InputKind; author: 'owner' | 'member' | 'peer' | 'system'; untrusted: boolean; content: BetaContentBlockParam[];
  tgUpdateId: number | null; tgChatId: number | null; tgMessageId: number | null; fromTgUserId: number | null; replyToCardId: string | null; createdAt: Ms; consumedRunId: string | null; consumedEpoch: number | null;
}
export interface InputsRepo {
  /**
   * Idempotent per (conversationId, tgUpdateId, untrusted) when tgUpdateId is non-null (UNIQUE index inputs_update):
   * a duplicate inserts nothing and returns the existing row's id. One update may yield one trusted and one untrusted input
   * (e.g. /start g_<token>: the summon text as owner input plus the replied-to text as untrusted input).
   */
  add(i: Omit<InputRow, 'id' | 'createdAt' | 'consumedRunId' | 'consumedEpoch'>): string;
  pending(conversationId: string): InputRow[];
  // ── WP0 additions (§10.1 edits, §9 forget step 4, make_file attachments, 03 R4 voice replies)
  get(id: string): InputRow | undefined;
  byTgMessage(conversationId: string, tgChatId: number, tgMessageId: number): InputRow | undefined;
  /** edited_message: replaces the content of a still-unconsumed input; false once it was consumed (or is missing). */
  replaceUnconsumed(id: string, content: BetaContentBlockParam[]): boolean;
  delete(id: string): void;
  /** The inputs a run consumed (e.g. did this DM run start from a voice input?). */
  consumedBy(runId: string): InputRow[];
  markConsumed(ids: string[], runId: string, epoch: number): void;
  ownerAuthoredSince(conversationId: string, sinceMs: Ms): InputRow[]; // author='owner' AND untrusted=0
  deleteConsumedInEpoch(conversationId: string, epoch: number): number;
  addEvent(conversationId: string, text: string): void; // conv_events
  takeEvents(conversationId: string, runId: string): string[];
}
export type RunState = 'queued' | 'running' | 'parked' | 'retry_wait' | 'done' | 'refused' | 'failed' | 'cancelled';
export type RunTrigger = 'user_input' | 'event' | 'wake' | 'mission_start' | 'guest' | 'group' | 'biz_draft' | 'continue' | 'resume';
/**
 * `continueUrl` (WP0 addition): the guest channel's '🔒 Continue privately' url (https://t.me/<bot>?start=g_<token>).
 * WP7 creates the deep-link token at guest ingest and passes the replyRef via `runner.kick(conv, {replyRef})`.
 */
export interface ReplyRef { chatId: number; threadId?: number; triggerMessageId?: number; guestQueryId?: string; inlineMessageId?: string; placeholderMessageId?: number; businessConnectionId?: string; missionId?: string; continueUrl?: string }
export interface RunRow {
  id: string; conversationId: string; userId: UserId | null; epoch: number; trigger: RunTrigger; triggerRef: string | null; state: RunState;
  /** 03 R6 (WP0 addition, runs.priority): the priority of every transport call this run makes. */
  priority: Priority;
  phase: 'start' | 'model' | 'tools' | 'finalize'; channel: ChannelKind; replyRef: ReplyRef; draftId: number | null; wakeOn: string[]; wakeAt: Ms | null; notBefore: Ms | null;
  turns: number; continuations: number; maxTokens: number; retries: number; taint: TaintSource[]; costMicros: number; error: string | null; leaseUntil: Ms | null; createdAt: Ms;
  /**
   * WP0 additions (DDL runs.visible_text_enc / stop_category), both set through RunsRepo.update:
   *  - visibleText: what the channel had shown when the run parked/stopped/failed (sealed under the epoch DEK), used by
   *    recovery (§5.11) and the Stop path; null otherwise.
   *  - stopCategory: refusal category (stop_details.category) or the terminal reason ('user_stop', 'too_long', 'quota', …).
   */
  visibleText: string | null; stopCategory: string | null;
}
export type ToolCallStatus = 'staged' | 'executing' | 'done' | 'error' | 'denied' | 'pending_approval' | 'waiting' | 'cancelled' | 'unknown' | 'executed_after_approval' | 'declined_after_approval' | 'expired';
export interface ToolCallRow {
  toolUseId: string; runId: string; conversationId: string; epoch: number; userId: UserId | null; assistantSeq: number; ordinal: number; name: string;
  actionClass: string | null; risk: number | null; input: unknown; decision: 'allow' | 'deny' | 'ask' | null; ruleId: string | null; status: ToolCallStatus;
  pendingActionId: string | null; result: unknown; isError: boolean;
}
/** purpose extended by WP0 for the Groq sub-calls (03 R6 "every Groq call records usage"). */
export type LlmCallPurpose = 'main' | 'handoff' | 'side' | 'make_file' | 'search' | 'vision' | 'guard' | 'sentinel' | 'stt' | 'tts';
export interface LlmCallRecord {
  runId: string | null; conversationId: string | null; epoch: number | null; userId: UserId | null; purpose: LlmCallPurpose;
  requestHmac: string; modelRequested: string; modelServed: string | null; servedByFallback: boolean; stopReason: string | null; refusalCategory: string | null;
  usage: UsageNumbers; iterations: unknown; costMicros: number; latencyMs: number | null; ttftMs: number | null; requestId: string | null; errorClass: string | null; raw: unknown | null;
}
export interface RunsRepo {
  create(r: Pick<RunRow, 'conversationId' | 'userId' | 'epoch' | 'trigger' | 'triggerRef' | 'channel' | 'replyRef' | 'maxTokens'> & { taint?: TaintSource[]; notBefore?: Ms; priority?: Priority /* default 'interactive' */ }): RunRow;
  get(id: string): RunRow | undefined;
  claim(id: string, leaseMs: number): RunRow | undefined; // CAS queued|retry_wait → running
  renewLease(id: string, leaseMs: number): void;
  update(id: string, patch: Partial<Omit<RunRow, 'id' | 'conversationId' | 'createdAt'>>): void;
  park(id: string, wakeOn: string[], wakeAt: Ms | null): void; // state=parked + run_waits rows
  byWaitToken(token: string): RunRow[]; // 'approval:<id>' | 'watcher:<id>' | 'user_input:<conversationId>' | 'budget:<missionId>'
  clearWaits(id: string): void;
  recoverable(now: Ms): RunRow[]; // running with an expired lease, queued, or retry_wait with notBefore <= now
  /** Queued / retry_wait runs still showing draft `draftId` in chat `chatId`, thread `threadId` (0 = none); indexed on runs.draft_id. */
  byDraft(chatId: number, threadId: number, draftId: number): RunRow[];
  stageToolCalls(rows: Array<Pick<ToolCallRow, 'toolUseId' | 'runId' | 'conversationId' | 'epoch' | 'userId' | 'assistantSeq' | 'ordinal' | 'name' | 'input'>>): void;
  updateToolCall(toolUseId: string, patch: Partial<Omit<ToolCallRow, 'toolUseId'>>): void;
  toolCallsFor(runId: string, assistantSeq?: number): ToolCallRow[];
  recordLlmCall(c: LlmCallRecord): void;
  recordMemoryUses(runId: string, factIds: string[]): void;
  memoryUses(runId: string): Array<{ factId: string; rank: number }>;
  // ── WP0 additions (/why, §9 forget step 5)
  /** llm_calls of a run, oldest first (never the raw payload). */
  llmCallsFor(runId: string): Array<Pick<LlmCallRecord, 'purpose' | 'modelRequested' | 'modelServed' | 'servedByFallback' | 'stopReason' | 'refusalCategory'> & { createdAt: Ms }>;
  /** Reverse lookup over run_memory_uses (index run_memory_uses_fact) joined to runs. */
  conversationsUsingFact(factId: string): Array<{ runId: string; conversationId: string; epoch: number }>;
}
export interface KvRepo { get<T>(key: string): T | undefined; set(key: string, v: unknown): void }
// Reserved kv keys: 'bot_flags', 'commands_hash', 'polling_offset', and (03 R7) 'vision:<sha>', 'pdf:<sha>', 'guard:<sha>'.
export interface CoreRepos { users: UsersRepo; conversations: ConversationsRepo; messages: MessagesRepo; inputs: InputsRepo; runs: RunsRepo; kv: KvRepo }

/** Deletion plan for /deletemydata. WP0 writes the literal from §7.2; WP1 iterates it in order. */
export interface UserDataTable {
  table: string;
  where: string; /* uses :userId / :tgUserId */
  /** 'shred': conversation-derived rows — WP1 inserts shred_tokens for every epoch first (step 3).
   *  'hook':  never DELETEd by WP1; a privacy hook owns it (payments are pseudonymized by WP7). */
  via?: 'shred' | 'hook';
}
const CONVS = `conversation_id IN (SELECT id FROM conversations WHERE user_id = :userId)`;
const USCOPE = `'user:' || :userId`;
export const USER_DATA_TABLES: readonly UserDataTable[] = Object.freeze([
  // step 1 — (users.status='deleting' is set first by WP1) cancel jobs
  { table: 'jobs', where: `user_id = :userId` },
  // step 3 — conversations: shred tokens are inserted first, then transcript rows go
  { table: 'messages', where: CONVS, via: 'shred' },
  { table: 'run_memory_uses', where: `run_id IN (SELECT id FROM runs WHERE ${CONVS} OR user_id = :userId)`, via: 'shred' },
  { table: 'run_waits', where: `run_id IN (SELECT id FROM runs WHERE ${CONVS} OR user_id = :userId)`, via: 'shred' },
  { table: 'tool_calls', where: `${CONVS} OR user_id = :userId`, via: 'shred' },
  { table: 'llm_calls', where: `${CONVS} OR user_id = :userId`, via: 'shred' },
  { table: 'conversation_inputs', where: CONVS, via: 'shred' },
  { table: 'conv_events', where: CONVS, via: 'shred' },
  { table: 'conversation_toolkits', where: CONVS, via: 'shred' },
  { table: 'conversation_turns', where: CONVS, via: 'shred' },
  { table: 'extraction_watermarks', where: CONVS, via: 'shred' },
  { table: 'blob_refs', where: `${CONVS} OR blob_id IN (SELECT id FROM blobs WHERE owner_user_id = :userId)`, via: 'shred' },
  { table: 'runs', where: `${CONVS} OR user_id = :userId`, via: 'shred' },
  { table: 'epochs', where: CONVS, via: 'shred' },
  { table: 'shred_tokens', where: CONVS, via: 'shred' },
  { table: 'conversations', where: `user_id = :userId`, via: 'shred' },
  // step 4 — WP4 tables
  { table: 'pending_actions', where: `user_id = :userId` },
  { table: 'grants', where: `user_id = :userId` },
  { table: 'trusted_targets', where: `user_id = :userId` },
  { table: 'undo_tokens', where: `user_id = :userId` },
  { table: 'stepup_devices', where: `user_id = :userId` },
  { table: 'stepup_grants', where: `user_id = :userId` },
  { table: 'sentinel_decisions', where: `user_id = :userId` },
  // WP5 tables
  { table: 'connections', where: `user_id = :userId` },
  { table: 'oauth_states', where: `user_id = :userId` },
  { table: 'anthropic_files', where: `user_id = :userId` },
  { table: 'location_state', where: `user_id = :userId` },
  // s07 tables (004): CAL pending connect links, BR browser tasks, GR the member's own messages in groups (by Telegram id)
  { table: 'integration_links', where: `user_id = :userId` },
  { table: 'browser_tasks', where: `user_id = :userId` },
  { table: 'group_messages', where: `from_tg_id = :tgUserId` },
  // friend-mode tables (003): memory-derived first (fact_embeddings references memory_facts), then behaviour
  { table: 'fact_embeddings', where: `scope = ${USCOPE} OR user_id = :userId` },
  { table: 'user_profile', where: `user_id = :userId` },
  { table: 'user_signals', where: `user_id = :userId` },
  { table: 'user_rhythm', where: `user_id = :userId` },
  { table: 'proactive_arms', where: `user_id = :userId` },
  { table: 'proactive_log', where: `user_id = :userId` },
  // WP6 tables
  { table: 'memory_facts', where: `scope = ${USCOPE} OR user_id = :userId` },
  { table: 'memory_fingerprints', where: `scope = ${USCOPE}` },
  { table: 'reminders', where: `scope = ${USCOPE} OR user_id = :userId` },
  { table: 'todos', where: `scope = ${USCOPE}` },
  { table: 'todo_messages', where: `scope = ${USCOPE}` },
  { table: 'watchers', where: `user_id = :userId` },
  { table: 'missions', where: `user_id = :userId` },
  { table: 'nudges', where: `user_id = :userId` },
  { table: 'nudge_prefs', where: `user_id = :userId` },
  { table: 'commitments', where: `user_id = :userId` },
  // WP2 tables
  { table: 'topics', where: `user_id = :userId` },
  { table: 'tg_links', where: `user_id = :userId` },
  { table: 'outbox', where: `user_id = :userId` },
  // WP7 tables
  { table: 'business_drafts', where: `connection_id IN (SELECT id FROM business_connections WHERE user_id = :userId)` },
  { table: 'business_messages', where: `connection_id IN (SELECT id FROM business_connections WHERE user_id = :userId)` },
  { table: 'business_chats', where: `connection_id IN (SELECT id FROM business_connections WHERE user_id = :userId)` },
  { table: 'business_connections', where: `user_id = :userId` },
  { table: 'choice_sets', where: `user_id = :userId` },
  { table: 'deeplink_tokens', where: `owner_tg_id = :tgUserId` },
  { table: 'guest_invocations', where: `caller_tg_id = :tgUserId` },
  { table: 'subscriptions', where: `user_id = :userId` },
  { table: 'payments', where: `user_ref = :userId`, via: 'hook' },
  // WP1 tables
  { table: 'blobs', where: `owner_user_id = :userId` },
  { table: 'ledger', where: `user_id = :userId` },
  { table: 'usage_daily', where: `user_id = :userId` },
  { table: 'consents', where: `user_id = :userId` },
  { table: 'permissions', where: `user_id = :userId` },
  { table: 'user_settings', where: `user_id = :userId` },
  // step 6 — last
  { table: 'users', where: `id = :userId` },
] satisfies UserDataTable[]);

/**
 * s07 (spec 07 C3): the per-group deletion plan, keyed by `:chatId`. GroupParticipation.purge iterates it in order for
 * '/forget all' in the group and for the bot-left purge (after the 7-day grace, with destroyOwner('grp:<chatId>')).
 * group_policy is kept on 'forget' (chattiness is a setting, counters are reset) and deleted on 'left'.
 * Group memory facts are not listed: they go through memory.forget (fingerprints) / the grp: DEK destruction.
 */
export interface GroupDataTable { table: string; where: string; /* uses :chatId */ keepOnForget?: boolean }
export const GROUP_DATA_TABLES: readonly GroupDataTable[] = Object.freeze([
  { table: 'group_messages', where: `chat_id = :chatId` },
  { table: 'group_summaries', where: `chat_id = :chatId` },
  { table: 'group_policy', where: `chat_id = :chatId`, keepOnForget: true },
] satisfies GroupDataTable[]);
