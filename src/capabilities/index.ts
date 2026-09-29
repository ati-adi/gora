// capabilities/index.ts (WP5) — createCapabilities(cfg, fetchImpl, s): every external capability behind its contract.
// Timing rule (04 §3): `s` is dereferenced only at call time, except the privacy-hook registrations below.
import type { Config } from '../config.ts';
import type { Capabilities, Clock, Logger, Services, TtsCapability, VisionCapability } from '../contracts/index.ts';
import { createAnthropicCodeFiles, codeFilesPrivacyHook } from './codeFiles.ts';
import { createGroqCodeFiles } from './codeFiles.groq.ts';
import { createDemoFx, createDemoGeo, createDemoSearch, createDemoWeather } from './demo.ts';
import { createHashEmbedder, createLocalEmbedder, createNoEmbedder } from './embedder.ts';
import { CapabilityUnavailableError, createGroqCaller } from './groq/common.ts';
import { createGroqGuard } from './groq/guard.ts';
import { createGroqSearch } from './groq/search.ts';
import { createGroqSentinel } from './groq/sentinel.ts';
import { createGroqStt } from './groq/stt.ts';
import { createGroqTts } from './groq/tts.ts';
import { createGroqVision } from './groq/vision.ts';
import { createLocationService, locationPrivacyHook } from './location.ts';
import { createMediaIngest } from './media.ts';
import { createPdfText } from './pdfText.ts';
import { createFxProvider, createGeoProvider, createWeatherProvider, type HttpDeps } from './providers.ts';
import { createSafeFetch } from './safeFetch.ts';
import { createNoStt, createOpenAiStt, createPlaceholderStt } from './stt.ts';
import { createBrowserCapability } from '../browser/capability.ts';

export interface CapabilityOptions {
  /**
   * 03 R5: the static LLM Sentinel policy (WP4's trust/llmSentinelPolicy.ts LLM_SENTINEL_POLICY). WP5 may not import
   * WP4 internals, so app.ts passes it (CONTRACT REQUEST). Without it the Sentinel capability returns null (the caller asks).
   */
  sentinelPolicy?: string | (() => string | null);
}

export function createCapabilities(cfg: Config, fetchImpl: typeof fetch, s: Services, o: CapabilityOptions = {}): Capabilities {
  // Lazy views of s.clock / s.log so nothing is dereferenced at factory time.
  const clock: Clock = {
    now: () => s.clock.now(),
    setTimeout: (fn, ms) => s.clock.setTimeout(fn, ms),
    clearTimeout: (h) => s.clock.clearTimeout(h),
    sleep: (ms, signal) => s.clock.sleep(ms, signal),
  };
  const log: Logger = {
    debug: (x, m) => s.log.debug({ mod: 'caps', ...x }, m),
    info: (x, m) => s.log.info({ mod: 'caps', ...x }, m),
    warn: (x, m) => s.log.warn({ mod: 'caps', ...x }, m),
    error: (x, m) => s.log.error({ mod: 'caps', ...x }, m),
    child: (b) => s.log.child({ mod: 'caps', ...b }),
  };
  const http: HttpDeps = { fetchImpl, clock, log, userAgent: cfg.userAgent, timeoutMs: cfg.limits.safeFetchTimeoutMs };
  const caller = createGroqCaller(s);
  const models = cfg.groq.models;
  const policy = typeof o.sentinelPolicy === 'function' ? o.sentinelPolicy : () => (typeof o.sentinelPolicy === 'string' ? o.sentinelPolicy : null);

  const stt = (() => {
    switch (cfg.providers.stt) {
      case 'groq':
        return createGroqStt(caller, () => cfg.providers.sttModel || models.stt);
      case 'openai':
        return cfg.keys.openai ? createOpenAiStt({ apiKey: cfg.keys.openai, model: cfg.providers.sttModel || 'gpt-transcribe', fetchImpl, clock, log }) : createNoStt();
      case 'fake':
        return createPlaceholderStt();
      default:
        return createNoStt();
    }
  })();

  const groqSearch = createGroqSearch(caller, () => s.profile.models.fast || models.fast);
  const demoSearch = createDemoSearch();
  const groqVision = createGroqVision(caller, () => models.vision);
  const vision: VisionCapability = {
    describe: (q) => (caller.available() ? groqVision.describe(q) : Promise.reject(new CapabilityUnavailableError('vision'))),
  };
  const groqTts = createGroqTts(caller, () => ({ model: models.tts, voice: cfg.groq.ttsVoice, maxChars: cfg.limits.ttsMaxChars }));
  const tts: TtsCapability = {
    speak: (text, opt) => (caller.available() ? groqTts.speak(text, opt) : Promise.reject(new CapabilityUnavailableError('tts'))),
  };

  const anthropicFiles = createAnthropicCodeFiles(s);
  const groqFiles = createGroqCodeFiles(s, caller, () => s.profile.models.fast || models.fast);
  const location = createLocationService({
    get db() {
      return s.db;
    },
    get crypto() {
      return s.crypto;
    },
    clock,
    log,
  });

  // Factory-time registrations allowed by the timing rule.
  s.privacyHooks.push(locationPrivacyHook(location));
  s.privacyHooks.push(codeFilesPrivacyHook(s, anthropicFiles));

  return {
    stt,
    weather: cfg.providers.weather === 'fake' ? createDemoWeather(clock) : createWeatherProvider(http),
    fx: cfg.providers.fx === 'fake' ? createDemoFx(clock) : createFxProvider(http),
    geo: cfg.providers.geo === 'fake' ? createDemoGeo() : createGeoProvider(http),
    safeFetch: createSafeFetch({
      clock, log, userAgent: cfg.userAgent, publicUrl: cfg.publicUrl, blockedDomains: cfg.blockedDomains,
      timeoutMs: cfg.limits.safeFetchTimeoutMs, maxBytes: cfg.limits.safeFetchMaxBytes, maxRedirects: cfg.limits.safeFetchMaxRedirects,
    }),
    codeFiles: { make: (p) => (s.profile.provider === 'groq' ? groqFiles.make(p) : anthropicFiles.make(p)) },
    media: createMediaIngest(s),
    search: {
      search: (q) => (caller.available() ? groqSearch.search(q) : demoSearch.search(q)),
      open: (q) => (caller.available() ? groqSearch.open(q) : demoSearch.open(q)),
    },
    vision,
    pdfText: createPdfText(),
    tts,
    guard: createGroqGuard(caller, () => models.guard, log),
    llmSentinel: createGroqSentinel(caller, () => models.sentinel, policy, log),
    location,
    // spec 05 B2 (lazy: the model loads on the first embed, never at boot)
    embedder:
      cfg.providers.embeddings === 'local'
        ? createLocalEmbedder({ model: cfg.embeddings.model, cacheDir: cfg.embeddings.cacheDir, clock, log })
        : cfg.providers.embeddings === 'fake'
          ? createHashEmbedder()
          : createNoEmbedder(),
    // spec 07 A1 (lazy: Chromium launches on the first openSession, never at boot); tests inject FakeBrowser via AppOptions.browser
    browser: createBrowserCapability(cfg, { clock, log }),
  };
}
