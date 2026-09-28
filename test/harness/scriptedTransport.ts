// test/harness/scriptedTransport.ts (WP0) — an LlmTransport that replays scripted BetaMessages (01 §15.1).
import type { BetaContentBlock, BetaMessage, BetaStopReason, BetaUsage, Clock, LlmTransport, MainRequest, SideRequest, SideResult, StreamHandlers, StreamResult, TransportOpts } from '../../src/contracts/index.ts';
import { ZERO_USAGE } from '../../src/contracts/llm.ts';
import { AbortedError, BadRequestLlmError, JsonInputError, TransientLlmError } from '../../src/kernel/errors.ts';
import { assertRequestInvariants, type InvariantOptions } from './invariants.ts';

export type ScriptErrorKind = 'rate_limit' | 'overloaded' | 'server' | 'connection' | 'bad_request' | 'json';
type RefusalCategory = 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null;

export interface ScriptTurn {
  blocks: BetaContentBlock[];
  stopReason: BetaStopReason | null;
  refusal: { category: RefusalCategory; midStream: boolean } | null;
  /** Throw after emitting this many blocks (0 = before the stream starts). `code` → BadRequestLlmError.code (bad_request only). */
  error: { kind: ScriptErrorKind; at: number; message?: string; code?: string } | null;
  /**
   * 03 R1/R6 transport signals, emitted as `onBlockStart({index:-1, type, name?})` just before block `at` (or at the end).
   * A 'retry' signal also drops every block before it from the final message (the Groq transport's tool_use_failed
   * retry replaces the failed attempt), so the channel must have discarded that text.
   */
  signals: Array<{ at: number; type: 'retry' | 'busy'; name?: string }>;
  hang: boolean;
  delayMs: number;
  model: string | null;
  fallback: { from: string; to: string } | null;
  usage: Partial<BetaUsage>;
  expects: Array<(req: MainRequest) => void>;
}

export interface TurnBuilder {
  thinking(sig?: string, text?: string): TurnBuilder;
  text(t: string): TurnBuilder;
  toolUse(name: string, input: unknown, id?: string): TurnBuilder;
  serverSearch(query: string, results: Array<{ url: string; title: string }>): TurnBuilder;
  fallback(from: string, to: string): TurnBuilder;
  compaction(summary: string): TurnBuilder;
  stop(reason: BetaStopReason): TurnBuilder;
  refusal(category?: RefusalCategory, o?: { midStream?: boolean }): TurnBuilder;
  error(kind: ScriptErrorKind, message?: string, o?: { code?: string }): TurnBuilder;
  /** Emit onBlockStart({index:-1, type, name}) at this position: 'retry' (tool_use_failed; earlier blocks are discarded) or 'busy' (name = seconds). */
  signal(type: 'retry' | 'busy', name?: string): TurnBuilder;
  hang(): TurnBuilder;
  delay(ms: number): TurnBuilder;
  usage(u: Partial<BetaUsage>): TurnBuilder;
  expect(fn: (req: MainRequest) => void): TurnBuilder;
  build(): ScriptTurn;
}

let idSeq = 0;
const nextId = (p: string) => `${p}_${String(++idSeq).padStart(4, '0')}`;

export function turn(): TurnBuilder {
  const t: ScriptTurn = { blocks: [], stopReason: null, refusal: null, error: null, signals: [], hang: false, delayMs: 0, model: null, fallback: null, usage: {}, expects: [] };
  const b: TurnBuilder = {
    thinking(sig = 'sig_x', text = 'Let me think.') {
      t.blocks.push({ type: 'thinking', thinking: text, signature: sig });
      return b;
    },
    text(s) {
      t.blocks.push({ type: 'text', text: s, citations: null });
      return b;
    },
    toolUse(name, input, id) {
      t.blocks.push({ type: 'tool_use', id: id ?? nextId('toolu'), name, input });
      return b;
    },
    serverSearch(query, results) {
      const id = nextId('srvtoolu');
      t.blocks.push({ type: 'server_tool_use', id, name: 'web_search', input: { query } });
      t.blocks.push({ type: 'web_search_tool_result', tool_use_id: id, content: results.map((r) => ({ type: 'web_search_result' as const, url: r.url, title: r.title, encrypted_content: 'enc', page_age: null })) });
      return b;
    },
    fallback(from, to) {
      t.blocks.push({ type: 'fallback', from: { model: from }, to: { model: to }, trigger: { type: 'refusal', category: null } });
      t.fallback = { from, to };
      t.model = to;
      return b;
    },
    compaction(summary) {
      t.blocks.push({ type: 'compaction', content: summary, encrypted_content: null });
      return b;
    },
    stop(reason) {
      t.stopReason = reason;
      return b;
    },
    refusal(category = null, o = {}) {
      t.refusal = { category, midStream: !!o.midStream };
      t.stopReason = 'refusal';
      return b;
    },
    error(kind, message, o) {
      t.error = { kind, at: t.blocks.length, ...(message ? { message } : {}), ...(o?.code ? { code: o.code } : {}) };
      return b;
    },
    signal(type, name) {
      t.signals.push({ at: t.blocks.length, type, ...(name !== undefined ? { name } : {}) });
      return b;
    },
    hang() {
      t.hang = true;
      return b;
    },
    delay(ms) {
      t.delayMs = ms;
      return b;
    },
    usage(u) {
      t.usage = { ...t.usage, ...u };
      return b;
    },
    expect(fn) {
      t.expects.push(fn);
      return b;
    },
    build() {
      if (t.stopReason === null) t.stopReason = t.blocks.slice(keptFrom(t)).some((x) => x.type === 'tool_use') ? 'tool_use' : 'end_turn';
      return { ...t, blocks: [...t.blocks], expects: [...t.expects], signals: [...t.signals] };
    },
  };
  return b;
}

/** Index of the first block that survives into the final message (after the last 'retry' signal). */
function keptFrom(t: ScriptTurn): number {
  return t.signals.reduce((m, x) => (x.type === 'retry' ? Math.max(m, x.at) : m), 0);
}

/** Convenience: a finished text answer. */
export const say = (text: string): ScriptTurn => turn().text(text).build();

function mapError(kind: ScriptErrorKind, message?: string, code?: string): Error {
  switch (kind) {
    case 'bad_request':
      return new BadRequestLlmError(message ?? 'scripted bad request', 'req_scripted_400', code ?? null);
    case 'json':
      return new JsonInputError(message ?? 'scripted partial JSON');
    default:
      return new TransientLlmError(kind, message ?? `scripted ${kind}`, { retryAfterMs: kind === 'rate_limit' ? 1000 : null });
  }
}

export interface ScriptedFiles {
  uploaded: Map<string, Uint8Array>;
  deleted: Set<string>;
  outputs: Map<string, { bytes: Uint8Array; filename: string; mime: string }>;
}

export class ScriptedTransport implements LlmTransport {
  readonly mode = 'scripted' as const;
  /** Every stream() request, deep-copied at call time. */
  requests: MainRequest[] = [];
  /** Every create() request (make_file sub-calls), deep-copied. */
  createRequests: MainRequest[] = [];
  parseRequests: SideRequest<unknown>[] = [];
  /** opts passed with each stream()/create()/parse() call, in call order. */
  callOpts: Array<{ kind: 'stream' | 'create' | 'parse'; opts: TransportOpts | undefined }> = [];
  files: ScriptedFiles & LlmTransport['files'];
  private queue: ScriptTurn[] = [];
  private parseQueue = new Map<string, unknown[]>();
  private clock: Clock | null;
  private chunk: number;
  private msgSeq = 0;

  constructor(o: { clock?: Clock; chunkSize?: number } = {}) {
    this.clock = o.clock ?? null;
    this.chunk = o.chunkSize ?? 24;
    const store: ScriptedFiles = { uploaded: new Map(), deleted: new Set(), outputs: new Map() };
    let fileSeq = 0;
    this.files = Object.assign(store, {
      upload: async (bytes: Uint8Array, _filename: string, _mime: string) => {
        const id = `file_${++fileSeq}`;
        store.uploaded.set(id, bytes);
        return id;
      },
      download: async (fileId: string) => {
        const f = store.outputs.get(fileId);
        if (!f) throw new Error(`ScriptedTransport.files: no output scripted for ${fileId}`);
        return f;
      },
      delete: async (fileId: string) => {
        store.deleted.add(fileId);
      },
    });
  }

  push(...turns: Array<ScriptTurn | TurnBuilder>): this {
    for (const t of turns) this.queue.push('build' in t ? t.build() : t);
    return this;
  }
  /** Queue a parse() result for a purpose; null means "the model returned nothing usable". */
  pushParse(purpose: SideRequest<unknown>['purpose'], value: unknown | null): this {
    const q = this.parseQueue.get(purpose) ?? [];
    q.push(value);
    this.parseQueue.set(purpose, q);
    return this;
  }
  /** Number of scripted turns not yet consumed. */
  remaining(): number {
    return this.queue.length;
  }
  assertInvariants(o?: InvariantOptions): void {
    assertRequestInvariants(this.requests, o);
  }

  async stream(req: MainRequest, h: StreamHandlers, signal: AbortSignal, opts?: TransportOpts): Promise<StreamResult> {
    this.requests.push(structuredClone(req));
    this.callOpts.push({ kind: 'stream', opts });
    return this.play(req, h, signal);
  }

  async create(req: MainRequest, signal?: AbortSignal, opts?: TransportOpts): Promise<StreamResult> {
    this.createRequests.push(structuredClone(req));
    this.callOpts.push({ kind: 'create', opts });
    return this.play(req, { onText() {} }, signal ?? new AbortController().signal);
  }

  async parse<T>(req: SideRequest<T>, _signal?: AbortSignal, opts?: TransportOpts): Promise<SideResult<T>> {
    this.parseRequests.push(req as SideRequest<unknown>);
    this.callOpts.push({ kind: 'parse', opts });
    const q = this.parseQueue.get(req.purpose);
    const usage = { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20 };
    if (!q || q.length === 0) return { parsed: null, stopReason: 'no_script', usage, requestId: null };
    const v = q.shift();
    if (v === null || v === undefined) return { parsed: null, stopReason: 'end_turn', usage, requestId: 'req_parse' };
    const r = req.schema.safeParse(v);
    if (!r.success) throw new Error(`ScriptedTransport.parse(${req.purpose}): scripted value does not match the schema: ${r.error.message}`);
    return { parsed: r.data, stopReason: 'end_turn', usage, requestId: 'req_parse' };
  }

  private async play(req: MainRequest, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    const n = this.requests.length + this.createRequests.length;
    const t = this.queue.shift();
    if (!t) throw new Error(`ScriptedTransport: no scripted turn left for request #${n}`);
    for (const e of t.expects) e(req);
    const abortErr = () => new AbortedError(String(signal.reason ?? 'aborted'));
    if (signal.aborted) throw abortErr();
    if (t.delayMs > 0) {
      if (this.clock) await this.clock.sleep(t.delayMs, signal);
      else await new Promise<void>((res, rej) => {
        const h2 = setTimeout(res, t.delayMs);
        signal.addEventListener('abort', () => (clearTimeout(h2), rej(abortErr())), { once: true });
      });
    }
    const t0 = 0;
    const emitSignals = (at: (x: number) => boolean) => {
      for (const sg of t.signals) if (at(sg.at)) h.onBlockStart?.({ index: -1, type: sg.type, ...(sg.name !== undefined ? { name: sg.name } : {}) });
    };
    const kept = keptFrom(t);
    for (let i = 0; i < t.blocks.length; i++) {
      emitSignals((at) => at === i);
      if (t.error && t.error.at === i) throw mapError(t.error.kind, t.error.message, t.error.code);
      const blk = t.blocks[i]!;
      h.onBlockStart?.({ index: i >= kept ? i - kept : i, type: blk.type, ...('name' in blk && typeof blk.name === 'string' ? { name: blk.name } : {}) });
      if (blk.type === 'text') {
        for (let k = 0; k < blk.text.length; k += this.chunk) {
          if (signal.aborted) throw abortErr();
          h.onText(blk.text.slice(k, k + this.chunk));
          await Promise.resolve();
        }
      }
      if (signal.aborted) throw abortErr();
    }
    emitSignals((at) => at >= t.blocks.length);
    if (t.error && t.error.at >= t.blocks.length) throw mapError(t.error.kind, t.error.message, t.error.code);
    if (t.hang) {
      await new Promise<never>((_, rej) => {
        if (signal.aborted) return rej(abortErr());
        signal.addEventListener('abort', () => rej(abortErr()), { once: true });
      });
    }
    const message = this.buildMessage(t, req);
    return { message, requestId: `req_scripted_${n}`, ttftMs: t0 + 5, latencyMs: 10 };
  }

  private buildMessage(t: ScriptTurn, req: MainRequest): BetaMessage {
    const blocks = t.blocks.slice(keptFrom(t));
    const searches = blocks.filter((b) => b.type === 'server_tool_use' && b.name === 'web_search').length;
    const fetches = blocks.filter((b) => b.type === 'server_tool_use' && b.name === 'web_fetch').length;
    const inputTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
    const outputTokens = Math.ceil(JSON.stringify(blocks).length / 4);
    const usage: BetaUsage = {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: inputTokens,
      iterations: t.fallback
        ? [
            { type: 'message', model: t.fallback.from, input_tokens: inputTokens, output_tokens: 1, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            { type: 'fallback_message', model: t.fallback.to, input_tokens: inputTokens, output_tokens: outputTokens, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          ]
        : null,
      output_tokens: outputTokens,
      output_tokens_details: null,
      server_tool_use: searches || fetches ? { web_search_requests: searches, web_fetch_requests: fetches } : null,
      service_tier: 'standard',
      speed: null,
      ...t.usage,
    };
    return {
      id: `msg_scripted_${++this.msgSeq}`,
      type: 'message',
      role: 'assistant',
      model: t.model ?? req.model,
      content: structuredClone(blocks),
      container: null,
      context_management: null,
      diagnostics: null,
      stop_reason: t.stopReason,
      stop_sequence: null,
      stop_details: t.refusal ? { type: 'refusal', category: t.refusal.category, explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null } : null,
      usage,
    };
  }
}
