// ── contracts/services.ts (WP0, frozen) — 01 §4.4 + 03 R7
import type { Bot, Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Hono } from 'hono';
import type { Config } from '../config.ts';
import type { Clock, Logger, Ms, Random, UserId } from './common.ts';
import type { ConversationRow, CoreRepos, Crypto, Db, KeyStore, RunRow, UserRow } from './storage.ts';
import type { GroqClient, LlmTransport, RateGovernor } from './llm.ts';
import type { AgentRunner, ContextProvider, ConversationService, SideCalls, ToolkitState } from './agent.ts';
import type { ApprovalService, GrantService, Sentinel, StepUpService, ToolExecutor, TrustedTargetService, UndoService, UntrustedWrapper } from './trust.ts';
import type { CallbackRegistry, ChannelFactory, SentRef, TelegramGateway, TelegramModule } from './telegram.ts';
import type { ToolRegistry, ToolSpec } from './tools.ts';
import type { Capabilities, LlmBudget, LocationService } from './capabilities.ts';
import type { IntegrationProvider, IntegrationService } from './integrations.ts';
import type { MemoryService, ProfileService } from './memory.ts';
import type { ProactivePolicy, SignalsService } from './behaviour.ts';
import type { Scheduler } from './scheduler.ts';
import type { BriefService, CommitmentService, MissionService, NudgeService, ReminderService, TodoService, WatcherService } from './proactive.ts';
import type { BusinessService } from './business.ts';
import type { PaymentsService, QuotaKind, QuotaService } from './billing.ts';
import type { Ledger } from './ledger.ts';
import type { ProviderProfile } from './llm.ts';
import type { Strings } from './i18n.ts';

/**
 * Every WP's hook into /deletemydata, epoch shredding, /export (§11.9) and the retention sweep. Each WP decrypts its own
 * rows (its own AAD conventions), so WP1 never reads another WP's encrypted columns:
 *  - `exportUser`: the WP's part of the export JSON, merged under `hook.name` (WP5 connections without tokens; WP6 memory
 *    with provenance, reminders, to-dos, missions, watchers; WP7 business metadata + stored messages, payments);
 *  - `retentionSweep`: the WP's rows of the §11.9 retention table (WP2 tg_updates/outbox; WP4 pending-action payloads;
 *    WP5 location after 1 h; WP7 business messages after 30 days, guest/deep-link rows after 24 h).
 * PrivacyService.exportUser / retentionSweep iterate the hooks in registration order; a hook error is logged and skipped.
 */
export interface PrivacyHook {
  name: string;
  onDeleteUser(userId: UserId, tgUserId: number): Promise<void>;
  onShredEpoch?(conversationId: string, epoch: number): Promise<void>;
  exportUser?(userId: UserId, tgUserId: number): Promise<Record<string, unknown>>;
  retentionSweep?(now: Ms): Promise<void>;
  /**
   * Spec 05 (friend mode): the owner made Gora forget facts (01 §9) — after the fingerprints are recorded and the
   * generation rotated. `texts`: the forgotten facts (in memory only, never stored); `keep` returns the texts that hold
   * none of the forgotten wording (the fingerprint filter). A module scrubs its own derived copies with them (e.g.
   * behaviour: the texts of earlier proactive messages, which reword a fact). Synchronous; must not throw.
   */
  onForget?(userId: UserId, f: { texts: readonly string[]; keep: (texts: string[]) => string[] }): void;
}
export interface PrivacyService {
  exportUser(userId: UserId): Promise<Uint8Array>;
  deleteUser(userId: UserId, reason: 'user' | 'admin'): Promise<void>;
  shredEpoch(conversationId: string, epoch: number, reason: string): Promise<void>;
  shredConversation(conversationId: string, reason: string): Promise<void>;
  retentionSweep(now: Ms): Promise<void>;
}

/**
 * WP3 calls every hook, in registration order, after finalize() of a run (state done, refused or failed — not parked).
 * A hook error is logged and never fails the run. WP7 uses it for "at most one onboarding card after each completed run" (§3).
 */
export interface RunHook { name: string; onRunFinished(run: RunRow, conv: ConversationRow, sent: SentRef[]): Promise<void> | void }

export type ChatRef = { chatId: number; threadId?: number };
/**
 * Notices whose text and buttons belong to the surfaces (surfaces/strings.ts, onboarding.ts) but are sent by others:
 * drive() (WP3, finishWithTemplate 'quota') and the Mini App (WP8, POST /api/settings/tz). Spec 05 removed the
 * onboarding cards: nothing here advances an onboarding step, and the executor attaches the lazy tz button itself.
 */
export interface NoticeService {
  /** The quota template (§13): exact counts, reset time, [⭐ Plans]. No LLM. */
  quotaExceeded(userId: UserId, k: QuotaKind, chat: ChatRef): Promise<void>;
  /**
   * Spec 05 A6: the ONE compact "🕒 Set my time zone" web_app line while tz_source='default' — at most once per
   * LIMITS.tzHintEveryMs, never once the zone is confirmed (the same gate as the executor's lazy hint). No card.
   */
  askTimezone(userId: UserId, chat: ChatRef): Promise<void>;
  /**
   * Sets nothing itself: the caller already updated users.tz. Silent for a zone learned from a location or a city in
   * conversation; one short confirmation line (no buttons) when the owner set it explicitly (Mini App, manual).
   */
  timezoneSet(userId: UserId, tz: string, source: UserRow['tzSource']): Promise<void>;
}

/** deeplink_tokens (WP7): guest continue (g_), /me (me_), export download (5 min). Tokens are bound to `ownerTgId` and single-use. */
export interface DeepLinkService {
  create(kind: 'guest' | 'me' | 'export', ownerTgId: number, payload: unknown, ttlMs: number): string;
  consume(token: string, kind: 'guest' | 'me' | 'export', byTgId?: number): { ownerTgId: number; payload: unknown } | { error: 'not_found' | 'expired' | 'used' | 'not_owner' };
}
/** choice_sets (WP7). Written by offer_choices (WP5); the `ch:<setId>:<i>` tap is WP7's. */
export interface ChoiceService {
  create(p: { userId: UserId | null; conversationId: string; chatId: number; options: string[]; ttlMs: number }): string;
  attachMessage(setId: string, messageId: number): void;
}
/** groups (WP7). memory_gen is rotated by WP6's group forget (§9 step 3); the private hint by WP2's group channel (§5.5). */
export interface GroupService {
  memoryGen(chatId: number): number;
  bumpMemoryGen(chatId: number): number;
  /** true exactly once per (chat, local day): that reply carries [🔒 Use Gora privately]. */
  claimPrivateHint(chatId: number, localDay: string): boolean;
}
/** guest_invocations (WP7). Updated by WP2's guest channel. */
export interface GuestService {
  mark(guestQueryId: string, status: 'placeholder' | 'answered' | 'edited' | 'failed', inlineMessageId?: string): void;
}

export interface Services {
  config: Config; clock: Clock; log: Logger; db: Db; crypto: Crypto; repos: CoreRepos; ledger: Ledger; quotas: QuotaService; privacy: PrivacyService;
  privacyHooks: PrivacyHook[]; contextProviders: ContextProvider[];
  /** WP0 addition: see RunHook. Created by app.ts before any module factory. */
  runHooks: RunHook[];
  transport: LlmTransport; telegram: TelegramGateway; runner: AgentRunner; conversations: ConversationService; side: SideCalls;
  sentinel: Sentinel; approvals: ApprovalService; executor: ToolExecutor; undo: UndoService; stepup: StepUpService; registry: ToolRegistry;
  caps: Capabilities;
  /** 03 R4/R7 name for the same object as `caps` (both are always set; they are the identical instance). */
  capabilities: Capabilities;
  integrations: IntegrationService; memory: MemoryService; scheduler: Scheduler; reminders: ReminderService; todos: TodoService;
  nudges: NudgeService; brief: BriefService; commitments: CommitmentService; missions: MissionService; watchers: WatcherService;
  business: BusinessService; payments: PaymentsService;
  // ── 03 R6/R7 additions
  /** Daily LLM budget gate (scheduler pauses proactive/background work through `allow`). */
  llmBudget: LlmBudget;
  /** Per-model rate governor shared by the Groq transport and the Groq capabilities (pass-through on Anthropic/demo). */
  rateGovernor: RateGovernor;
  /** The single groq-sdk client (kernel/groqClient.ts), or null when GROQ_API_KEY is absent / in tests. */
  groq: GroqClient | null;
  /** The active provider profile (same object as config.profile). */
  profile: ProviderProfile;
  // ── WP0 additions (cross-WP services; every one is dereferenced at call time)
  /** WP3 (AgentModule.toolkits). */
  toolkits: ToolkitState;
  /** WP4 (TrustModule.untrusted, .grants, .trustedTargets). */
  untrusted: UntrustedWrapper; grants: GrantService; trustedTargets: TrustedTargetService;
  /** WP5 (Capabilities.location). */
  location: LocationService;
  /** WP7a (SurfacesModule.*); `business` above is WP7b (BusinessModule.business). */
  notices: NoticeService; deepLinks: DeepLinkService; choices: ChoiceService; groups: GroupService; guests: GuestService;
  /** WP7 (surfaces/strings.ts createStrings()); built FIRST by app.ts, so it is usable at factory time too. */
  strings: Strings;
  /** The keys.db store (same object as App.keyStore). Only WP1 uses it (backup job, admin rewrap); everyone else goes through `crypto`. */
  keyStore: KeyStore;
  // ── Friend-mode additions (spec 05). All dereferenced at call time, like every other service.
  /** The only randomness in src/ (set by app.ts before any factory; seeded in the test harness). */
  random: Random;
  /** B4/B5 profile card (src/memory/, createProfileService). Named userProfile because `profile` is the ProviderProfile. */
  userProfile: ProfileService;
  /** C1–C3 (src/behaviour/, BehaviourModule.signals). */
  signals: SignalsService;
  /** C4 (src/behaviour/, BehaviourModule.policy). */
  proactivePolicy: ProactivePolicy;
}

// ── Factory return shapes (01 §4.4 wiring table)
export interface AgentModule {
  runner: AgentRunner; conversations: ConversationService; side: SideCalls; toolkits: ToolkitState;
  /**
   * Integration addition (WP2/WP3 request): the Telegram ChannelFactory is built after the agent, so app.ts hands it over
   * right after createTelegramModule. A factory passed explicitly to the agent (tests) wins over the attached one.
   * Optional so test fakes need not implement it; without it runs use the agent's non-streaming fallback channel.
   */
  attachChannels?(f: ChannelFactory): void;
}
export interface TrustModule {
  sentinel: Sentinel; approvals: ApprovalService; executor: ToolExecutor; undo: UndoService; stepup: StepUpService;
  untrusted: UntrustedWrapper; grants: GrantService; trustedTargets: TrustedTargetService;
}
export interface ReminderModule { reminders: ReminderService; todos: TodoService }
export interface ProactiveModule { nudges: NudgeService; brief: BriefService; commitments: CommitmentService }
export interface MissionModule { missions: MissionService; watchers: WatcherService }
/** Friend-mode addition (spec 05 §C): src/behaviour/index.ts createBehaviourModule. */
export interface BehaviourModule { signals: SignalsService; policy: ProactivePolicy }
/** WP7a (src/surfaces/index.ts createSurfaces): everything in src/surfaces/** except src/surfaces/business/**. */
export interface SurfacesModule {
  registerHandlers(bot: Bot): void; payments: PaymentsService;
  notices: NoticeService; deepLinks: DeepLinkService; choices: ChoiceService; groups: GroupService; guests: GuestService;
}
/**
 * WP7b (src/surfaces/business/index.ts createBusinessModule), WP0 addition for the WP7a/WP7b split: the Secretary
 * pipeline. Built right after the Telegram module and before createSurfaces (so `s.business` is set when WP7a's factory
 * runs). `registerHandlers` installs the business_connection / business_message / edited_business_message /
 * deleted_business_messages handlers; app.ts calls it right after `surfaces.registerHandlers(bot)`. The `bz:` callback,
 * the business jobs (business_triage / business_window / business_digest), the business privacy hook and context
 * provider are registered by this factory (factory-time registration rules apply).
 */
export interface BusinessModule { business: BusinessService; registerHandlers(bot: Bot): void }
/** 03 R6: created by WP3 (agent/groq/rate.ts + budget.ts); a pass-through governor and an always-allow budget outside Groq. */
export interface LlmGovernance { governor: RateGovernor; budget: LlmBudget }
export interface TelegramModuleOptions {
  /** Installed innermost-first: tests pass [fakeTelegram.transformer]; WP2 then installs limiter and autoRetry around them. */
  transformers?: Transformer[];
  /** Given in tests: no getMe call. */
  botInfo?: UserFromGetMe;
  /** fetch used for Telegram file downloads (telegram/files.ts). */
  fetchImpl?: typeof fetch;
  /** The callback registry created by app.ts before any module factory ran; the gateway MUST expose this same instance. */
  callbacks?: CallbackRegistry;
  /**
   * `outbox.onSent` registrations made at factory time through app.ts's pre-gateway (before the Telegram module existed).
   * WP2 MUST install every one on the real outbox before `outbox.start()` (i.e. inside createTelegramModule), so rows
   * queued before a restart never send without their hook. The array is live: later pushes must also be honored.
   */
  sentHooks?: Array<{ refKind: string; hook: (refId: string, sent: SentRef[]) => void }>;
}

/**
 * Every module factory, exactly as app.ts calls them (01 §4.4 table, plus the 03 R6 governance factory).
 * `s` is the Services object under construction: factories MUST dereference `s.<x>` only at call time, except for these
 * factory-time registrations (each target exists before the first module factory runs):
 *  - job handlers:        s.scheduler.register(kind, h)
 *  - system cron jobs:    s.scheduler.schedule({..., dedupeKey: 'sys:<kind>'})   (idempotent upsert; e.g. backup, retention_sweep)
 *  - callbacks:           s.telegram.callbacks.register(kind, h)
 *  - context providers:   s.contextProviders.push(p)            (kernel/registries.ts registerNamed)
 *  - privacy hooks:       s.privacyHooks.push(h)
 *  - run hooks:           s.runHooks.push(h)
 *  - outbox sent hooks:   s.telegram.outbox.onSent(refKind, hook) (buffered by the pre-gateway, see TelegramModuleOptions.sentHooks)
 *  - quota counters:      s.quotas.registerCounter('mission'|'watcher', fn)
 *  - UI strings:          s.strings.t(...)                      (built first)
 * Tools are not registered at runtime: each WP exports `TOOLS` from its tools.ts (contracts/tools.ts TOOL_FILES).
 */
export interface Factories {
  /** WP7 (surfaces/strings.ts). Pure data, no dependencies; built before every other factory. */
  createStrings(): Strings;
  openKeyStore(path: string, kek: Uint8Array): KeyStore;
  createCrypto(ks: KeyStore, hashKey: Uint8Array): Crypto;
  createCoreRepos(db: Db, crypto: Crypto, clock: Clock): CoreRepos;
  createLedger(s: Services): Ledger;
  createQuotaService(s: Services): QuotaService;
  createPrivacyService(s: Services): PrivacyService;
  createLlmGovernance(s: Services): LlmGovernance;
  /** Integration addition: `o.fetchImpl` is injected into the Anthropic SDK client (omitted → the SDK default). */
  createTransport(cfg: Config, log: Logger, s: Services, o?: { fetchImpl?: typeof fetch }): LlmTransport;
  /** Integration addition: `o.sentinelPolicy` is WP4's static LLM Sentinel policy (03 R5), passed by app.ts. */
  createCapabilities(cfg: Config, fetchImpl: typeof fetch, s: Services, o?: { sentinelPolicy?: string | (() => string | null) }): Capabilities;
  /** Integration addition: `o.fetchImpl` for the Composio REST provider (global fetch is banned outside main/app). */
  createIntegrationService(s: Services, provider?: IntegrationProvider, o?: { fetchImpl?: typeof fetch }): IntegrationService;
  /** `external`: the TOOLS arrays of trust/, memory/, reminders/, missions/, surfaces/ and surfaces/business/ (see TOOL_FILES). Throws on duplicate names. */
  createToolRegistry(profile: ProviderProfile, external: readonly ToolSpec[], o?: { webFetchUrlSources?: boolean }): ToolRegistry;
  createTrustModule(s: Services): TrustModule;
  createMemoryService(s: Services): MemoryService;
  createScheduler(s: Services): Scheduler;
  createReminderModule(s: Services): ReminderModule;
  createProactiveModule(s: Services): ProactiveModule;
  createMissionModule(s: Services): MissionModule;
  /** Friend-mode (spec 05 B4): src/memory/profile.ts. Built right after createMemoryService. */
  createProfileService(s: Services): ProfileService;
  /** Friend-mode (spec 05 §C): src/behaviour/index.ts. Built right after createMissionModule. */
  createBehaviourModule(s: Services): BehaviourModule;
  createAgentModule(s: Services): AgentModule;
  createTelegramModule(s: Services, o: TelegramModuleOptions): Promise<TelegramModule>;
  /** WP7b. Called after createTelegramModule, before createSurfaces. */
  createBusinessModule(s: Services): BusinessModule;
  /** WP7a. */
  createSurfaces(s: Services): SurfacesModule;
  createHttpApp(s: Services, tg: TelegramModule): Hono;
}
