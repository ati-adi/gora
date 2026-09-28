// agent/index.ts (WP3) — factories: createTransport (anthropic / groq / demo, 03 R1), createLlmGovernance (03 R6) and
// createAgentModule (runner, conversations, side calls, toolkit state + the agent's jobs and the grammar validator).
import type { Config } from '../config.ts';
import type { AgentModule, ChannelFactory, LlmTransport, Logger, Services } from '../contracts/index.ts';
import { ConfigError } from '../kernel/errors.ts';
import { createConversationService } from './conversations.ts';
import { createDemoTransport } from './demoTransport.ts';
import { createEngine } from './engine.ts';
import { createFallbackChannelFactory } from './fallbackChannel.ts';
import type { EngineRunner } from './engine.ts';
import type { EpochDeps } from './epochs.ts';
import { validateAppend } from './grammar.ts';
import { createGroqTransport, type MediaTextCache } from './groq/transport.ts';
import { registerAgentJobs } from './jobs.ts';
import type { BuildDeps } from './requestBuilder.ts';
import { createSideCalls } from './side.ts';
import type { SideCallsImpl } from './side.ts';
import { createToolkitState } from './toolkits.ts';
import type { ToolkitStateImpl } from './toolkits.ts';
import { createAnthropicTransport } from './transport.ts';

export { createLlmGovernance } from './groq/budget.ts';

/** AnthropicTransport (ANTHROPIC_API_KEY), GroqTransport (03 R1) or DemoTransport, per cfg.llm.transport. */
export function createTransport(cfg: Config, log: Logger, s: Services, o: { fetchImpl?: typeof fetch } = {}): LlmTransport {
  switch (cfg.llm.transport) {
    case 'anthropic': {
      if (!cfg.anthropic.apiKey) throw new ConfigError(['ANTHROPIC_API_KEY is required for the anthropic transport']);
      return createAnthropicTransport({
        apiKey: cfg.anthropic.apiKey,
        ...(cfg.anthropic.baseURL ? { baseURL: cfg.anthropic.baseURL } : {}),
        sideModel: cfg.anthropic.sideModel,
        profile: cfg.profile,
        clock: s.clock,
        log,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      });
    }
    case 'groq': {
      if (!s.groq) throw new ConfigError(['GROQ_API_KEY is required for the groq transport']);
      return createGroqTransport({
        client: s.groq,
        governor: s.rateGovernor,
        profile: cfg.profile,
        models: cfg.groq.models,
        clock: s.clock,
        log,
        // capabilities are built after the transport: dereference at call time only
        vision: () => (s.caps ? s.caps.vision : null),
        pdfText: () => (s.caps ? s.caps.pdfText : null),
        mediaCache: () => createMediaTextCache(s),
        getBlob: (id) => s.repos.messages.getBlob(id),
      });
    }
    default:
      if (cfg.env === 'production') throw new ConfigError(['no LLM key configured (the demo transport is refused in production)']);
      return createDemoTransport(s.clock);
  }
}

export interface AgentModuleImpl extends AgentModule {
  runner: EngineRunner;
  side: SideCallsImpl;
  toolkits: ToolkitStateImpl;
  /**
   * The ChannelFactory belongs to the Telegram module, which app.ts builds AFTER the agent module; app.ts hands it over
   * here right after createTelegramModule (contracts/services.ts AgentModule.attachChannels).
   */
  attachChannels(f: ChannelFactory): void;
}

export interface AgentModuleOptions {
  /** Tests (and a future app.ts) pass the channel factory directly. */
  channels?: ChannelFactory;
}

export function createAgentModule(s: Services, o: AgentModuleOptions = {}): AgentModuleImpl {
  let attached: ChannelFactory | null = o.channels ?? null;
  const channels = (): ChannelFactory => {
    if (attached) return attached;
    // No Telegram channel factory attached (tests without Telegram) → non-streaming fallback channel.
    fallback ??= createFallbackChannelFactory(s);
    return fallback;
  };
  let fallback: ChannelFactory | null = null;

  // grammar G1–G8 on every append (01 §5.3)
  s.repos.messages.setValidator((existing, added) => validateAppend(existing, added as Parameters<typeof validateAppend>[1]));

  const toolkits = createToolkitState(s.db, s.clock);
  const side = createSideCalls(s);
  const conversations = createConversationService(s);
  const build = (): BuildDeps => ({
    profile: s.config.profile,
    getBlob: (id) => s.repos.messages.getBlob(id),
    hmacUser: (v) => s.crypto.hmac('anthropic-user', v),
  });
  const epochs: EpochDeps = { s, build, side };
  const runner = createEngine({ s, channels, toolkits, epochs, build, excludeTexts: new Map() });
  registerAgentJobs(s, runner, epochs);

  return {
    runner,
    conversations,
    side,
    toolkits,
    attachChannels(f) {
      if (!o.channels) attached = f; // an explicitly injected factory (tests) wins
    },
  };
}

/**
 * Groq media-text cache (03 R1 "cached in kv by sha256"), made privacy-safe: the key is an HMAC over (DEK, sha) and the
 * value is sealed under that DEK — the conversation's epoch DEK — so /forget, /new wipe, incognito shredding and
 * /deletemydata make every derived description / PDF text unreadable. A shredded entry reads as a miss.
 */
export function createMediaTextCache(s: Services): MediaTextCache {
  const keyOf = (kind: 'vision' | 'pdf', sha: string, dek: string) => `${kind}:${s.crypto.hmac('content', `${dek}|${sha}`)}`;
  return {
    get(kind, sha, dek) {
      const key = keyOf(kind, sha, dek);
      const v = s.repos.kv.get<string>(key);
      if (typeof v !== 'string') return undefined;
      try {
        return s.crypto.openText(new Uint8Array(Buffer.from(v, 'base64')), `kv|value|${key}`);
      } catch {
        return undefined; // DEK destroyed (shredded) or corrupt → miss
      }
    },
    set(kind, sha, dek, text) {
      const key = keyOf(kind, sha, dek);
      try {
        s.repos.kv.set(key, Buffer.from(s.crypto.seal(dek, text, `kv|value|${key}`)).toString('base64'));
      } catch {
        /* DEK destroyed meanwhile: nothing to cache */
      }
    },
  };
}
