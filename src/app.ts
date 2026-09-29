// src/app.ts (WP0) — composition root: createApp(opts) → Services, with two-phase wiring (01 §4.4, §4.5).
//
// Phase 1 (build): `const s = {} as Services` is filled in dependency order. Factories receive `s` and MUST only
// dereference `s.<x>` at call time — except for the factory-time registrations listed on `Factories`
// (contracts/services.ts): job handlers (s.scheduler), callbacks (s.telegram.callbacks), context providers
// (s.contextProviders), privacy hooks (s.privacyHooks), run hooks (s.runHooks), outbox sent hooks
// (s.telegram.outbox.onSent), quota counters (s.quotas.registerCounter), system cron upserts (s.scheduler.schedule with a
// 'sys:<kind>' dedupeKey) and UI strings (s.strings, built first). Those registries therefore exist before any
// module factory runs: the scheduler and quotas are built right after the core repos, and `s.telegram` starts as a
// pre-gateway exposing only `callbacks` and a buffering `outbox.onSent` until the Telegram module replaces it with the
// real gateway (same callback registry; the buffered sent hooks are handed over through TelegramModuleOptions.sentHooks).
// Phase 2 (start): handlers registered, ingress started, recovery, scheduler/outbox/dispatcher started.
import { join } from 'node:path';
import type { Hono } from 'hono';
import { configWarnings, type Config } from './config.ts';
import type {
  BrowserCapability, BusinessModule, CallbackRegistry, Clock, Db, Factories, IntegrationProvider, KeyStore, LlmTransport, Logger, Random, SentRef, Services, SurfacesModule, TelegramGateway, TelegramModule, TelegramModuleOptions, ToolSpec,
} from './contracts/index.ts';
import { KeyStoreError, keyStoreInitialized, openKeyStore } from './db/keystore.ts';
import { createCrypto } from './db/crypto.ts';
import { createCoreRepos } from './db/repos/index.ts';
import { acquireLock, openDb } from './db/sqlite.ts';
import { migrate } from './db/migrate.ts';
import { createLedger } from './ledger/index.ts';
import { createQuotaService } from './billing/index.ts';
import { createPrivacyService } from './privacy/index.ts';
import { createAgentModule, createLlmGovernance, createTransport } from './agent/index.ts';
import { createTrustModule } from './trust/index.ts';
import { createToolRegistry } from './tools/index.ts';
import { TOOLS as TRUST_TOOLS } from './trust/tools.ts';
import { LLM_SENTINEL_POLICY } from './trust/llmSentinelPolicy.ts';
import { TOOLS as MEMORY_TOOLS } from './memory/tools.ts';
import { TOOLS as REMINDER_TOOLS } from './reminders/tools.ts';
import { TOOLS as MISSION_TOOLS } from './missions/tools.ts';
import { TOOLS as SURFACE_TOOLS } from './surfaces/tools.ts';
import { TOOLS as BUSINESS_TOOLS } from './surfaces/business/tools.ts';
import { TOOLS as BROWSER_TOOLS } from './browser/tools.ts';
import { TOOLS as GROUP_TOOLS } from './groups/tools.ts';
import { createBrowserModule } from './browser/index.ts';
import { createGroupModule } from './groups/index.ts';
import { createCapabilities } from './capabilities/index.ts';
import { createIntegrationService } from './integrations/index.ts';
import { createMemoryService } from './memory/index.ts';
import { createProfileService } from './memory/profile.ts';
import { createBehaviourModule } from './behaviour/index.ts';
import { systemRandom } from './kernel/random.ts';
import { createScheduler } from './scheduler/index.ts';
import { createReminderModule } from './reminders/index.ts';
import { createProactiveModule } from './proactive/index.ts';
import { createMissionModule } from './missions/index.ts';
import { createTelegramModule } from './telegram/index.ts';
import { createSurfaces } from './surfaces/index.ts';
import { createBusinessModule } from './surfaces/business/index.ts';
import { createStrings } from './surfaces/strings.ts';
import { createHttpApp, drainHttp } from './http/index.ts';
import { systemClock } from './kernel/clock.ts';
import { isNotBuilt } from './kernel/errors.ts';
import { createLogger } from './kernel/log.ts';
import { createCallbackRegistry } from './kernel/registries.ts';
import { createGroqClient } from './kernel/groqClient.ts';

/** The production factory table (01 §4.4). Tests may override any entry. */
export const REAL_FACTORIES: Factories = {
  createStrings, openKeyStore, createCrypto, createCoreRepos, createLedger, createQuotaService, createPrivacyService,
  createLlmGovernance, createTransport, createCapabilities, createIntegrationService, createToolRegistry,
  createTrustModule, createMemoryService, createScheduler, createReminderModule, createProactiveModule, createMissionModule,
  createProfileService, createBehaviourModule, createGroupModule, createBrowserModule, createAgentModule, createTelegramModule, createBusinessModule, createSurfaces, createHttpApp,
};

/** Tool specs owned by WP4, WP6, WP7 and the s07 sets BR/GR (contracts/tools.ts TOOL_FILES); WP5's registry adds its own. */
export const EXTERNAL_TOOLS: readonly ToolSpec[] = Object.freeze([...TRUST_TOOLS, ...MEMORY_TOOLS, ...REMINDER_TOOLS, ...MISSION_TOOLS, ...SURFACE_TOOLS, ...BUSINESS_TOOLS, ...BROWSER_TOOLS, ...GROUP_TOOLS]);

export interface AppOptions {
  config: Config;
  clock?: Clock;
  log?: Logger;
  /** Friend-mode (spec 05 §E): the only randomness source (tests pass kernel/random.ts seededRandom). Default systemRandom(). */
  random?: Random;
  /** Injected into every adapter (capabilities, Groq client, Telegram file downloads). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Tests inject a ScriptedTransport; otherwise createTransport(cfg) picks anthropic / groq / demo. */
  transport?: LlmTransport;
  integrationProvider?: IntegrationProvider;
  /** s07 (spec 07 A6): replaces caps.browser (tests pass test/harness/fakeBrowser.ts FakeBrowser). */
  browser?: BrowserCapability;
  telegram?: Omit<TelegramModuleOptions, 'callbacks' | 'sentHooks'>;
  /** Replace individual factories (tests). */
  factories?: Partial<Factories>;
  /** Test harness only: when a factory throws NotBuiltError, use this replacement instead. Never set in production. */
  notBuiltFallback?: Partial<Factories>;
  /** Take the single-writer lockfile (default true). */
  lock?: boolean;
}

export interface App {
  s: Services;
  tg: TelegramModule;
  http: Hono;
  surfaces: SurfacesModule;
  /** WP7b's Secretary module (its `business` is also `s.business`). */
  business: BusinessModule;
  keyStore: KeyStore;
  /** Factory names that fell back to `notBuiltFallback` (tests). */
  fallbacksUsed: readonly string[];
  /** Boot steps 7–9: handlers are already registered; starts ingress, recovers runs, starts scheduler/outbox/dispatcher. */
  start(): Promise<void>;
  /** Step 10 (SIGTERM): stop ingress and claiming, abort streams, wait ≤ graceMs for tools, drain outbox ≤ 5 s, close DBs. */
  stop(o?: { graceMs?: number; drainMs?: number }): Promise<void>;
}

/** True when gora.db already holds rows sealed under keys.db DEKs (users, conversations, ledger). */
function hasSealedData(db: Db): boolean {
  const any = (table: string) => db.prepare(`SELECT 1 AS x FROM ${table} LIMIT 1`).get() !== undefined;
  return any('users') || any('conversations') || any('ledger');
}

export async function createApp(opts: AppOptions): Promise<App> {
  const cfg = opts.config;
  const clock = opts.clock ?? systemClock();
  const log = opts.log ?? createLogger({ level: cfg.logLevel });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const factories: Factories = { ...REAL_FACTORIES, ...opts.factories };
  const fallbacksUsed: string[] = [];
  for (const w of configWarnings(cfg)) log.warn({ config: true }, w); // s07 B5

  /** Calls a factory; on NotBuiltError uses the configured fallback (test harness) or rethrows. */
  function make<K extends keyof Factories>(k: K, ...args: Parameters<Factories[K]>): ReturnType<Factories[K]> {
    const call = (f: Factories[K]) => (f as (...a: Parameters<Factories[K]>) => ReturnType<Factories[K]>)(...args);
    const fb = opts.notBuiltFallback?.[k];
    const useFallback = () => {
      fallbacksUsed.push(k);
      return call(fb as Factories[K]);
    };
    try {
      const r = call(factories[k]);
      if (fb && r instanceof Promise) {
        const p = r as Promise<unknown>;
        return p.catch((e: unknown) => (isNotBuilt(e) ? (useFallback() as unknown) : Promise.reject(e))) as ReturnType<Factories[K]>;
      }
      return r;
    } catch (e) {
      if (fb && isNotBuilt(e)) return useFallback();
      throw e;
    }
  }

  // ── step 2: gora.db (+ lockfile) and migrations
  const dbPath = join(cfg.dataDir, 'gora.db');
  const release = opts.lock === false ? () => {} : acquireLock(dbPath + '.lock');
  const cleanups: Array<() => void> = [release];
  try {
    const db = openDb(dbPath);
    cleanups.unshift(() => db.close());
    const applied = migrate(db, { now: clock.now() });
    if (applied.length) log.info({ applied }, 'migrations applied');

    // ── step 3: keys.db. A brand-new keys.db next to a gora.db that already holds sealed rows means the keys volume is
    // not mounted (or KEYS_DB_PATH is wrong): booting would fail every existing user and seal new data under
    // throw-away DEKs, so refuse to start instead.
    if (factories.openKeyStore === openKeyStore && cfg.keysDbPath !== ':memory:' && !keyStoreInitialized(cfg.keysDbPath) && hasSealedData(db)) {
      throw new KeyStoreError(`keys.db at ${cfg.keysDbPath} is missing or new, but gora.db already holds encrypted data: mount or restore the original keys.db (KEYS_DB_PATH) before starting. Refusing to boot.`);
    }
    const keyStore = make('openKeyStore', cfg.keysDbPath, cfg.secrets.kek);
    cleanups.unshift(() => keyStore.close());
    if (cfg.secrets.insecureDefaults) log.warn({ env: cfg.env }, 'using insecure development keys (GORA_KEK / GORA_CALLBACK_KEY / GORA_HASH_KEY not set)');

    // ── step 4: services, phase 1
    const s = {} as Services;
    s.config = cfg;
    s.clock = clock;
    s.log = log;
    s.random = opts.random ?? systemRandom();
    s.db = db;
    s.profile = cfg.profile;
    s.strings = make('createStrings'); // first: usable by every later factory
    s.keyStore = keyStore;
    s.privacyHooks = [];
    s.contextProviders = [];
    s.runHooks = [];
    s.missionHooks = []; // s07: factory-time registry (BR)
    const callbacks = createCallbackRegistry(log.child({ mod: 'callbacks' }));
    const sentHooks: NonNullable<TelegramModuleOptions['sentHooks']> = [];
    s.telegram = preGateway(callbacks, sentHooks);
    s.crypto = make('createCrypto', keyStore, cfg.secrets.hashKey);
    s.repos = make('createCoreRepos', db, s.crypto, clock);
    s.scheduler = make('createScheduler', s); // early: every later factory may register job handlers
    s.quotas = make('createQuotaService', s); // early: WP6 registers the mission/watcher counters at factory time
    s.ledger = make('createLedger', s);
    s.privacy = make('createPrivacyService', s);
    s.groq = cfg.keys.groq ? createGroqClient({ apiKey: cfg.keys.groq, fetchImpl }) : null;
    const gov = make('createLlmGovernance', s);
    s.rateGovernor = gov.governor;
    s.llmBudget = gov.budget;
    s.transport = opts.transport ?? make('createTransport', cfg, log.child({ mod: 'transport' }), s, { fetchImpl });
    const caps = make('createCapabilities', cfg, fetchImpl, s, { sentinelPolicy: LLM_SENTINEL_POLICY });
    s.caps = opts.browser ? { ...caps, browser: opts.browser } : caps;
    s.capabilities = s.caps;
    s.integrations = make('createIntegrationService', s, opts.integrationProvider, { fetchImpl });
    s.location = s.caps.location;
    s.registry = make('createToolRegistry', cfg.profile, EXTERNAL_TOOLS, { webFetchUrlSources: cfg.features.webFetchUrlSources });
    const trust = make('createTrustModule', s);
    s.sentinel = trust.sentinel;
    s.approvals = trust.approvals;
    s.executor = trust.executor;
    s.undo = trust.undo;
    s.stepup = trust.stepup;
    s.untrusted = trust.untrusted;
    s.grants = trust.grants;
    s.trustedTargets = trust.trustedTargets;
    s.memory = make('createMemoryService', s);
    s.userProfile = make('createProfileService', s); // spec 05 B4
    const rem = make('createReminderModule', s);
    s.reminders = rem.reminders;
    s.todos = rem.todos;
    const pro = make('createProactiveModule', s);
    s.nudges = pro.nudges;
    s.brief = pro.brief;
    s.commitments = pro.commitments;
    const mis = make('createMissionModule', s);
    s.missions = mis.missions;
    s.watchers = mis.watchers;
    const beh = make('createBehaviourModule', s); // spec 05 §C
    s.signals = beh.signals;
    s.proactivePolicy = beh.policy;
    s.groupAgent = make('createGroupModule', s).participation; // spec 07 §C
    s.browserTasks = make('createBrowserModule', s).tasks; // spec 07 §A (browse tasks run as missions)
    const agent = make('createAgentModule', s);
    s.runner = agent.runner;
    s.conversations = agent.conversations;
    s.side = agent.side;
    s.toolkits = agent.toolkits;

    // ── step 5–6: Telegram (getMe unless botInfo is given; flags; commands/menu when their hash changed)
    const tg = await make('createTelegramModule', s, { ...opts.telegram, fetchImpl: opts.telegram?.fetchImpl ?? fetchImpl, callbacks, sentHooks });
    s.telegram = tg.gateway;
    agent.attachChannels?.(tg.channels); // live streaming replies (WP2 ChannelFactory → WP3 engine)
    const business = make('createBusinessModule', s); // WP7b, before WP7a's factory so s.business is set
    s.business = business.business;
    const surfaces = make('createSurfaces', s);
    s.payments = surfaces.payments;
    s.notices = surfaces.notices;
    s.deepLinks = surfaces.deepLinks;
    s.choices = surfaces.choices;
    s.groups = surfaces.groups;
    s.guests = surfaces.guests;

    // ── step 7: handlers, HTTP app (listening is main.ts's job)
    surfaces.registerHandlers(tg.bot);
    business.registerHandlers(tg.bot);
    const http = make('createHttpApp', s, tg);

    let started = false;
    let stopped = false;
    return {
      s, tg, http, surfaces, business, keyStore, fallbacksUsed,
      async start() {
        if (started) return;
        started = true;
        await tg.startIngress(); // step 8
        await s.runner.recover(); // step 9
        s.scheduler.start();
        s.telegram.outbox.start();
        tg.dispatcher.start();
      },
      async stop(o = {}) {
        if (stopped) return;
        stopped = true;
        const graceMs = o.graceMs ?? 20_000;
        const drainMs = o.drainMs ?? 5_000;
        const step = async (name: string, f: () => Promise<unknown> | unknown) => {
          try {
            await f();
          } catch (e) {
            log.error({ step: name, err: e }, 'shutdown step failed');
          }
        };
        // Mini App API first: new requests get 503, in-flight ones finish before the runner stops and the databases
        // close (they would otherwise run against a shutting-down runner, then fail on a closed db).
        await step('http', async () => {
          const left = await drainHttp(s, Math.min(graceMs, 10_000));
          if (left > 0) log.warn({ inflight: left }, 'shutdown: HTTP requests still running after the drain timeout');
        });
        if (started) {
          await step('ingress', () => tg.stopIngress()); // webhook → 503, polling stops
          await step('scheduler', () => s.scheduler.stop());
          await step('runner', () => s.runner.shutdown(graceMs)); // streams aborted ('shutdown'), tools ≤ graceMs
          await step('browser', () => withTimeout(s.caps.browser.closeAll(), 5_000, clock)); // s07: ephemeral contexts
          await step('dispatcher', () => tg.dispatcher.stop());
          await step('outbox', () => withTimeout(s.telegram.outbox.flush(), drainMs, clock));
          await step('outbox.stop', () => s.telegram.outbox.stop());
        }
        for (const c of cleanups) await step('close', c);
      },
    };
  } catch (e) {
    for (const c of cleanups) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}

/**
 * Until the Telegram module exists, `s.telegram` only offers the callback registry and `outbox.onSent`, both for
 * factory-time registration. onSent registrations are buffered in `sentHooks`, which createTelegramModule installs on
 * the real outbox before it starts sending.
 */
export function preGateway(callbacks: CallbackRegistry, sentHooks: NonNullable<TelegramModuleOptions['sentHooks']>): TelegramGateway {
  const early = (what: string) => new Error(`s.telegram.${what} used before the Telegram module was built (dereference s.telegram at call time)`);
  const outbox = new Proxy(
    { onSent: (refKind: string, hook: (refId: string, sent: SentRef[]) => void) => void sentHooks.push({ refKind, hook }) },
    {
      get(target, prop) {
        if (prop === 'onSent') return target.onSent;
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw early(`outbox.${String(prop)}`);
      },
    },
  );
  return new Proxy({ callbacks } as unknown as TelegramGateway, {
    get(_target, prop) {
      if (prop === 'callbacks') return callbacks;
      if (prop === 'outbox') return outbox;
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      throw early(String(prop));
    },
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, clock: Clock): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const h = clock.setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clock.clearTimeout(h);
        resolve(v);
      },
      (e: unknown) => {
        clock.clearTimeout(h);
        reject(e);
      },
    );
  });
}
