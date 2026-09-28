// ── contracts/llm.ts (WP0, frozen) — 01 §4.4 + 03 R1/R2/R6/R7
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type Groq from 'groq-sdk';
import type { ZodType } from 'zod';
import type { UserId } from './common.ts';

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam; // role 'user'|'assistant'|'system', clear_at typed in 0.128.0
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
export type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
export type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
export type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type BetaStopReason = Anthropic.Beta.Messages.BetaStopReason;
export type BetaUsage = Anthropic.Beta.Messages.BetaUsage;
export type MainRequest = MessageCreateParamsBase; // includes betas, fallbacks ('default' typed), context_management, cache_control, metadata

/** 03 R6: every transport or capability call carries a priority. */
export type Priority = 'interactive' | 'approval' | 'reminder' | 'background' | 'proactive';
export const PRIORITY_ORDER: readonly Priority[] = ['interactive', 'approval', 'reminder', 'background', 'proactive'];

/** 03 R2: budget-aware request building. */
export interface ProviderProfile {
  /** 'anthropic' | 'groq-free' | 'groq-dev' (extra field, WP0: which PROVIDER_PROFILES entry this is). */
  id: 'anthropic' | 'groq-free' | 'groq-dev';
  provider: 'anthropic' | 'groq';
  maxPromptTokens: number; // anthropic 150_000 · groq-free 5_200 · groq-dev 60_000
  maxOutputTokens: number; // anthropic per route · groq 1_200
  /** extra field (WP0): side/parse output cap — anthropic 4_000 · groq 500 */
  sideMaxOutputTokens: number;
  systemVariant: 'full' | 'compact';
  toolMode: 'static' | 'toolkits';
  caching: boolean; // cache_control markers only when true
  epochRotateTokens: number; // anthropic 120_000 · groq-free 2_400 · groq-dev 40_000
  maxToolSteps: number; // anthropic 24 · groq 8
  models: { main: string; fast: string };
}

/** 02 §A roles; the Groq model per role comes from config.groq.models. */
export type GroqRole = 'main' | 'fast' | 'vision' | 'sentinel' | 'guard' | 'stt' | 'tts';
/** The groq-sdk client type. Construct ONLY through kernel/groqClient.ts (03 R6). */
export type GroqClient = Groq;

export interface UsageNumbers { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5m: number; cacheWrite1h: number; webSearchRequests: number; webFetchRequests: number }
export const ZERO_USAGE: Readonly<UsageNumbers> = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearchRequests: 0, webFetchRequests: 0 });

/**
 * onBlockStart special signals (index -1), 03 R1/R6:
 *  - {index:-1, type:'retry'}                  → the channel MUST discard partial draft text (tool_use_failed retry)
 *  - {index:-1, type:'busy', name:'<seconds>'} → the channel shows "⏳ Busy — retrying in Ns"
 */
export interface StreamHandlers { onText(delta: string): void; onBlockStart?(b: { index: number; type: string; name?: string }): void }
export interface StreamResult { message: BetaMessage; requestId: string | null; ttftMs: number | null; latencyMs: number }
/**
 * Attribution for llm_calls rows and per-user usage / cost-cap accounting (WP0 addition). Every side call and every Groq
 * capability call SHOULD carry it when the caller knows it; the implementation records usage against `userId`/`runId`.
 */
export interface CallMeta { userId?: UserId | null; conversationId?: string | null; runId?: string | null }
/**
 * Side-call purposes. 01: triage | extract | import | title | semantic. WP0 additions: 'handoff' (03 R2 Groq handoff note,
 * WP3), 'make_file' (03 R4 csv/md/txt/json → {filename, content}, WP5), 'summarize' (02 §C chunked documents, WP5/WP3).
 * ScriptedTransport.pushParse is keyed by this value, so every distinct call site gets its own purpose.
 */
export type SidePurpose = 'triage' | 'extract' | 'import' | 'title' | 'semantic' | 'handoff' | 'make_file' | 'summarize'
  // friend-mode additions (spec 05): B4 profile card (fast), C4 proactive message (main) and its friend check (fast)
  | 'consolidate' | 'compose' | 'judge';
/**
 * `role` (friend-mode addition): which model answers — 'fast' (default: the side model; Groq models.fast) or 'main'
 * (Anthropic profile.models.main; Groq models.main). Only C4 composition asks for 'main'.
 */
export interface SideRequest<T> { purpose: SidePurpose; system: string; user: string; schema: ZodType<T>; maxTokens?: number; meta?: CallMeta; role?: 'fast' | 'main' }
export interface SideResult<T> { parsed: T | null; stopReason: string | null; usage: UsageNumbers; requestId: string | null }
/** 03 R6/R7: optional per-call options. `priority` defaults to 'interactive' for stream/create and 'background' for parse. */
export interface TransportOpts {
  priority?: Priority;
  /**
   * Integration addition (privacy, 03 R1 caches): the DEK that text derived from this request's media (Groq vision
   * descriptions, PDF text in kv `vision:`/`pdf:`) is sealed under — the conversation's epoch DEK, so shredding the epoch
   * or deleting the user makes the cache unreadable. Without it, derived media text is not cached.
   */
  dek?: string;
}

export interface LlmTransport {
  readonly mode: 'anthropic' | 'groq' | 'demo' | 'scripted';
  stream(req: MainRequest, h: StreamHandlers, signal: AbortSignal, opts?: TransportOpts): Promise<StreamResult>; // client.beta.messages.stream + finalMessage()
  create(req: MainRequest, signal?: AbortSignal, opts?: TransportOpts): Promise<StreamResult>; // non-streaming; make_file only (max_tokens ≤ 16000); on Groq = stream() without handlers
  parse<T>(req: SideRequest<T>, signal?: AbortSignal, opts?: TransportOpts): Promise<SideResult<T>>; // client.messages.parse + zodOutputFormat; SIDE_MODEL; effort low; adaptive thinking. Groq: json_schema strict (R1)
  files: {
    upload(bytes: Uint8Array, filename: string, mime: string): Promise<string>;
    download(fileId: string): Promise<{ bytes: Uint8Array; filename: string; mime: string }>;
    delete(fileId: string): Promise<void>;
  }; // stable client.files.*; on Groq an in-process no-op store
}
// transport.ts maps SDK errors (checking APIConnectionError before APIError) to kernel/errors.ts:
// AbortedError (APIUserAbortError), TransientLlmError{kind:'rate_limit'|'overloaded'|'server'|'connection'},
// BadRequestLlmError{requestId,message,code?}, JsonInputError (eager-input partial-JSON failure).

/**
 * 03 R6: per-model rate governor (implemented by WP3 in agent/groq/rate.ts; a pass-through for Anthropic).
 * Shared by the Groq transport and the Groq capabilities (search, vision, guard, sentinel, stt, tts).
 */
export interface RateGovernor {
  /** Waits (or falls back to another model of the same role's chain) until the call fits; throws TransientLlmError('rate_limit') when it cannot. */
  acquire(q: { role: GroqRole; model: string; estTokens: number; priority: Priority; signal?: AbortSignal; onBusy?: (waitSec: number) => void }): Promise<{ model: string }>;
  /** Feed response headers (x-ratelimit-*) / status / usage back into the buckets and the daily counters. */
  observe(model: string, o: { headers?: Headers | Record<string, string | undefined> | null; status?: number; usage?: { promptTokens: number; completionTokens: number } }): void;
}
