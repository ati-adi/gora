// agent/pricing.ts (WP3) — cost accounting in micro-USD (01 §13, 03 R6). Prices are USD per 1M tokens, so
// costMicros = Σ tokens × pricePerMTok. PRICING_OVERRIDES_JSON (config.anthropic.pricingOverrides) may override any
// model's row: {"<model>": {"input":…, "output":…, "cacheRead":…, "cacheWrite5m":…, "cacheWrite1h":…}}.
import type { BetaUsage, UsageNumbers } from '../contracts/index.ts';

export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

const OPUS5: ModelPrice = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 };
const flat = (input: number, output: number): ModelPrice => ({ input, output, cacheRead: input, cacheWrite5m: input, cacheWrite1h: input });

export const PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-opus-5': OPUS5,
  // 03 R6 Groq prices (no caching observed on the free tier: cache rows = input price)
  'openai/gpt-oss-120b': flat(0.15, 0.6),
  'openai/gpt-oss-20b': flat(0.075, 0.3),
  'qwen/qwen3.8-27b': flat(0.8, 4),
  'openai/gpt-oss-safeguard-20b': flat(0.075, 0.3),
  'meta-llama/llama-prompt-guard-2-86m': flat(0.04, 0.04),
  'meta-llama/llama-prompt-guard-2-22m': flat(0.04, 0.04),
});
/** Server web search: $10 per 1 000 requests → 10 000 micro-USD each. */
export const WEB_SEARCH_MICROS = 10_000;
/** whisper-large-v3-turbo: $0.04 per audio hour, min 10 s billed. */
export const STT_USD_PER_HOUR = 0.04;
/** Orpheus TTS: $22 per 1M characters. */
export const TTS_USD_PER_MCHAR = 22;

/** 'groq:<model>' (ConversationRow.model) → '<model>'. */
export function bareModel(model: string): string {
  return model.startsWith('groq:') ? model.slice(5) : model;
}

function isPrice(v: unknown): v is Partial<ModelPrice> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The price row for a model: override > table > family default (claude-* → Opus 5; anything else → gpt-oss-120b). */
export function priceFor(model: string, overrides?: Record<string, unknown> | null): ModelPrice {
  const m = bareModel(model);
  const base = PRICES[m] ?? (m.startsWith('claude') ? OPUS5 : PRICES['openai/gpt-oss-120b']!);
  const o = overrides?.[m];
  if (!isPrice(o)) return base;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : d);
  return { input: num(o.input, base.input), output: num(o.output, base.output), cacheRead: num(o.cacheRead, base.cacheRead), cacheWrite5m: num(o.cacheWrite5m, base.cacheWrite5m), cacheWrite1h: num(o.cacheWrite1h, base.cacheWrite1h) };
}

export function costMicros(model: string, u: UsageNumbers, overrides?: Record<string, unknown> | null): number {
  const p = priceFor(model, overrides);
  const c = u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h + u.webSearchRequests * WEB_SEARCH_MICROS;
  return Math.round(c);
}

/** BetaUsage → UsageNumbers (⚠U17: the web_fetch counter is read optionally and defaults to 0). */
export function usageFromBeta(u: BetaUsage | null | undefined): UsageNumbers {
  const cc = (u?.cache_creation ?? null) as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  const stu = (u?.server_tool_use ?? null) as { web_search_requests?: number; web_fetch_requests?: number } | null;
  const w5 = cc?.ephemeral_5m_input_tokens ?? 0;
  const w1 = cc?.ephemeral_1h_input_tokens ?? 0;
  const total = u?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    // Without the per-TTL breakdown every write is ours: all markers are 1 h (01 §5.2).
    cacheWrite5m: cc ? w5 : 0,
    cacheWrite1h: cc ? w1 : total,
    webSearchRequests: num0(stu?.web_search_requests),
    webFetchRequests: num0(stu?.web_fetch_requests),
  };
}

const num0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Cost of one Anthropic response: from usage.iterations when present (per-attempt billing truth, 01 §13), else from
 * the top-level usage against the served model.
 */
export function costFromBeta(model: string, u: BetaUsage | null | undefined, overrides?: Record<string, unknown> | null): number {
  const its = (u?.iterations ?? null) as Array<{ model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }> | null;
  const top = usageFromBeta(u);
  if (!its || its.length === 0) return costMicros(model, top, overrides);
  let c = 0;
  for (const it of its) {
    c += costMicros(it.model ?? model, {
      inputTokens: num0(it.input_tokens), outputTokens: num0(it.output_tokens), cacheReadTokens: num0(it.cache_read_input_tokens),
      cacheWrite5m: 0, cacheWrite1h: num0(it.cache_creation_input_tokens), webSearchRequests: 0, webFetchRequests: 0,
    }, overrides);
  }
  return c + top.webSearchRequests * WEB_SEARCH_MICROS;
}

export function sttCostMicros(seconds: number): number {
  return Math.round((Math.max(10, seconds) / 3600) * STT_USD_PER_HOUR * 1_000_000);
}

export function ttsCostMicros(chars: number): number {
  return Math.round(chars * TTS_USD_PER_MCHAR);
}
