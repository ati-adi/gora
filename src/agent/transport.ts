// agent/transport.ts (WP3) — the Anthropic transport (01 §4.4 llm.ts, §5.2, §5.8). The ONLY runtime importer of
// @anthropic-ai/sdk. stream() = client.beta.messages.stream + finalMessage(); create() non-streaming (make_file);
// parse() = client.messages.parse + zodOutputFormat on the side model (effort low, adaptive thinking); files.* on the
// stable Files API. SDK errors map (APIConnectionError before APIError) to kernel/errors.ts.
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, toFile } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BetaMessage, Clock, LlmTransport, Logger, MainRequest, ProviderProfile, SideRequest, SideResult, StreamHandlers, StreamResult, TransportOpts } from '../contracts/index.ts';
import { AbortedError, BadRequestLlmError, JsonInputError, TransientLlmError, errorMessage } from '../kernel/errors.ts';
import { usageFromBeta } from './pricing.ts';

export interface AnthropicTransportDeps {
  apiKey: string;
  baseURL?: string;
  sideModel: string;
  profile: ProviderProfile;
  clock: Clock;
  log: Logger;
  /** DI fetch (tests pass a fake returning recorded SSE); omitted → the SDK default. */
  fetchImpl?: typeof fetch;
  /** SDK-level retries (01 §5.8: TransientLlmError is raised after the SDK's own maxRetries: 2). */
  maxRetries?: number;
  timeoutMs?: number;
}

function headerOf(h: Headers | undefined | null, name: string): string | null {
  return h && typeof h.get === 'function' ? h.get(name) : null;
}

function bodyType(e: APIError): string | null {
  const err = e.error as { type?: unknown; error?: { type?: unknown } } | undefined;
  const t = err?.error?.type ?? err?.type;
  return typeof t === 'string' ? t : null;
}

function bodyMessage(e: APIError): string {
  const err = e.error as { message?: unknown; error?: { message?: unknown } } | undefined;
  return String(err?.error?.message ?? err?.message ?? e.message ?? 'anthropic error').slice(0, 400);
}

/** 01 §5.8 error mapping. APIConnectionError is checked BEFORE APIError (it is a subclass). */
export function mapAnthropicError(e: unknown, signal?: AbortSignal | null): Error {
  if (e instanceof AbortedError || e instanceof TransientLlmError || e instanceof BadRequestLlmError || e instanceof JsonInputError) return e;
  if (e instanceof APIUserAbortError || signal?.aborted) return new AbortedError(String(signal?.reason ?? 'aborted'));
  if (e instanceof APIConnectionTimeoutError) return new TransientLlmError('connection', 'anthropic request timed out');
  if (e instanceof APIConnectionError) return new TransientLlmError('connection', `anthropic connection error: ${errorMessage(e).slice(0, 200)}`);
  if (e instanceof APIError) {
    const requestId = (e as { requestID?: string | null }).requestID ?? headerOf(e.headers, 'request-id');
    const status = e.status;
    const type = bodyType(e);
    const ra = headerOf(e.headers, 'retry-after');
    const retryAfterMs = ra != null && Number.isFinite(Number(ra)) ? Math.round(Number(ra) * 1000) : null;
    if (status === 429 || type === 'rate_limit_error') return new TransientLlmError('rate_limit', bodyMessage(e), { retryAfterMs, requestId });
    if (status === 529 || type === 'overloaded_error') return new TransientLlmError('overloaded', bodyMessage(e), { retryAfterMs, requestId });
    if ((status !== undefined && status >= 500) || type === 'api_error') return new TransientLlmError('server', bodyMessage(e), { requestId });
    if (status === undefined && !type) return new TransientLlmError('server', bodyMessage(e), { requestId });
    const msg = bodyMessage(e);
    const code = /role 'system' is not supported|system role .*not supported/i.test(msg) ? 'system_role_unsupported' : status === 413 ? 'too_large' : null;
    return new BadRequestLlmError(msg, requestId ?? null, code);
  }
  // eager input streaming: the SDK fails to parse a partial tool input
  if (e instanceof Error && /parse.*(tool|input).*json|json.*(tool|input)/i.test(e.message)) return new JsonInputError(e.message.slice(0, 200));
  if (e instanceof Error && e.name === 'AbortError') return new AbortedError(String(signal?.reason ?? 'aborted'));
  return e instanceof Error ? e : new Error(String(e));
}

export function createAnthropicTransport(d: AnthropicTransportDeps): LlmTransport {
  const client = new Anthropic({
    apiKey: d.apiKey,
    maxRetries: d.maxRetries ?? 2,
    timeout: d.timeoutMs ?? 600_000,
    ...(d.baseURL ? { baseURL: d.baseURL } : {}),
    ...(d.fetchImpl ? { fetch: d.fetchImpl } : {}),
  });

  async function stream(req: MainRequest, h: StreamHandlers, signal: AbortSignal, _opts?: TransportOpts): Promise<StreamResult> {
    const started = d.clock.now();
    if (signal.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
    let ttftMs: number | null = null;
    const st = client.beta.messages.stream(req, { signal });
    st.on('text', (delta) => {
      if (ttftMs === null) ttftMs = d.clock.now() - started;
      h.onText(delta);
    });
    st.on('streamEvent', (ev) => {
      if (ev.type !== 'content_block_start') return;
      const b = ev.content_block as { type: string; name?: string };
      h.onBlockStart?.({ index: ev.index, type: b.type, ...(typeof b.name === 'string' ? { name: b.name } : {}) });
    });
    try {
      const message = (await st.finalMessage()) as BetaMessage;
      return { message, requestId: st.request_id ?? null, ttftMs, latencyMs: d.clock.now() - started };
    } catch (e) {
      throw mapAnthropicError(e, signal);
    }
  }

  async function create(req: MainRequest, signal?: AbortSignal, _opts?: TransportOpts): Promise<StreamResult> {
    const started = d.clock.now();
    try {
      const { data, request_id } = await client.beta.messages.create({ ...req, stream: false }, signal ? { signal } : {}).withResponse();
      return { message: data as BetaMessage, requestId: request_id ?? null, ttftMs: null, latencyMs: d.clock.now() - started };
    } catch (e) {
      throw mapAnthropicError(e, signal);
    }
  }

  async function parse<T>(req: SideRequest<T>, signal?: AbortSignal, _opts?: TransportOpts): Promise<SideResult<T>> {
    try {
      // (.withResponse() would skip the parsed_output helper: await the parse promise itself)
      const data = await client.messages.parse(
          {
            model: req.role === 'main' ? d.profile.models.main : d.sideModel, // friend-mode: C4 composition asks for the main model
            max_tokens: req.maxTokens ?? d.profile.sideMaxOutputTokens,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low', format: zodOutputFormat(req.schema as never) },
          },
        signal ? { signal } : {},
      );
      const request_id = (data as { _request_id?: string | null })._request_id ?? null;
      const usage = usageFromBeta(data.usage as never);
      if (data.stop_reason === 'refusal') return { parsed: null, stopReason: 'refusal', usage, requestId: request_id ?? null };
      const raw = (data as { parsed_output?: unknown }).parsed_output ?? null;
      const ok = raw == null ? null : req.schema.safeParse(raw);
      return { parsed: ok && ok.success ? ok.data : null, stopReason: data.stop_reason ?? null, usage, requestId: request_id ?? null };
    } catch (e) {
      const m = mapAnthropicError(e, signal);
      // a structured-output parse failure of the SDK is a null result, not an error
      if (!(m instanceof AbortedError) && !(m instanceof TransientLlmError) && !(m instanceof BadRequestLlmError) && /parse|json|schema/i.test(m.message)) {
        d.log.info({ purpose: req.purpose }, 'anthropic parse: invalid structured output');
        return { parsed: null, stopReason: 'parse_failed', usage: usageFromBeta(null), requestId: null };
      }
      throw m;
    }
  }

  return {
    mode: 'anthropic',
    stream,
    create,
    parse,
    files: {
      async upload(bytes, filename, mime) {
        try {
          const meta = await client.files.upload({ file: await toFile(bytes, filename, { type: mime }) });
          return meta.id;
        } catch (e) {
          throw mapAnthropicError(e);
        }
      },
      async download(fileId) {
        try {
          const [meta, res] = await Promise.all([client.files.retrieveMetadata(fileId), client.files.download(fileId)]);
          return { bytes: new Uint8Array(await res.arrayBuffer()), filename: meta.filename, mime: meta.mime_type };
        } catch (e) {
          throw mapAnthropicError(e);
        }
      },
      async delete(fileId) {
        try {
          await client.files.delete(fileId);
        } catch (e) {
          throw mapAnthropicError(e);
        }
      },
    },
  };
}
