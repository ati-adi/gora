// src/config.ts (WP0) — zod env schema, ROUTES, BETAS, PLANS, LIMITS, PROVIDER_PROFILES + resolveProfile.
// 01 §14 + 02 §F + 03 R2/R7. loadConfig fails fast with readable errors; in NODE_ENV=test every provider is fake.
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { PlanId, Route, ToolsetId } from './contracts/common.ts';
import type { PlanLimits } from './contracts/billing.ts';
import type { ProviderProfile } from './contracts/llm.ts';
import { ConfigError } from './kernel/errors.ts';

// ───────────────────────── static tables

/** 01 §5.1 per-route settings (fixed at conversation creation). maxTurns per 01 §5.4 drive(). */
export interface RouteSpec { effort: 'low' | 'medium' | 'high'; maxTokens: number; toolset: ToolsetId; maxTurns: number }
export const ROUTES: Readonly<Record<Route, RouteSpec>> = Object.freeze({
  chat: { effort: 'medium', maxTokens: 32_000, toolset: 'FULL', maxTurns: 25 },
  mission: { effort: 'high', maxTokens: 64_000, toolset: 'FULL', maxTurns: 40 },
  group: { effort: 'low', maxTokens: 8_000, toolset: 'GROUP', maxTurns: 8 },
  guest: { effort: 'low', maxTokens: 8_000, toolset: 'GUEST', maxTurns: 8 },
  biz: { effort: 'medium', maxTokens: 16_000, toolset: 'BIZ', maxTurns: 8 },
});

/** 01 §5.2 beta header names. */
export const BETAS = Object.freeze({
  fallback: 'server-side-fallback-2026-07-01',
  compaction: 'compact-2026-01-12',
  clearAt: 'mid-conversation-system-clear-at-2026-08-21',
  cacheDiagnosis: 'cache-diagnosis-2026-04-07',
} as const);

/** conv.betas for a new conversation (01 §5.2). */
export function betasFor(f: Pick<Features, 'serverCompaction' | 'clearAt' | 'cacheDiagnosis'>): string[] {
  const b: string[] = [BETAS.fallback];
  if (f.serverCompaction) b.push(BETAS.compaction);
  if (f.clearAt) b.push(BETAS.clearAt);
  if (f.cacheDiagnosis) b.push(BETAS.cacheDiagnosis);
  return b;
}

/** 01 §13 (tunable). */
export const PLANS: Readonly<Record<PlanId, PlanLimits>> = Object.freeze({
  free: { priceXtr: 0, turnsPerDay: 40, webSearchesPerDay: 15, sttSecondsPerDay: 1200, filesPerDay: 3, guestAnswersPerDay: 20, activeMissions: 1, watchers: 3, watcherMinIntervalMin: 360, missionBudgetMicros: 500_000, dailyCostCapMicros: 1_500_000, nudgeBudgetMax: 5, browserTasksPerDay: 3 },
  plus: { priceXtr: 500, turnsPerDay: 200, webSearchesPerDay: 60, sttSecondsPerDay: 3600, filesPerDay: 15, guestAnswersPerDay: 100, activeMissions: 5, watchers: 15, watcherMinIntervalMin: 60, missionBudgetMicros: 3_000_000, dailyCostCapMicros: 8_000_000, nudgeBudgetMax: 10, browserTasksPerDay: 15 },
  pro: { priceXtr: 1500, turnsPerDay: 600, webSearchesPerDay: 200, sttSecondsPerDay: 10800, filesPerDay: 50, guestAnswersPerDay: 300, activeMissions: 20, watchers: 50, watcherMinIntervalMin: 30, missionBudgetMicros: 10_000_000, dailyCostCapMicros: 25_000_000, nudgeBudgetMax: 10, browserTasksPerDay: 50 },
});

/** 01 §6 BLOCKED_DOMAINS (web_search/web_fetch blocked_domains; Groq open() precheck, 03 R4). */
export const BLOCKED_DOMAINS: readonly string[] = Object.freeze([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'pastebin.com', 'ghostbin.com', 'hastebin.com', 'rentry.co',
  'webhook.site', 'requestbin.com', 'pipedream.net', 'ngrok.io', 'ngrok-free.app', 'burpcollaborator.net', 'interact.sh', 'oast.fun',
]);

/** Numeric limits collected from 01 (§2, §4, §5, §9, §11) and 02/03. */
export const LIMITS = Object.freeze({
  // files & media (F3)
  maxDownloadBytes: 20 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxTextFileBytes: 200 * 1024,
  transcriptEchoSec: 20,
  // streaming (F2, §5.5, ⚠U3)
  draftThrottleMs: 700,
  draftMaxIntervalMs: 3_000,
  draftKeepAliveMs: 15_000,
  typingIntervalMs: 4_500,
  draft429Limit: 3,
  richSplitChars: 30_000,
  richSplitBlocks: 450,
  plainChunkChars: 4_096,
  groupPlaceholderMs: 12_000,
  guestAnswerMs: 3_000,
  // runs (§4.1, §5.4, §5.10)
  maxConcurrentRuns: 32,
  runLeaseMs: 120_000,
  runLeaseRenewMs: 30_000,
  coalesceDebounceMs: 700,
  coalesceMaxMs: 2_000,
  maxContinuations: 5,
  maxTokensCap: 128_000,
  retryDelaysMs: [15_000, 60_000, 300_000] as readonly number[],
  // approvals & undo (F7, §5.6)
  undoTtlMs: 10 * 60_000,
  approvalExpiryDefaultMin: 1440,
  missionApprovalMaxMs: 7 * 24 * 3_600_000,
  dmTaskWaitMaxHours: 24,
  // epochs (§5.9)
  epochIdleMs: 55 * 60_000,
  epochIdleMinTokens: 12_000,
  epochSizeTokens: 120_000,
  handoffForkAfterMs: 45 * 60_000,
  compactionTriggerTokens: 160_000,
  contextRowMaxTokens: 1_200,
  // memory (§9)
  memoryMaxFacts: 2_000,
  memoryMinConfidence: 0.8,
  // proactivity (§8)
  nudgeDefaultBudget: 3,
  nudgeDedupeDays: 7,
  quietStart: '22:00',
  quietEnd: '08:00',
  // inbound limits (§11.8, §10.3, §10.4)
  userMsgsPerMinute: 20,
  userBurst: 10,
  groupTriggersPer10Min: 30,
  groupSendsPerMinute: 20,
  guestPerCallerPerHour: 10,
  guestPerChatPerHour: 30,
  callbacksPerSecond: 10,
  refusalsPerDayBeforeCooldown: 5,
  // http (§12)
  initDataReadMaxAgeSec: 24 * 3600,
  initDataWriteMaxAgeSec: 3600,
  initDataHighMaxAgeSec: 600,
  // safe fetch (§11.5)
  safeFetchTimeoutMs: 10_000,
  safeFetchMaxBytes: 2 * 1024 * 1024,
  safeFetchMaxRedirects: 3,
  // Groq (02 §B, 03 R2–R6)
  groqToolResultMaxTokens: 1_500,
  groqWebMaxUsesFull: 5,
  groqWebMaxUsesOther: 3,
  groqInteractiveWaitMs: 4_000,
  groqBusyWaitMaxMs: 45_000,
  groqDegradeProactiveAt: 0.85,
  groqDegradeInteractiveOnlyAt: 0.97,
  toolkitTurns: 6,
  compactSystemMaxTokens: 700, // spec 05 A4 (was 650 before the friend persona)
  coreToolkitMaxTokens: 1_100,
  toolDescriptionMaxChars: 160,
  guardChunkChars: 1_500,
  guardChunkOverlap: 200,
  guardMaxChunks: 6,
  ttsMaxChars: 600,
  // friend mode (spec 05)
  memoryHalfLifeDays: 30, // B3 recency decay (pinned / profile-level facts do not decay)
  memoryExtractExchanges: 3, // B1 batch: after 3 exchanges …
  memoryExtractIdleMs: 10 * 60_000, // … or 10 idle minutes
  profileConsolidateAfterFacts: 15, // B4
  profileMaxTokens: 250, // B4 head of <user_model>
  userModelMaxTokens: 300, // B3 (02 §B budget)
  tzHintEveryMs: 7 * 86_400_000, // A6
  signalsRetentionDays: 90, // C1
  rhythmHalfLifeDays: 21, // C2
  rhythmPriorWeight: 5, // C2 pseudo-messages of the population histogram
  proactiveTickMin: 30, // C4
  proactiveTopHoursFraction: 0.3, // C4 send only at hours in the user's top 30% P(active)
  proactiveJitterMs: 20 * 60_000, // C4 ±20 min
  proactiveMaxPer24h: 1, // C4
  proactiveHardStopUnanswered: 4, // C4 safety cap
  proactiveAnnoyancePerUnanswered: 0.25, // C4
  proactivePriorCap: 10, // C4 hierarchical prior pseudo-counts
  proactiveReplyWindowMs: 24 * 3_600_000, // C4 reward window
  proactiveStopPenalty: 5, // C4 β += 5 on "stop"
  // s07 §A browser agent
  browserMaxSteps: 40, // A4 per task
  browserMaxWallMs: 15 * 60_000, // A4, then park offering to continue
  browserMaxConcurrentPerUser: 1, // A4
  browserSnapshotMaxTokensSmall: 1_800, // A3 on groq-free
  browserSnapshotMaxTokensLarge: 6_000, // A3 on larger profiles
  browserVisionEverySteps: 5, // A3 ≤ 1 vision describe per 5 steps
  browserActionTimeoutMs: 5_000,
  browserNavigationTimeoutMs: 20_000,
  browserSweepEveryMs: 60_000,
  browserViewport: { width: 1280, height: 800 } as const,
  browserTaskRetentionDays: 30,
  // s07 §B Composio
  integrationPollEveryMs: 5_000, // B1
  integrationPollForMs: 10 * 60_000, // B1
  // s07 §C groups
  groupMessageRetentionDays: 14, // C3
  groupLeftGraceMs: 7 * 86_400_000, // C3 (as 01)
  groupSummaryEveryMessages: 40, // C3
  groupSummaryIdleMs: 10 * 60_000, // C3
  groupLullMs: 45_000, // C4 a burst ends after a 45 s lull
  groupUnansweredQuestionMs: 2 * 60_000, // C4 open question unanswered ≥ 2 min
  groupRewardWindowMs: 10 * 60_000, // C4
  groupChimeMinGapMs: 30 * 60_000, // C4 ≤ 1 unprompted message per 30 min
  groupChimeMaxPerDay: 6, // C4
  groupNightStart: '22:00', // C4 never at night in the group's tz
  groupNightEnd: '09:00',
  groupWindowMaxMessages: 30, // C4 heuristic/judge window
  groupJudgeValueMaxChars: 100, // C4
  groupChimeMaxSentences: 2, // C4
  groupContextMaxTokens: 600, // recent messages + summary in an addressed reply's <group> context
  groupMessageMaxChars: 4_000, // stored text cap per message
  groupPriorAlpha: 1, // C4 conservative population prior Beta(1, 3)
  groupPriorBeta: 3,
});

/** 03 R2 provider profiles (model names are defaults; resolveProfile applies env overrides). */
export const PROVIDER_PROFILES: Readonly<Record<ProviderProfile['id'], ProviderProfile>> = Object.freeze({
  anthropic: { id: 'anthropic', provider: 'anthropic', maxPromptTokens: 150_000, maxOutputTokens: 32_000, sideMaxOutputTokens: 4_000, systemVariant: 'full', toolMode: 'static', caching: true, epochRotateTokens: 120_000, maxToolSteps: 24, models: { main: 'claude-opus-5', fast: 'claude-opus-5' } },
  'groq-free': { id: 'groq-free', provider: 'groq', maxPromptTokens: 5_200, maxOutputTokens: 1_200, sideMaxOutputTokens: 500, systemVariant: 'compact', toolMode: 'toolkits', caching: false, epochRotateTokens: 2_400, maxToolSteps: 8, models: { main: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b' } },
  'groq-dev': { id: 'groq-dev', provider: 'groq', maxPromptTokens: 60_000, maxOutputTokens: 1_200, sideMaxOutputTokens: 500, systemVariant: 'compact', toolMode: 'toolkits', caching: false, epochRotateTokens: 40_000, maxToolSteps: 8, models: { main: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b' } },
});

/** 02 §A Groq role → default model. */
export const GROQ_DEFAULT_MODELS = Object.freeze({
  main: 'openai/gpt-oss-120b',
  fast: 'openai/gpt-oss-20b',
  vision: 'qwen/qwen3.8-27b',
  sentinel: 'openai/gpt-oss-safeguard-20b',
  guard: 'meta-llama/llama-prompt-guard-2-86m',
  stt: 'whisper-large-v3-turbo',
  tts: 'canopylabs/orpheus-v1-english',
});

// ───────────────────────── env schema

type Env = Record<string, string | undefined>;
const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const str = (d: string) => z.preprocess(emptyToUndef, z.string().default(d));
const optStr = z.preprocess(emptyToUndef, z.string().optional());
const bool = (d: boolean) =>
  z.preprocess((v) => {
    const x = emptyToUndef(v);
    if (x === undefined) return d;
    if (typeof x === 'string') {
      const s = x.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
    }
    return x;
  }, z.boolean());
const int = (d: number) => z.preprocess((v) => (emptyToUndef(v) === undefined ? d : Number(v)), z.number().int());

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndef, z.enum(['development', 'test', 'production']).default('development')),
  GORA_MODE: z.preprocess(emptyToUndef, z.enum(['webhook', 'polling']).default('polling')),
  PORT: int(8080).pipe(z.number().min(1).max(65535)),
  PUBLIC_URL: str('https://gora.example.com').pipe(z.url()),
  DATA_DIR: str('./data'),
  KEYS_DB_PATH: str('./keys/keys.db'),
  BACKUP_DIR: str('./backups'),
  LOG_LEVEL: z.preprocess(emptyToUndef, z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info')),
  MINIAPP_FRAME_ANCESTORS: str('https://web.telegram.org https://*.telegram.org'),

  TELEGRAM_BOT_TOKEN: optStr.pipe(z.string().regex(/^\d+:[A-Za-z0-9_-]+$/, 'must look like <id>:<secret>').optional()),
  TELEGRAM_WEBHOOK_SECRET: optStr.pipe(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, '1-256 chars of [A-Za-z0-9_-]').optional()),
  TELEGRAM_API_ROOT: str('https://api.telegram.org').pipe(z.url()),
  TELEGRAM_TEST_ENV: bool(false),
  ADMIN_TG_IDS: str(''),

  GORA_KEK: optStr,
  GORA_CALLBACK_KEY: optStr,
  GORA_HASH_KEY: optStr,
  /** Escape hatch (development only): accept the fixed insecure keys even with a real TELEGRAM_BOT_TOKEN. */
  ALLOW_INSECURE_DEV_KEYS: bool(false),

  LLM_PROVIDER: z.preprocess(emptyToUndef, z.enum(['auto', 'groq', 'anthropic']).default('auto')),
  ANTHROPIC_API_KEY: optStr,
  ANTHROPIC_MODEL: optStr,
  ANTHROPIC_MODEL_MAIN: optStr,
  ANTHROPIC_SIDE_MODEL: optStr,
  ANTHROPIC_BASE_URL: optStr.pipe(z.url().optional()),
  PRICING_OVERRIDES_JSON: optStr,

  GROQ_API_KEY: optStr,
  GROQ_TIER: z.preprocess(emptyToUndef, z.enum(['free', 'dev']).default('free')),
  GROQ_MODEL_MAIN: str(GROQ_DEFAULT_MODELS.main),
  GROQ_MODEL_FAST: str(GROQ_DEFAULT_MODELS.fast),
  GROQ_MODEL_VISION: str(GROQ_DEFAULT_MODELS.vision),
  GROQ_MODEL_SENTINEL: str(GROQ_DEFAULT_MODELS.sentinel),
  GROQ_MODEL_GUARD: str(GROQ_DEFAULT_MODELS.guard),
  GROQ_MODEL_STT: str(GROQ_DEFAULT_MODELS.stt),
  GROQ_MODEL_TTS: str(GROQ_DEFAULT_MODELS.tts),
  GROQ_TTS_VOICE: z.preprocess(emptyToUndef, z.enum(['hannah', 'diana', 'autumn', 'austin', 'daniel', 'troy']).default('hannah')),
  LLM_MAX_PROMPT_TOKENS: z.preprocess((v) => (emptyToUndef(v) === undefined ? undefined : Number(v)), z.number().int().min(500).optional()),

  FEATURE_SERVER_COMPACTION: bool(true),
  FEATURE_CLEAR_AT: bool(false),
  FEATURE_CACHE_DIAGNOSIS: bool(false),
  FEATURE_WEB_FETCH_URL_SOURCES: bool(true),
  FEATURE_BUSINESS: bool(true),
  FEATURE_BUSINESS_RICH: bool(false),
  FEATURE_GUEST: bool(true),
  FEATURE_GROUPS: bool(true),
  FEATURE_MISSIONS: bool(true),
  FEATURE_MAKE_FILE: bool(true),
  FEATURE_VOICE_REPLIES: bool(true),

  INTEGRATIONS_PROVIDER: z.preprocess(emptyToUndef, z.enum(['fake', 'composio', 'none']).default('fake')),
  COMPOSIO_API_KEY: optStr,
  /** Spec 07 B4: explicit Composio auth config ids (ac_…) when the Composio-managed ones must be pinned. */
  COMPOSIO_AUTH_CONFIG_GCAL: optStr,
  COMPOSIO_AUTH_CONFIG_GMAIL: optStr,
  /** Spec 07 A1: 'playwright' (headless Chromium, `npx playwright install chromium`), 'none'. Forced to 'none' under test (tests inject FakeBrowser). */
  BROWSER_PROVIDER: z.preprocess(emptyToUndef, z.enum(['playwright', 'none']).default('playwright')),
  BROWSER_HEADLESS: bool(true),
  /** Chromium's OS sandbox (default on). Turn off only inside a container that cannot provide it (then isolate the container). */
  BROWSER_SANDBOX: bool(true),
  /** Optional Chromium/Chrome executable (default: Playwright's cache). */
  BROWSER_EXECUTABLE_PATH: optStr,
  FEATURE_BROWSER: bool(true),
  /** Spec 07 §C: read the whole group (privacy mode OFF) and chime in; false = the 01 F14 mention-only behaviour. */
  FEATURE_GROUP_PARTICIPANT: bool(true),
  /** 'auto' (default): groq when GROQ_API_KEY is set, else openai when OPENAI_API_KEY is set, else none (02 §A). */
  STT_PROVIDER: z.preprocess(emptyToUndef, z.enum(['auto', 'fake', 'groq', 'openai', 'none']).default('auto')),
  STT_MODEL: optStr,
  OPENAI_API_KEY: optStr,
  WEATHER_PROVIDER: z.preprocess(emptyToUndef, z.enum(['fake', 'openmeteo', 'metno']).default('openmeteo')),
  FX_PROVIDER: z.preprocess(emptyToUndef, z.enum(['fake', 'erapi']).default('erapi')),
  GEO_PROVIDER: z.preprocess(emptyToUndef, z.enum(['fake', 'live']).default('live')),
  HTTP_USER_AGENT: str('GoraBot/1.0 (+https://gora.example.com/bot)'),

  /** Spec 05 B2: 'local' (default; @huggingface/transformers on CPU), 'fake' (deterministic hashing, no model), 'none' (FTS-only). */
  EMBEDDINGS_PROVIDER: z.preprocess(emptyToUndef, z.enum(['local', 'fake', 'none']).default('local')),
  EMBEDDINGS_MODEL: str('Xenova/multilingual-e5-small'),
  /** Model cache; default <DATA_DIR>/models. */
  EMBEDDINGS_CACHE_DIR: optStr,
  /** Spec 05 C4: the send threshold τ (scaled by the user's proactive level). */
  PROACTIVE_TAU: z.preprocess((v) => (emptyToUndef(v) === undefined ? undefined : Number(v)), z.number().min(0).max(1).default(0.3)),
});

// ───────────────────────── Config shape (01 §14 + 03)

export interface Features {
  serverCompaction: boolean; clearAt: boolean; cacheDiagnosis: boolean; webFetchUrlSources: boolean;
  business: boolean; businessRich: boolean; guest: boolean; groups: boolean; missions: boolean; makeFile: boolean;
  /** 03 R4 (WP0 addition): global kill switch for TTS voice replies (users still opt in with /voice). */
  voiceReplies: boolean;
  /** s07 §A: browse_task / the browser toolkit. */
  browser: boolean;
  /** s07 §C: group participant mode (reads every message when privacy mode is OFF; chime-ins). */
  groupParticipant: boolean;
}
export type Env3 = 'development' | 'test' | 'production';
export interface Config {
  env: Env3;
  mode: 'webhook' | 'polling';
  port: number;
  publicUrl: string;
  dataDir: string;
  keysDbPath: string;
  /** WP0 addition (§11.7 nightly backups, job 'backup'): gora.db + keys.db copies, 7-day retention. Not under DATA_DIR in production. */
  backupDir: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  frameAncestors: string;
  telegram: { token?: string; webhookSecret: string; apiRoot: string; testEnv: boolean; adminIds: number[] };
  secrets: { kek: Uint8Array; callbackKey: Uint8Array; hashKey: Uint8Array; /** true when dev/test fallback keys are in use (never in production) */ insecureDefaults: boolean };
  anthropic: { apiKey?: string; model: string; sideModel: string; baseURL?: string; pricingOverrides: Record<string, unknown> | null };
  groq: { apiKey?: string; tier: 'free' | 'dev'; models: { main: string; fast: string; vision: string; sentinel: string; guard: string; stt: string; tts: string }; ttsVoice: string };
  /** 03 R2: requested provider and the transport actually used ('demo' when no key; never in production). */
  llm: { requested: 'auto' | 'groq' | 'anthropic'; transport: 'anthropic' | 'groq' | 'demo' };
  profile: ProviderProfile;
  features: Features;
  providers: { integrations: 'fake' | 'composio' | 'none'; stt: 'fake' | 'groq' | 'openai' | 'none'; sttModel: string; weather: 'fake' | 'openmeteo' | 'metno'; fx: 'fake' | 'erapi'; geo: 'fake' | 'live'; /** spec 05 B2 */ embeddings: 'local' | 'fake' | 'none'; /** spec 07 A1 */ browser: 'playwright' | 'none' };
  /** Spec 05 B2: the local embedding model and its cache directory (never inside the repo's ./data in tests). */
  embeddings: { model: string; dtype: 'q8'; cacheDir: string };
  /** Spec 05 C4. */
  proactive: { tau: number };
  /** Spec 07 A1. */
  browser: { headless: boolean; sandbox: boolean; executablePath?: string };
  /** Spec 07 B4: pinned auth config ids per integration (else the first enabled Composio-managed one, created if missing). */
  composio: { authConfigs: { gcal?: string; gmail?: string } };
  keys: { composio?: string; groq?: string; openai?: string };
  userAgent: string;
  routes: typeof ROUTES;
  plans: typeof PLANS;
  blockedDomains: readonly string[];
  limits: typeof LIMITS;
  betas: typeof BETAS;
}

// ───────────────────────── profile resolution (03 R2)

export interface ResolvedProfile { requested: 'auto' | 'groq' | 'anthropic'; transport: 'anthropic' | 'groq' | 'demo'; profile: ProviderProfile }

/**
 * LLM_PROVIDER=auto → anthropic if ANTHROPIC_API_KEY, else groq if GROQ_API_KEY, else demo (with the anthropic profile).
 * An explicit provider without its key → the demo transport with that provider's profile (loadConfig refuses this in production).
 * GROQ_TIER picks groq-free / groq-dev. LLM_MAX_PROMPT_TOKENS overrides maxPromptTokens. Model names follow the env.
 */
export function resolveProfile(env: Env): ResolvedProfile {
  const requested = (['auto', 'groq', 'anthropic'].includes(String(env['LLM_PROVIDER'] ?? '').trim()) ? String(env['LLM_PROVIDER']).trim() : 'auto') as ResolvedProfile['requested'];
  const has = (k: string) => typeof env[k] === 'string' && env[k]!.trim() !== '';
  let provider: 'anthropic' | 'groq';
  let transport: ResolvedProfile['transport'];
  if (requested === 'anthropic') {
    provider = 'anthropic';
    transport = has('ANTHROPIC_API_KEY') ? 'anthropic' : 'demo';
  } else if (requested === 'groq') {
    provider = 'groq';
    transport = has('GROQ_API_KEY') ? 'groq' : 'demo';
  } else if (has('ANTHROPIC_API_KEY')) {
    provider = 'anthropic';
    transport = 'anthropic';
  } else if (has('GROQ_API_KEY')) {
    provider = 'groq';
    transport = 'groq';
  } else {
    provider = 'anthropic';
    transport = 'demo';
  }
  const tier = String(env['GROQ_TIER'] ?? '').trim() === 'dev' ? 'dev' : 'free';
  const base = provider === 'anthropic' ? PROVIDER_PROFILES.anthropic : PROVIDER_PROFILES[tier === 'dev' ? 'groq-dev' : 'groq-free'];
  const pick = (...ks: string[]) => ks.map((k) => env[k]?.trim()).find((v) => v) ?? undefined;
  const models = provider === 'anthropic'
    ? { main: pick('ANTHROPIC_MODEL_MAIN', 'ANTHROPIC_MODEL') ?? base.models.main, fast: pick('ANTHROPIC_SIDE_MODEL') ?? base.models.fast }
    : { main: pick('GROQ_MODEL_MAIN') ?? base.models.main, fast: pick('GROQ_MODEL_FAST') ?? base.models.fast };
  const override = Number(env['LLM_MAX_PROMPT_TOKENS']);
  const profile: ProviderProfile = Object.freeze({
    ...base,
    models: Object.freeze(models),
    maxPromptTokens: Number.isInteger(override) && override >= 500 ? override : base.maxPromptTokens,
  });
  return { requested, transport, profile };
}

// ───────────────────────── secrets

/** Deterministic, clearly-insecure keys for development and tests only (never accepted in production). */
function devKey(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`gora-insecure-dev-key:${label}`).digest());
}

export function decodeKey(name: string, v: string | undefined, issues: string[]): Uint8Array | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    issues.push(`${name}: must be base64 (32 bytes)`);
    return null;
  }
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== 32) {
    issues.push(`${name}: must decode to exactly 32 bytes (got ${buf.length})`);
    return null;
  }
  return new Uint8Array(buf);
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The documented placeholder domain (.env.example / schema default). */
function isPlaceholderHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'example.com' || h.endsWith('.example.com');
  } catch {
    return false;
  }
}

// ───────────────────────── loadConfig

export function loadConfig(env: Env = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];
  const isTest = e.NODE_ENV === 'test';
  const isProd = e.NODE_ENV === 'production';

  // Secrets
  const kek = decodeKey('GORA_KEK', e.GORA_KEK, issues);
  const callbackKey = decodeKey('GORA_CALLBACK_KEY', e.GORA_CALLBACK_KEY, issues);
  const hashKey = decodeKey('GORA_HASH_KEY', e.GORA_HASH_KEY, issues);
  const insecureDefaults = !kek || !callbackKey || !hashKey;

  // In tests no real key is ever used: no live LLM, STT or integration calls.
  const anthropicKey = isTest ? undefined : e.ANTHROPIC_API_KEY;
  const groqKey = isTest ? undefined : e.GROQ_API_KEY;
  const resolved = resolveProfile({ ...env, ANTHROPIC_API_KEY: anthropicKey, GROQ_API_KEY: groqKey });

  if (isProd) {
    if (!e.TELEGRAM_BOT_TOKEN) issues.push('TELEGRAM_BOT_TOKEN is required in production');
    if (!e.TELEGRAM_WEBHOOK_SECRET) issues.push('TELEGRAM_WEBHOOK_SECRET is required in production');
    if (!e.GORA_KEK) issues.push('GORA_KEK is required in production');
    if (!e.GORA_CALLBACK_KEY) issues.push('GORA_CALLBACK_KEY is required in production');
    if (!e.GORA_HASH_KEY) issues.push('GORA_HASH_KEY is required in production');
    if (resolved.transport === 'demo') issues.push('an LLM key is required in production (ANTHROPIC_API_KEY or GROQ_API_KEY for LLM_PROVIDER=' + resolved.requested + ')');
    if (!e.PUBLIC_URL.startsWith('https://')) issues.push('PUBLIC_URL must be https:// in production');
    // The schema default is a placeholder: production needs the real Mini App / webhook domain, set explicitly.
    const rawPublicUrl = typeof env.PUBLIC_URL === 'string' ? env.PUBLIC_URL.trim() : '';
    if (!rawPublicUrl) issues.push('PUBLIC_URL is required in production (the https:// domain registered as the Mini App domain in BotFather)');
    else if (isPlaceholderHost(e.PUBLIC_URL)) issues.push('PUBLIC_URL must be your real domain in production, not the example placeholder');
    if (isUnder(e.KEYS_DB_PATH, e.DATA_DIR)) issues.push('KEYS_DB_PATH must not be under DATA_DIR in production (separate volume)');
    if (e.INTEGRATIONS_PROVIDER === 'fake') issues.push('INTEGRATIONS_PROVIDER=fake is refused in production (use composio or none)');
    if (isUnder(e.BACKUP_DIR, e.DATA_DIR)) issues.push('BACKUP_DIR must not be under DATA_DIR in production (separate volume)');
  }
  // Real user data must never be sealed under keys derivable from this source file (R9: `npm run dev` against Telegram).
  if (!isProd && !isTest && e.TELEGRAM_BOT_TOKEN && insecureDefaults && !e.ALLOW_INSECURE_DEV_KEYS) {
    issues.push('GORA_KEK, GORA_CALLBACK_KEY and GORA_HASH_KEY are required when TELEGRAM_BOT_TOKEN is set (generate each with: node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))"; ALLOW_INSECURE_DEV_KEYS=1 overrides for throwaway bots)');
  }
  if (e.INTEGRATIONS_PROVIDER === 'composio' && !e.COMPOSIO_API_KEY && !isTest) issues.push('COMPOSIO_API_KEY is required when INTEGRATIONS_PROVIDER=composio');
  if (e.STT_PROVIDER === 'groq' && !groqKey && !isTest) issues.push('GROQ_API_KEY is required when STT_PROVIDER=groq');
  if (e.STT_PROVIDER === 'openai' && !e.OPENAI_API_KEY && !isTest) issues.push('OPENAI_API_KEY is required when STT_PROVIDER=openai');
  if (e.GORA_MODE === 'webhook' && !e.TELEGRAM_WEBHOOK_SECRET && !isTest) issues.push('TELEGRAM_WEBHOOK_SECRET is required when GORA_MODE=webhook');
  // Never hand real voice notes to the fake transcriber (its canned text could create reminders nobody asked for).
  if (!isTest && e.STT_PROVIDER === 'fake' && e.TELEGRAM_BOT_TOKEN) issues.push('STT_PROVIDER=fake is refused with a real TELEGRAM_BOT_TOKEN (use auto, groq, openai or none)');

  let pricingOverrides: Record<string, unknown> | null = null;
  if (e.PRICING_OVERRIDES_JSON) {
    try {
      const v: unknown = JSON.parse(e.PRICING_OVERRIDES_JSON);
      if (v && typeof v === 'object' && !Array.isArray(v)) pricingOverrides = v as Record<string, unknown>;
      else issues.push('PRICING_OVERRIDES_JSON must be a JSON object');
    } catch {
      issues.push('PRICING_OVERRIDES_JSON is not valid JSON');
    }
  }
  const adminIds: number[] = [];
  for (const part of e.ADMIN_TG_IDS.split(',').map((x) => x.trim()).filter(Boolean)) {
    const n = Number(part);
    if (Number.isSafeInteger(n) && n > 0) adminIds.push(n);
    else issues.push(`ADMIN_TG_IDS: "${part}" is not a Telegram id`);
  }
  if (issues.length) throw new ConfigError(issues);

  const sttProvider: Config['providers']['stt'] = isTest ? 'fake' : e.STT_PROVIDER === 'auto' ? (groqKey ? 'groq' : e.OPENAI_API_KEY ? 'openai' : 'none') : e.STT_PROVIDER;
  const features: Features = Object.freeze({
    serverCompaction: e.FEATURE_SERVER_COMPACTION,
    clearAt: e.FEATURE_CLEAR_AT,
    cacheDiagnosis: e.FEATURE_CACHE_DIAGNOSIS,
    webFetchUrlSources: e.FEATURE_WEB_FETCH_URL_SOURCES,
    business: e.FEATURE_BUSINESS,
    businessRich: e.FEATURE_BUSINESS_RICH,
    guest: e.FEATURE_GUEST,
    groups: e.FEATURE_GROUPS,
    missions: e.FEATURE_MISSIONS,
    makeFile: e.FEATURE_MAKE_FILE,
    voiceReplies: e.FEATURE_VOICE_REPLIES,
    browser: e.FEATURE_BROWSER,
    groupParticipant: e.FEATURE_GROUP_PARTICIPANT,
  });
  const cfg: Config = {
    env: e.NODE_ENV,
    mode: isTest ? 'polling' : e.GORA_MODE,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    dataDir: e.DATA_DIR,
    keysDbPath: e.KEYS_DB_PATH,
    backupDir: e.BACKUP_DIR,
    logLevel: e.LOG_LEVEL,
    frameAncestors: e.MINIAPP_FRAME_ANCESTORS,
    telegram: {
      token: isTest ? (e.TELEGRAM_BOT_TOKEN ?? 'TEST_TOKEN') : e.TELEGRAM_BOT_TOKEN,
      webhookSecret: e.TELEGRAM_WEBHOOK_SECRET ?? (isTest ? 'test_webhook_secret' : ''),
      apiRoot: e.TELEGRAM_API_ROOT.replace(/\/+$/, ''),
      testEnv: e.TELEGRAM_TEST_ENV,
      adminIds,
    },
    secrets: {
      kek: kek ?? devKey('kek'),
      callbackKey: callbackKey ?? devKey('callback'),
      hashKey: hashKey ?? devKey('hash'),
      insecureDefaults,
    },
    anthropic: {
      ...(anthropicKey ? { apiKey: anthropicKey } : {}),
      model: resolved.profile.provider === 'anthropic' ? resolved.profile.models.main : (e.ANTHROPIC_MODEL_MAIN ?? e.ANTHROPIC_MODEL ?? PROVIDER_PROFILES.anthropic.models.main),
      sideModel: e.ANTHROPIC_SIDE_MODEL ?? PROVIDER_PROFILES.anthropic.models.fast,
      ...(e.ANTHROPIC_BASE_URL ? { baseURL: e.ANTHROPIC_BASE_URL } : {}),
      pricingOverrides,
    },
    groq: {
      ...(groqKey ? { apiKey: groqKey } : {}),
      tier: e.GROQ_TIER,
      models: { main: e.GROQ_MODEL_MAIN, fast: e.GROQ_MODEL_FAST, vision: e.GROQ_MODEL_VISION, sentinel: e.GROQ_MODEL_SENTINEL, guard: e.GROQ_MODEL_GUARD, stt: e.GROQ_MODEL_STT, tts: e.GROQ_MODEL_TTS },
      ttsVoice: e.GROQ_TTS_VOICE,
    },
    llm: { requested: resolved.requested, transport: isTest ? 'demo' : resolved.transport },
    profile: resolved.profile,
    features,
    providers: {
      integrations: isTest ? 'fake' : e.INTEGRATIONS_PROVIDER,
      stt: sttProvider,
      sttModel: e.STT_MODEL ?? (sttProvider === 'openai' ? 'gpt-transcribe' : e.GROQ_MODEL_STT),
      weather: isTest ? 'fake' : e.WEATHER_PROVIDER,
      fx: isTest ? 'fake' : e.FX_PROVIDER,
      geo: isTest ? 'fake' : e.GEO_PROVIDER,
      embeddings: isTest ? 'fake' : e.EMBEDDINGS_PROVIDER,
      browser: isTest ? 'none' : e.BROWSER_PROVIDER,
    },
    embeddings: { model: e.EMBEDDINGS_MODEL, dtype: 'q8', cacheDir: e.EMBEDDINGS_CACHE_DIR ?? join(e.DATA_DIR, 'models') },
    proactive: { tau: e.PROACTIVE_TAU },
    browser: { headless: e.BROWSER_HEADLESS, sandbox: e.BROWSER_SANDBOX, ...(e.BROWSER_EXECUTABLE_PATH ? { executablePath: e.BROWSER_EXECUTABLE_PATH } : {}) },
    composio: {
      authConfigs: {
        ...(e.COMPOSIO_AUTH_CONFIG_GCAL ? { gcal: e.COMPOSIO_AUTH_CONFIG_GCAL } : {}),
        ...(e.COMPOSIO_AUTH_CONFIG_GMAIL ? { gmail: e.COMPOSIO_AUTH_CONFIG_GMAIL } : {}),
      },
    },
    keys: {
      ...(e.COMPOSIO_API_KEY && !isTest ? { composio: e.COMPOSIO_API_KEY } : {}),
      ...(groqKey ? { groq: groqKey } : {}),
      ...(e.OPENAI_API_KEY && !isTest ? { openai: e.OPENAI_API_KEY } : {}),
    },
    userAgent: e.HTTP_USER_AGENT,
    routes: ROUTES,
    plans: PLANS,
    blockedDomains: BLOCKED_DOMAINS,
    limits: LIMITS,
    betas: BETAS,
  };
  return cfg;
}

/**
 * s07 (spec 07 B5): non-fatal configuration warnings, logged once at boot by app.ts. Never includes secret values.
 *  - a Composio key that is not a Platform project key (`ak_…`): a consumer key (`ck_…`) is rejected with 401 code 801.
 */
export function configWarnings(cfg: Config): string[] {
  const out: string[] = [];
  if (cfg.providers.integrations === 'composio' && !cfg.keys.composio) out.push('INTEGRATIONS_PROVIDER=composio without COMPOSIO_API_KEY: integrations are disabled');
  if (cfg.keys.composio && !cfg.keys.composio.startsWith('ak_')) out.push('COMPOSIO_API_KEY does not look like a Platform project key (ak_…); Composio rejects consumer keys (ck_…) with 401 code 801');
  return out;
}

/** Test/dev helper: a full Config from an env patch with NODE_ENV=test defaults, then a shallow-deep merge of overrides. */
export function testConfig(env: Env = {}, overrides: DeepPartial<Config> = {}): Config {
  return mergeConfig(loadConfig({ NODE_ENV: 'test', ...env }), overrides);
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] | Uint8Array | ((...a: never[]) => unknown) ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(base: Config, o: DeepPartial<Config>): Config {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(o)) {
    const b = (base as unknown as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && b && typeof b === 'object' && !Array.isArray(b) && !(b instanceof Uint8Array)) {
      out[k] = { ...(b as object), ...(v as object) };
    } else if (v !== undefined) out[k] = v;
  }
  return out as unknown as Config;
}
