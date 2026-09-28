// agent/groq/transport.ts (WP3) — 03 R1 GroqTransport implements LlmTransport over groq-sdk chat.completions.
//  - stream(): MainRequest → translateRequest (map.ts) → hard ceiling (fitToBudget) → RateGovernor.acquire → streamed
//    chat.completions → BetaMessage (text, then at most one tool_use). Reasoning deltas never reach onText.
//  - Error mapping (03 R1): 429 → governor penalty + retry through the fallback chain, TransientLlmError('rate_limit') when
//    exhausted; 413 → one retry with the budget shrunk by 30 %, then BadRequestLlmError('too_large'); tool_use_failed
//    (HTTP 400 or SSE `event: error` after reasoning) → onBlockStart({index:-1,type:'retry'}) + one retry with a system
//    note naming the valid tools; 5xx / 498 / connection → TransientLlmError.
//  - parse(): GROQ fast model, response_format json_schema (strict when expressible), nulls → undefined, zod-validated,
//    one retry on output_parse_failed / json_validate_failed / invalid output, then parsed:null.
//  - files.*: an in-process no-op store (nothing on the Groq path uses a Files API).
import { createHash } from 'node:crypto';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'groq-sdk';
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { z } from 'zod';
import type { Clock, GroqClient, GroqRole, LlmTransport, Logger, MainRequest, Priority, ProviderProfile, RateGovernor, SideRequest, SideResult, StreamHandlers, StreamResult, TransportOpts, UsageNumbers, VisionCapability, PdfTextCapability } from '../../contracts/index.ts';
import { ZERO_USAGE } from '../../contracts/llm.ts';
import { AbortedError, BadRequestLlmError, TransientLlmError, errorMessage } from '../../kernel/errors.ts';
import { CHARS_PER_TOKEN, estimateChatTokens, estimateTokens } from '../../kernel/tokens.ts';
import { ChunkAccumulator, TRUNCATED_MARK, buildStreamParams, estimateTranslated, fitToBudget, toolUseFailedNote, translateRequest, usageNumbers } from './map.ts';
import type { Translated } from './map.ts';
import { nullsToUndefined, toGroqStrictSchema } from './strictSchema.ts';

type Block = Record<string, unknown>;

export interface GroqModels { main: string; fast: string; vision: string; sentinel: string; guard: string; stt: string; tts: string }

/** DEK-scoped cache of text derived from media (agent/index.ts implements it over kv + crypto). */
export interface MediaTextCache {
  get(kind: 'vision' | 'pdf', sha: string, dek: string): string | undefined;
  set(kind: 'vision' | 'pdf', sha: string, dek: string, text: string): void;
}

export interface GroqTransportDeps {
  client: GroqClient;
  governor: RateGovernor;
  profile: ProviderProfile;
  models: GroqModels;
  clock: Clock;
  log: Logger;
  /** Late-bound (capabilities are built after the transport): image → text. */
  vision?: () => VisionCapability | null | undefined;
  /** Late-bound: PDF → text. */
  pdfText?: () => PdfTextCapability | null | undefined;
  /**
   * Late-bound cache for vision / pdf text by sha256 (kv keys `vision:…`, `pdf:…`). Entries are scoped to and sealed
   * under `TransportOpts.dek` (the epoch DEK), so they are crypto-shredded with the conversation / user.
   */
  mediaCache?: () => MediaTextCache | null | undefined;
  /** Resolves `@blob:<id>` sources when the request was not hydrated. */
  getBlob?: (id: string) => { mime: string; bytes: Uint8Array } | undefined;
  /** Ids for tool calls / messages lacking one (tests pass a deterministic generator). */
  newId?: () => string;
}

/** Documents are truncated to 2 500 tokens (03 R1). */
export const DOC_MAX_TOKENS = 2_500;
/** Max 429 → re-acquire rounds per call before giving up (the governor already walks the fallback chain). */
const MAX_RATE_ROUNDS = 4;

// ───────────────────────── error mapping

export function groqErrorCode(e: unknown): string | null {
  if (!(e instanceof APIError)) return null;
  const err = e.error as { code?: unknown; error?: { code?: unknown } } | undefined;
  const c = err?.code ?? err?.error?.code;
  return typeof c === 'string' ? c : null;
}

function groqErrorStatus(e: APIError): number | undefined {
  if (typeof e.status === 'number') return e.status;
  const sc = (e.error as { status_code?: unknown } | undefined)?.status_code;
  return typeof sc === 'number' ? sc : undefined;
}

function groqErrorMessage(e: APIError): string {
  const err = e.error as { message?: unknown; error?: { message?: unknown } } | undefined;
  const m = err?.message ?? err?.error?.message ?? e.message;
  return String(m ?? 'groq error').slice(0, 300);
}

function headerOf(h: Headers | undefined | null, name: string): string | null {
  if (!h || typeof h.get !== 'function') return null;
  return h.get(name);
}

function retryAfterMs(h: Headers | undefined | null): number | null {
  const v = headerOf(h, 'retry-after');
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : null;
}

/** Terminal mapping (after the handled cases): SDK error → kernel error. APIConnectionError is checked before APIError. */
export function mapGroqError(e: unknown, signal?: AbortSignal): Error {
  if (e instanceof AbortedError || e instanceof TransientLlmError || e instanceof BadRequestLlmError) return e;
  if (e instanceof APIUserAbortError || signal?.aborted || (e instanceof Error && e.name === 'AbortError')) return new AbortedError(String(signal?.reason ?? 'aborted'));
  if (e instanceof APIConnectionTimeoutError) return new TransientLlmError('connection', 'groq request timed out');
  if (e instanceof APIConnectionError) return new TransientLlmError('connection', `groq connection error: ${errorMessage(e).slice(0, 200)}`);
  if (e instanceof APIError) {
    const status = groqErrorStatus(e);
    const requestId = headerOf(e.headers, 'x-request-id');
    const code = groqErrorCode(e);
    if (status === 429) return new TransientLlmError('rate_limit', groqErrorMessage(e), { retryAfterMs: retryAfterMs(e.headers), requestId });
    if (status === 498 || status === 503 || status === 529) return new TransientLlmError('overloaded', groqErrorMessage(e), { requestId });
    if (status !== undefined && status >= 500) return new TransientLlmError('server', groqErrorMessage(e), { requestId });
    if (status === 413) return new BadRequestLlmError(`too_large: ${groqErrorMessage(e)}`, requestId, 'too_large');
    if (status === undefined && !code) return new TransientLlmError('server', groqErrorMessage(e), { requestId });
    return new BadRequestLlmError(groqErrorMessage(e), requestId, code);
  }
  if (e instanceof SyntaxError) return new TransientLlmError('server', 'groq stream returned malformed JSON');
  if (isNetworkError(e)) return new TransientLlmError('connection', `groq connection dropped: ${errorMessage(e).slice(0, 200)}`);
  return e instanceof Error ? e : new Error(String(e));
}

const NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const NET_MESSAGE_RE = /^(terminated|fetch failed|other side closed|socket hang up)$|network error/i;

/**
 * A socket-level failure outside the SDK's own APIConnectionError: undici surfaces a reset mid-body as
 * `TypeError: terminated` (cause: SocketError 'other side closed'), a failed connect as `TypeError: fetch failed`.
 * Only these exact shapes count — a TypeError from a bug stays a bug.
 */
export function isNetworkError(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === 'object' && depth < 4; x = (x as { cause?: unknown }).cause, depth++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && (NET_CODES.has(code) || code.startsWith('UND_ERR_'))) return true;
    const msg = (x as { message?: unknown }).message;
    const name = (x as { name?: unknown }).name;
    if ((name === 'TypeError' || name === 'SocketError') && typeof msg === 'string' && NET_MESSAGE_RE.test(msg.trim())) return true;
  }
  return false;
}

/**
 * The single tool_use_failed retry (03 R1) under the hard ceiling (03 R2): the note sits after the run-start row
 * (protected) and the translation is re-fitted. When even that cannot fit, a short note is tried, then the retry goes
 * out without a note — the ceiling wins over the note.
 */
export function withToolUseFailedNote(t: Translated, message: string, maxPromptTokens: number): Translated {
  const attempt = (note: ChatCompletionMessageParam | null): Translated | null => {
    try {
      return fitToBudget(note ? { ...t, messages: [...t.messages, note], origins: [...t.origins, 'context'] } : t, maxPromptTokens);
    } catch (e) {
      if (e instanceof BadRequestLlmError && e.code === 'prompt_budget') return null;
      throw e;
    }
  };
  return attempt(toolUseFailedNote(t.toolNames, message)) ?? attempt({ role: 'system', content: 'Your previous tool call was invalid. Use only the declared tools with valid JSON arguments, or answer in plain text.' }) ?? attempt(null) ?? t;
}

const isStatus = (e: unknown, s: number) => e instanceof APIError && groqErrorStatus(e) === s;

// ───────────────────────── media → text (03 R1)

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function decodeSource(src: Block, getBlob?: GroqTransportDeps['getBlob']): { bytes: Uint8Array; mime: string } | null {
  if (src['type'] !== 'base64' || typeof src['data'] !== 'string') return null;
  const data = src['data'] as string;
  if (data.startsWith('@blob:')) {
    const b = getBlob?.(data.slice(6));
    return b ? { bytes: b.bytes, mime: b.mime } : null;
  }
  return { bytes: new Uint8Array(Buffer.from(data, 'base64')), mime: String(src['media_type'] ?? 'application/octet-stream') };
}

function truncateDoc(text: string): string {
  const max = Math.floor(DOC_MAX_TOKENS * CHARS_PER_TOKEN);
  return text.length > max ? text.slice(0, max) + TRUNCATED_MARK : text;
}

function collectMedia(req: MainRequest): Block[] {
  const out: Block[] = [];
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return;
    for (const b of c as Block[]) {
      if (!b || typeof b !== 'object') continue;
      if (b['type'] === 'image' || b['type'] === 'document') out.push(b);
      else if (b['type'] === 'tool_result') walk(b['content']);
    }
  };
  for (const m of req.messages) walk(m.content);
  return out;
}

// ───────────────────────── the transport

export interface GroqTransport extends LlmTransport {
  readonly mode: 'groq';
}

export function createGroqTransport(d: GroqTransportDeps): GroqTransport {
  const log = d.log;
  let seq = 0;
  const newId = d.newId ?? (() => `groq_${d.clock.now().toString(36)}_${(++seq).toString(36)}`);
  const known = new Set(Object.values(d.models));

  function resolveModel(reqModel: string): { model: string; role: GroqRole } {
    const m = reqModel.startsWith('groq:') ? reqModel.slice(5) : reqModel;
    if (m === d.models.fast) return { model: m, role: 'fast' };
    if (known.has(m) || m.includes('/')) return { model: m, role: 'main' };
    return { model: d.models.main, role: 'main' }; // a non-Groq model id (old epoch) → the main model
  }

  async function mediaText(b: Block, priority: Priority, dek: string | undefined): Promise<string> {
    const src = (b['source'] ?? {}) as Block;
    const cache = dek ? (d.mediaCache?.() ?? null) : null;
    if (b['type'] === 'image') {
      const dec = decodeSource(src, d.getBlob);
      if (!dec) return '[image]';
      const sha = sha256(dec.bytes);
      const hit = cache?.get('vision', sha, dek!);
      if (typeof hit === 'string') return `[image: ${hit}]`;
      const vision = d.vision?.() ?? null;
      if (!vision) return '[image: no description available]';
      try {
        const desc = (await vision.describe({ images: [{ bytes: dec.bytes, mime: dec.mime }], priority })).trim();
        if (desc) cache?.set('vision', sha, dek!, desc);
        return `[image: ${desc || 'no description available'}]`;
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'groq: image description failed');
        return '[image: description unavailable]';
      }
    }
    // document
    const title = typeof b['title'] === 'string' && b['title'] ? `: ${String(b['title']).slice(0, 120)}` : '';
    if (src['type'] === 'text' && typeof src['data'] === 'string') return `[document${title}]\n${truncateDoc(src['data'] as string)}`;
    if (src['type'] === 'content' && Array.isArray(src['content'])) {
      const t = (src['content'] as Block[]).map((p) => (p['type'] === 'text' ? String(p['text'] ?? '') : '')).filter(Boolean).join('\n');
      return `[document${title}]\n${truncateDoc(t)}`;
    }
    const dec = decodeSource(src, d.getBlob);
    if (!dec) return `[document${title}]`;
    const sha = sha256(dec.bytes);
    const hit = cache?.get('pdf', sha, dek!);
    if (typeof hit === 'string') return `[document${title}]\n${hit}`;
    const pdf = d.pdfText?.() ?? null;
    if (!pdf) return `[document${title}: text unavailable]`;
    try {
      const maxChars = Math.floor(DOC_MAX_TOKENS * CHARS_PER_TOKEN);
      const r = await pdf.extract(dec.bytes, maxChars);
      const text = r.truncated || r.text.length > maxChars ? r.text.slice(0, maxChars) + TRUNCATED_MARK : r.text;
      cache?.set('pdf', sha, dek!, text);
      return `[document${title}]\n${text}`;
    } catch (e) {
      log.warn({ err: errorMessage(e) }, 'groq: pdf text extraction failed');
      return `[document${title}: text unavailable]`;
    }
  }

  async function translate(req: MainRequest, priority: Priority, dek?: string): Promise<Translated> {
    const media = collectMedia(req);
    const texts = new Map<Block, string>();
    for (const b of media) texts.set(b, await mediaText(b, priority, dek));
    return translateRequest(req, { mediaText: (b) => texts.get(b) ?? '[attachment]', maxOutputTokens: d.profile.maxOutputTokens });
  }

  function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
  }

  /** acquire() with the busy signal wired to onBlockStart. */
  async function acquire(role: GroqRole, model: string, est: number, priority: Priority, signal: AbortSignal | undefined, h?: StreamHandlers) {
    const onBusy = h?.onBlockStart ? (sec: number) => h.onBlockStart!({ index: -1, type: 'busy', name: String(sec) }) : undefined;
    return d.governor.acquire({ role, model, estTokens: est, priority, ...(signal ? { signal } : {}), ...(onBusy ? { onBusy } : {}) });
  }

  async function stream(req: MainRequest, h: StreamHandlers, signal: AbortSignal, opts?: TransportOpts): Promise<StreamResult> {
    const started = d.clock.now();
    const priority = opts?.priority ?? 'interactive';
    throwIfAborted(signal);
    const { model: wanted, role } = resolveModel(req.model);
    const base = await translate(req, priority, opts?.dek);
    let t = fitToBudget(base, d.profile.maxPromptTokens);
    let toolRetried = false;
    let shrunk = false;
    let rateRounds = 0;
    let ttftMs: number | null = null;
    let emitted = false; // text reached onText in an earlier attempt of this call
    for (;;) {
      throwIfAborted(signal);
      const est = estimateTranslated(t);
      const { model } = await acquire(role, wanted, est, priority, signal, h);
      const acc = new ChunkAccumulator();
      const seenCalls = new Set<number>();
      let requestId: string | null = null;
      let observedUsage = false;
      try {
        const { data, response } = await d.client.chat.completions.create(buildStreamParams(t, model), { signal, maxRetries: 0 }).withResponse();
        requestId = response.headers.get('x-request-id');
        d.governor.observe(model, { headers: response.headers, status: response.status });
        for await (const chunk of data as AsyncIterable<ChatCompletionChunk>) {
          const out = acc.push(chunk);
          if (out.thinkingStart) h.onBlockStart?.({ index: 0, type: 'thinking' });
          if (out.text) {
            if (ttftMs === null) ttftMs = d.clock.now() - started;
            emitted = true;
            h.onText(out.text);
          }
          acc.calls.forEach((c, i) => {
            if (c && c.name && !seenCalls.has(i)) {
              seenCalls.add(i);
              h.onBlockStart?.({ index: i + 1, type: 'tool_use', name: c.name });
            }
          });
        }
        throwIfAborted(signal);
        // a body that ends without a finish_reason was cut off (no [DONE]): never accept the partial as a full answer
        if (acc.finish === null) throw new TransientLlmError('server', 'groq stream ended before finish_reason', { requestId });
        if (acc.usage) {
          observedUsage = true;
          d.governor.observe(model, { usage: { promptTokens: acc.usage.prompt_tokens, completionTokens: acc.usage.completion_tokens } });
        }
        const message = acc.toMessage(model, newId);
        return { message, requestId: requestId ?? acc.id, ttftMs, latencyMs: d.clock.now() - started };
      } catch (e) {
        if (signal.aborted || e instanceof APIUserAbortError) throw new AbortedError(String(signal.reason ?? 'aborted'));
        if (e instanceof APIError && !(e instanceof APIConnectionError)) {
          const status = groqErrorStatus(e);
          if (!observedUsage) d.governor.observe(model, { headers: e.headers ?? null, ...(status !== undefined ? { status } : {}) });
          const code = groqErrorCode(e);
          if (code === 'tool_use_failed') {
            if (toolRetried) throw new BadRequestLlmError(`tool_use_failed: ${groqErrorMessage(e)}`, requestId, 'tool_use_failed');
            toolRetried = true;
            log.info({ model, requestId }, 'groq tool_use_failed: retrying once');
            h.onBlockStart?.({ index: -1, type: 'retry' });
            emitted = false;
            t = withToolUseFailedNote(t, groqErrorMessage(e), d.profile.maxPromptTokens);
            continue;
          }
          if (status === 413) {
            if (shrunk) throw new BadRequestLlmError(`too_large: ${groqErrorMessage(e)}`, requestId, 'too_large');
            shrunk = true;
            const target = Math.floor(Math.min(d.profile.maxPromptTokens, estimateTranslated(t)) * 0.7);
            log.warn({ model, est: estimateTranslated(t), target }, 'groq 413: retrying with a 30% smaller prompt');
            t = fitToBudget(t, target); // throws BadRequestLlmError('prompt_budget') when it cannot shrink
            continue;
          }
          if (status === 429 && rateRounds < MAX_RATE_ROUNDS) {
            rateRounds += 1;
            if (emitted) {
              h.onBlockStart?.({ index: -1, type: 'retry' });
              emitted = false;
            }
            continue; // the governor now penalises `model` and walks the chain (or throws rate_limit)
          }
        }
        throw mapGroqError(e, signal);
      }
    }
  }

  async function create(req: MainRequest, signal?: AbortSignal, opts?: TransportOpts): Promise<StreamResult> {
    return stream(req, { onText() {} }, signal ?? new AbortController().signal, opts);
  }

  /** Keeps the side prompt inside the provider budget: the user text is truncated with '[…truncated]' (⚠ fallback). */
  function fitSide(system: string, user: string): string {
    const budget = d.profile.maxPromptTokens;
    const fixed = estimateChatTokens([{ role: 'system', content: system }, { role: 'user', content: '' }]);
    if (fixed + estimateTokens(user) <= budget) return user;
    const maxChars = Math.max(0, Math.floor((budget - fixed) * CHARS_PER_TOKEN) - TRUNCATED_MARK.length);
    return user.slice(0, maxChars) + TRUNCATED_MARK;
  }

  async function parse<T>(req: SideRequest<T>, signal?: AbortSignal, opts?: TransportOpts): Promise<SideResult<T>> {
    const priority = opts?.priority ?? 'background';
    throwIfAborted(signal);
    const original = z.toJSONSchema(req.schema as z.ZodType, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
    const { schema, strict } = toGroqStrictSchema(original);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: fitSide(req.system, req.user) },
    ];
    const maxTokens = Math.max(1, req.maxTokens ?? d.profile.sideMaxOutputTokens);
    const est = estimateChatTokens(messages as Parameters<typeof estimateChatTokens>[0]) + estimateTokens(JSON.stringify(schema));
    const usage: UsageNumbers = { ...ZERO_USAGE };
    let requestId: string | null = null;
    let attempts = 0;
    let rateRounds = 0;
    let lastStop: string | null = null;
    while (attempts < 2) {
      throwIfAborted(signal);
      // friend-mode: role 'main' (C4 composition) uses the main model; everything else the fast one
      const { model } = req.role === 'main' ? await acquire('main', d.models.main, est, priority, signal) : await acquire('fast', d.models.fast, est, priority, signal);
      const body: ChatCompletionCreateParamsNonStreaming = {
        model,
        messages,
        stream: false,
        max_completion_tokens: maxTokens,
        reasoning_effort: 'low',
        response_format: { type: 'json_schema', json_schema: { name: req.purpose, strict, schema } },
      };
      try {
        const { data, response } = await d.client.chat.completions.create(body, { ...(signal ? { signal } : {}), maxRetries: 0 }).withResponse();
        const completion = data as ChatCompletion;
        requestId = response.headers.get('x-request-id') ?? completion.id ?? requestId;
        const u = (completion.usage ?? null) as { prompt_tokens?: number; completion_tokens?: number } | null;
        const un = usageNumbers(u ? { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 } : null);
        usage.inputTokens += un.inputTokens;
        usage.outputTokens += un.outputTokens;
        d.governor.observe(model, { headers: response.headers, status: response.status, usage: { promptTokens: un.inputTokens, completionTokens: un.outputTokens } });
        attempts += 1;
        const choice = completion.choices?.[0];
        lastStop = choice?.finish_reason ?? null;
        const content = choice?.message?.content ?? '';
        let value: unknown;
        try {
          value = JSON.parse(content);
        } catch {
          log.info({ purpose: req.purpose, attempt: attempts, finish: lastStop }, 'groq parse: invalid JSON');
          lastStop = lastStop === 'length' ? 'max_tokens' : 'invalid_json';
          continue;
        }
        const r = req.schema.safeParse(nullsToUndefined(value, original));
        if (r.success) return { parsed: r.data, stopReason: 'end_turn', usage, requestId };
        log.info({ purpose: req.purpose, attempt: attempts }, 'groq parse: schema mismatch');
        lastStop = 'schema_mismatch';
      } catch (e) {
        if (signal?.aborted || e instanceof APIUserAbortError) throw new AbortedError(String(signal?.reason ?? 'aborted'));
        if (e instanceof APIError && !(e instanceof APIConnectionError)) {
          const status = groqErrorStatus(e);
          d.governor.observe(model, { headers: e.headers ?? null, ...(status !== undefined ? { status } : {}) });
          const code = groqErrorCode(e);
          if (code === 'output_parse_failed' || code === 'json_validate_failed') {
            attempts += 1;
            lastStop = code;
            log.info({ purpose: req.purpose, attempt: attempts, code }, 'groq parse failed');
            continue;
          }
          if (status === 429 && rateRounds < MAX_RATE_ROUNDS) {
            rateRounds += 1;
            continue;
          }
          if (status === 413) return { parsed: null, stopReason: 'too_large', usage, requestId };
        }
        throw mapGroqError(e, signal);
      }
    }
    return { parsed: null, stopReason: lastStop ?? 'parse_failed', usage, requestId };
  }

  const store = new Map<string, { bytes: Uint8Array; filename: string; mime: string }>();
  let fileSeq = 0;

  return {
    mode: 'groq',
    stream,
    create,
    parse,
    files: {
      async upload(bytes, filename, mime) {
        const id = `gfile_${(++fileSeq).toString(36)}`;
        store.set(id, { bytes, filename, mime });
        return id;
      },
      async download(fileId) {
        const f = store.get(fileId);
        if (!f) throw new BadRequestLlmError(`file not found: ${fileId}`, null, 'file_not_found');
        return f;
      },
      async delete(fileId) {
        store.delete(fileId);
      },
    },
  };
}
