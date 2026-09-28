// capabilities/groq/common.ts (WP5) — shared plumbing for the Groq capabilities (03 R4-R7): the lazily resolved single
// client (s.groq), the RateGovernor (acquire before, observe after), SDK error mapping to kernel errors, and llm_calls /
// usage accounting attributed through CallMeta.
import { APIConnectionError, APIError, APIUserAbortError } from 'groq-sdk';
import type { CallMeta, GroqClient, GroqRole, LlmCallPurpose, Priority, Services, UsageNumbers } from '../../contracts/index.ts';
import { ZERO_USAGE } from '../../contracts/llm.ts';
import { AbortedError, BadRequestLlmError, errorMessage, TransientLlmError } from '../../kernel/errors.ts';

export class CapabilityUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} is unavailable (no Groq client)`);
    this.name = 'CapabilityUnavailableError';
  }
}

/** Approximate Groq list prices (USD per 1M tokens) for the per-user cost cap. Unknown models cost 0. */
const PRICES: Record<string, { in: number; out: number }> = {
  'openai/gpt-oss-20b': { in: 0.075, out: 0.3 },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.6 },
  'openai/gpt-oss-safeguard-20b': { in: 0.075, out: 0.3 },
  'qwen/qwen3.8-27b': { in: 0.8, out: 4 },
  'meta-llama/llama-prompt-guard-2-86m': { in: 0.04, out: 0.04 },
  'meta-llama/llama-prompt-guard-2-22m': { in: 0.03, out: 0.03 },
};
export const STT_USD_PER_HOUR = 0.04;
export const TTS_USD_PER_MCHAR = 22;

export function tokenCostMicros(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model];
  return p ? Math.round(inTok * p.in + outTok * p.out) : 0;
}

export function mapGroqError(e: unknown): Error {
  if (e instanceof AbortedError || e instanceof TransientLlmError || e instanceof BadRequestLlmError) return e;
  if (e instanceof APIUserAbortError) return new AbortedError('groq call aborted');
  if (e instanceof APIConnectionError) return new TransientLlmError('connection');
  if (e instanceof APIError) {
    const st = e.status ?? 0;
    const ra = Number(e.headers?.get?.('retry-after') ?? NaN);
    const o = { retryAfterMs: Number.isFinite(ra) ? ra * 1000 : null, requestId: e.headers?.get?.('x-request-id') ?? null };
    if (st === 429) return new TransientLlmError('rate_limit', undefined, o);
    if (st === 498 || st === 503 || st === 529) return new TransientLlmError('overloaded', undefined, o);
    if (st >= 500) return new TransientLlmError('server', undefined, o);
    const code = (e.error as { error?: { code?: string } } | undefined)?.error?.code ?? null;
    return new BadRequestLlmError(`groq ${st}${code ? ` ${code}` : ''}`, o.requestId, code);
  }
  return e instanceof Error ? e : new Error(errorMessage(e));
}

export interface GroqCallSpec<T> {
  role: GroqRole;
  model: string;
  purpose: LlmCallPurpose;
  estTokens: number;
  priority?: Priority;
  meta?: CallMeta;
  signal?: AbortSignal;
  /** Performs the request with the model the governor chose; must use `.withResponse()`. */
  call(client: GroqClient, model: string): Promise<{ data: T; response: Response }>;
  /** Usage for accounting (tokens), or a direct cost. */
  usage?(data: T): { inputTokens?: number; outputTokens?: number; costMicros?: number };
}

export interface GroqCaller {
  available(): boolean;
  run<T>(spec: GroqCallSpec<T>): Promise<T>;
}

export function createGroqCaller(s: Services): GroqCaller {
  const client = (): GroqClient | null => {
    try {
      return s.groq ?? null;
    } catch {
      return null;
    }
  };
  function record(spec: GroqCallSpec<unknown>, served: string, u: UsageNumbers, costMicros: number, latencyMs: number, errorClass: string | null, requestId: string | null): void {
    const meta = spec.meta ?? {};
    try {
      s.repos.runs.recordLlmCall({
        runId: meta.runId ?? null, conversationId: meta.conversationId ?? null, epoch: null, userId: meta.userId ?? null, purpose: spec.purpose,
        requestHmac: s.crypto.hmac('content', `${spec.purpose}:${spec.model}:${s.clock.now()}`), modelRequested: spec.model, modelServed: served,
        servedByFallback: served !== spec.model, stopReason: null, refusalCategory: null, usage: u, iterations: null, costMicros, latencyMs, ttftMs: null,
        requestId, errorClass, raw: null,
      });
    } catch (e) {
      s.log.debug({ err: errorMessage(e), purpose: spec.purpose }, 'llm_calls record skipped');
    }
    if (meta.userId && (costMicros > 0 || u.inputTokens > 0)) {
      try {
        s.quotas.recordUsage(meta.userId, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: 0, costMicros });
      } catch (e) {
        s.log.debug({ err: errorMessage(e) }, 'usage record skipped');
      }
    }
  }
  return {
    available: () => client() !== null,
    async run<T>(spec: GroqCallSpec<T>): Promise<T> {
      const c = client();
      if (!c) throw new CapabilityUnavailableError(spec.purpose);
      const priority = spec.priority ?? 'background';
      const { model } = await s.rateGovernor.acquire({ role: spec.role, model: spec.model, estTokens: Math.max(1, Math.ceil(spec.estTokens)), priority, ...(spec.signal ? { signal: spec.signal } : {}) });
      const t0 = s.clock.now();
      try {
        const { data, response } = await spec.call(c, model);
        const u = spec.usage?.(data) ?? {};
        const usage: UsageNumbers = { ...ZERO_USAGE, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
        s.rateGovernor.observe(model, { headers: response.headers, status: response.status, usage: { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens } });
        record(spec as GroqCallSpec<unknown>, model, usage, u.costMicros ?? tokenCostMicros(model, usage.inputTokens, usage.outputTokens), s.clock.now() - t0, null, response.headers.get('x-request-id'));
        return data;
      } catch (raw) {
        const e = mapGroqError(raw);
        const headers = raw instanceof APIError ? (raw.headers ?? null) : null;
        const status = raw instanceof APIError ? raw.status : undefined;
        s.rateGovernor.observe(model, { headers, ...(status !== undefined ? { status } : {}) });
        record(spec as GroqCallSpec<unknown>, model, { ...ZERO_USAGE }, 0, s.clock.now() - t0, e.name, null);
        throw e;
      }
    },
  };
}
