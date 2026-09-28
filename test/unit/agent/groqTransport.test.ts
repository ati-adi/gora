// WP3 — 03 R1 GroqTransport against a fake groq client emitting the verified chunk shapes: reasoning deltas with channel
// 'analysis', one complete tool_call delta, the final choices:[] usage chunk, SSE tool_use_failed after reasoning,
// 429 with retry-after (governor fallback chain), 413 (shrink once), the prompt ceiling, parse() with strict json_schema.
import { readFileSync } from 'node:fs';
import { APIConnectionError, APIError } from 'groq-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatCompletionChunk } from 'groq-sdk/resources/chat/completions';
import type { GroqClient, MainRequest, ProviderProfile } from '../../../src/contracts/index.ts';
import { PROVIDER_PROFILES } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { AbortedError, BadRequestLlmError, TransientLlmError } from '../../../src/kernel/errors.ts';
import { createRateGovernor } from '../../../src/agent/groq/rate.ts';
import { createGroqTransport, isNetworkError, mapGroqError } from '../../../src/agent/groq/transport.ts';

const chunks = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/sse/${name}`, import.meta.url), 'utf8')) as ChatCompletionChunk[];
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
const models = { main: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', vision: 'qwen/qwen3.8-27b', sentinel: 'openai/gpt-oss-safeguard-20b', guard: 'meta-llama/llama-prompt-guard-2-86m', stt: 'whisper-large-v3-turbo', tts: 'canopylabs/orpheus-v1-english' };

type Step = { chunks?: ChatCompletionChunk[]; completion?: unknown; error?: unknown; throwAfter?: { at: number; error: unknown }; headers?: Record<string, string> };

function fakeGroq(steps: Step[]) {
  const calls: Array<{ params: Record<string, unknown>; signal: AbortSignal | undefined }> = [];
  const client = {
    chat: {
      completions: {
        create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }) {
          calls.push({ params: structuredClone(params), signal: opts?.signal });
          const next = steps.shift();
          if (!next) throw new Error('fakeGroq: no step scripted');
          const step: Step = next;
          return {
            withResponse: async () => {
              if (step.error) throw step.error;
              const response = { headers: new Headers({ 'x-request-id': `req_${calls.length}`, ...(step.headers ?? {}) }), status: 200 };
              if (step.completion) return { data: step.completion, response };
              async function* gen() {
                let i = 0;
                for (const c of step.chunks ?? []) {
                  if (step.throwAfter && step.throwAfter.at === i) throw step.throwAfter.error;
                  if (opts?.signal?.aborted) throw new Error('aborted');
                  yield c;
                  i++;
                }
                if (step.throwAfter && step.throwAfter.at >= i) throw step.throwAfter.error;
              }
              return { data: gen(), response };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as GroqClient, calls };
}

function setup(steps: Step[], o: { profile?: Partial<ProviderProfile>; kv?: Map<string, unknown>; vision?: (n: { count: number }) => Promise<string> } = {}) {
  const clock = new FakeClock();
  const governor = createRateGovernor({ clock, log, repo: null, tier: 'free', models, interactiveWaitMs: 4_000, busyWaitMaxMs: 45_000 });
  const { client, calls } = fakeGroq(steps);
  const kv = o.kv ?? new Map<string, unknown>();
  const visionCalls = { count: 0 };
  const transport = createGroqTransport({
    client, governor, clock, log, models,
    profile: { ...PROVIDER_PROFILES['groq-free'], ...(o.profile ?? {}) },
    vision: () => ({ describe: async () => { visionCalls.count += 1; return o.vision ? o.vision(visionCalls) : 'a red square'; } }),
    pdfText: () => ({ extract: async () => ({ text: 'PDF BODY', pages: 1, truncated: false }) }),
    mediaCache: () => ({ get: (kind: string, sha: string, dek: string) => kv.get(`${kind}:${dek}:${sha}`) as string | undefined, set: (kind: string, sha: string, dek: string, v: string) => void kv.set(`${kind}:${dek}:${sha}`, v) }),
    newId: () => 'gen_id',
  });
  return { transport, calls, clock, governor, kv, visionCalls };
}

const mainReq = (messages?: MainRequest['messages']): MainRequest => ({
  model: `groq:${models.main}`, max_tokens: 32_000,
  system: [{ type: 'text', text: 'SYSTEM' }],
  tools: [{ name: 'weather_get', description: 'Weather.', input_schema: { type: 'object', properties: { place: { type: 'string' } } } }],
  messages: messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  output_config: { effort: 'low' },
} as MainRequest);

const h = () => {
  const text: string[] = [];
  const blocks: Array<{ index: number; type: string; name?: string }> = [];
  return { text, blocks, handlers: { onText: (d: string) => void text.push(d), onBlockStart: (b: { index: number; type: string; name?: string }) => void blocks.push(b) } };
};

const toolUseFailed = () => new APIError(undefined, { message: "Tool call validation failed: attempted to call tool 'send_email' which was not in request.tools", type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: '{"name":"send_email"}', status_code: 400 }, undefined, undefined);

describe('GroqTransport.stream', () => {
  it('streams text; reasoning never reaches onText; thinking block-start; usage and request id', async () => {
    const { transport, calls } = setup([{ chunks: chunks('groq-text.json') }]);
    const x = h();
    const r = await transport.stream(mainReq(), x.handlers, new AbortController().signal);
    expect(x.text.join('')).toBe('Hello there!');
    expect(x.blocks).toContainEqual({ index: 0, type: 'thinking' });
    expect(r.message.stop_reason).toBe('end_turn');
    expect(r.message.usage.input_tokens).toBe(812);
    expect(r.requestId).toBe('req_1');
    expect(calls[0]!.params['model']).toBe(models.main);
    expect(calls[0]!.params['max_completion_tokens']).toBe(1200);
    expect(calls[0]!.params['stream_options']).toEqual({ include_usage: true });
  });

  it('one complete tool_call delta → tool_use (and a tool_use block-start)', async () => {
    const { transport } = setup([{ chunks: chunks('groq-tool.json') }]);
    const x = h();
    const r = await transport.stream(mainReq(), x.handlers, new AbortController().signal);
    expect(r.message.stop_reason).toBe('tool_use');
    expect(r.message.content[0]).toMatchObject({ type: 'tool_use', name: 'weather_get', input: { place: 'Almaty', days: 1 } });
    expect(x.blocks).toContainEqual({ index: 1, type: 'tool_use', name: 'weather_get' });
  });

  it('SSE tool_use_failed after reasoning: retry signal, then one retry with a system note naming the tools', async () => {
    const partial = chunks('groq-text.json').slice(0, 4); // role, 2× reasoning, "Hello"
    const { transport, calls } = setup([{ chunks: partial, throwAfter: { at: 4, error: toolUseFailed() } }, { chunks: chunks('groq-text.json') }]);
    const x = h();
    const r = await transport.stream(mainReq(), x.handlers, new AbortController().signal);
    expect(x.blocks).toContainEqual({ index: -1, type: 'retry' });
    expect(calls).toHaveLength(2);
    const msgs = calls[1]!.params['messages'] as Array<{ role: string; content: string }>;
    expect(msgs[msgs.length - 1]!.role).toBe('system');
    expect(msgs[msgs.length - 1]!.content).toContain('Available tools: weather_get');
    expect(r.message.content).toEqual([{ type: 'text', text: 'Hello there!', citations: null }]);
  });

  it('a second tool_use_failed → BadRequestLlmError(tool_use_failed)', async () => {
    const { transport } = setup([{ chunks: [], throwAfter: { at: 0, error: toolUseFailed() } }, { chunks: [], throwAfter: { at: 0, error: toolUseFailed() } }]);
    await expect(transport.stream(mainReq(), h().handlers, new AbortController().signal)).rejects.toMatchObject({ name: 'BadRequestLlmError', code: 'tool_use_failed' });
  });

  it('429 with retry-after: the governor penalises the model and the retry goes to the fallback chain', async () => {
    const e429 = APIError.generate(429, { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b`', type: 'tokens', code: 'rate_limit_exceeded' } }, undefined, new Headers({ 'retry-after': '35' }));
    const { transport, calls } = setup([{ error: e429 }, { chunks: chunks('groq-text.json') }]);
    const r = await transport.stream(mainReq(), h().handlers, new AbortController().signal);
    expect(calls.map((c) => c.params['model'])).toEqual([models.main, models.vision]);
    expect(r.message.stop_reason).toBe('end_turn');
  });

  it('429 on every model of the chain (non-interactive) → TransientLlmError(rate_limit)', async () => {
    const e = () => APIError.generate(429, { error: { message: 'rate', code: 'rate_limit_exceeded' } }, undefined, new Headers({ 'retry-after': '35' }));
    const { transport } = setup([{ error: e() }, { error: e() }, { error: e() }, { error: e() }, { error: e() }]);
    await expect(transport.stream(mainReq(), h().handlers, new AbortController().signal, { priority: 'background' })).rejects.toMatchObject({ name: 'TransientLlmError', kind: 'rate_limit' });
  });

  it('413: retries once with a ~30 % smaller prompt; a second 413 → BadRequestLlmError(too_large)', async () => {
    const e413 = () => APIError.generate(413, { error: { message: 'Request too large for model', type: 'tokens', code: 'rate_limit_exceeded' } }, undefined, new Headers({ 'retry-after': '19' }));
    const history: MainRequest['messages'] = [];
    for (let i = 0; i < 12; i++) history.push({ role: 'user', content: [{ type: 'text', text: `q${i} ${'x'.repeat(400)}` }] }, { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
    history.push({ role: 'user', content: [{ type: 'text', text: 'now' }] });
    const ok = setup([{ error: e413() }, { chunks: chunks('groq-text.json') }]);
    await ok.transport.stream(mainReq(history), h().handlers, new AbortController().signal);
    const n0 = (ok.calls[0]!.params['messages'] as unknown[]).length;
    const n1 = (ok.calls[1]!.params['messages'] as unknown[]).length;
    expect(n1).toBeLessThan(n0);
    expect(JSON.stringify(ok.calls[1]!.params['messages'])).toContain('[earlier conversation omitted]');
    const bad = setup([{ error: e413() }, { error: e413() }]);
    await expect(bad.transport.stream(mainReq(history), h().handlers, new AbortController().signal)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('the prompt ceiling fails with prompt_budget before any call', async () => {
    const { transport, calls } = setup([]);
    const huge: MainRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(60_000) }] }];
    await expect(transport.stream(mainReq(huge), h().handlers, new AbortController().signal)).rejects.toMatchObject({ code: 'prompt_budget' });
    expect(calls).toHaveLength(0);
  });

  it('images → vision description, cached by sha256 in kv (replays are identical and free)', async () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } };
    const msgs: MainRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, img as never] }];
    const s = setup([{ chunks: chunks('groq-text.json') }, { chunks: chunks('groq-text.json') }]);
    await s.transport.stream(mainReq(msgs), h().handlers, new AbortController().signal, { dek: 'e:c1:1' });
    await s.transport.stream(mainReq(msgs), h().handlers, new AbortController().signal, { dek: 'e:c1:1' });
    expect(s.visionCalls.count).toBe(1);
    expect([...s.kv.keys()].some((k) => k.startsWith('vision:'))).toBe(true);
    expect(JSON.stringify(s.calls[0]!.params['messages'])).toBe(JSON.stringify(s.calls[1]!.params['messages']));
    expect(JSON.stringify(s.calls[0]!.params['messages'])).toContain('[image: a red square]');
  });

  it('abort → AbortedError; 5xx / connection → TransientLlmError', async () => {
    const ac = new AbortController();
    ac.abort('user_stop');
    await expect(setup([{ chunks: chunks('groq-text.json') }]).transport.stream(mainReq(), h().handlers, ac.signal)).rejects.toBeInstanceOf(AbortedError);
    const e500 = APIError.generate(500, { error: { message: 'boom' } }, undefined, new Headers());
    await expect(setup([{ error: e500 }]).transport.stream(mainReq(), h().handlers, new AbortController().signal)).rejects.toMatchObject({ kind: 'server' });
    expect(mapGroqError(new APIConnectionError({ message: 'reset' }))).toMatchObject({ kind: 'connection' });
    expect(mapGroqError(APIError.generate(503, {}, undefined, new Headers()))).toBeInstanceOf(TransientLlmError);
    expect(mapGroqError(APIError.generate(400, { error: { message: 'bad', code: 'x' } }, undefined, new Headers()))).toBeInstanceOf(BadRequestLlmError);
  });
});

describe('GroqTransport.parse (strict json_schema)', () => {
  const schema = z.object({ title: z.string(), due: z.string().optional() });
  const completion = (content: string) => ({ id: 'cmpl', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });

  it('uses the fast model with a strict schema; forced nulls map back to undefined', async () => {
    const { transport, calls } = setup([{ completion: completion('{"title":"Trip","due":null}') }]);
    const r = await transport.parse({ purpose: 'title', system: 'S', user: 'U', schema });
    expect(r.parsed).toEqual({ title: 'Trip' });
    expect(r.usage.inputTokens).toBe(50);
    const p = calls[0]!.params;
    expect(p['model']).toBe(models.fast);
    expect(p['max_completion_tokens']).toBe(500);
    expect(p['response_format']).toMatchObject({ type: 'json_schema', json_schema: { name: 'title', strict: true } });
  });

  it('output_parse_failed once → one retry; twice (or invalid output twice) → parsed:null', async () => {
    const fail = () => APIError.generate(400, { error: { message: 'parse', code: 'output_parse_failed', failed_generation: 'reasoning…' } }, undefined, new Headers());
    const a = setup([{ error: fail() }, { completion: completion('{"title":"ok"}') }]);
    expect((await a.transport.parse({ purpose: 'title', system: 'S', user: 'U', schema })).parsed).toEqual({ title: 'ok' });
    const b = setup([{ error: fail() }, { completion: completion('not json') }]);
    const rb = await b.transport.parse({ purpose: 'title', system: 'S', user: 'U', schema });
    expect(rb.parsed).toBeNull();
    const c = setup([{ completion: completion('{"nope":1}') }, { completion: completion('{"nope":2}') }]);
    expect((await c.transport.parse({ purpose: 'title', system: 'S', user: 'U', schema })).parsed).toBeNull();
  });

  it('files.* is an in-process store', async () => {
    const { transport } = setup([]);
    const id = await transport.files.upload(new Uint8Array([1, 2]), 'a.csv', 'text/csv');
    expect(await transport.files.download(id)).toMatchObject({ filename: 'a.csv', mime: 'text/csv' });
    await transport.files.delete(id);
    await expect(transport.files.download(id)).rejects.toBeInstanceOf(BadRequestLlmError);
    expect(transport.mode).toBe('groq');
  });
});

describe('mid-stream network drops (review F11)', () => {
  it('undici socket errors map to TransientLlmError(connection); a TypeError from a bug does not', () => {
    const reset = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });
    expect(isNetworkError(reset)).toBe(true);
    expect(mapGroqError(reset)).toMatchObject({ name: 'TransientLlmError', kind: 'connection' });
    expect(isNetworkError(Object.assign(new Error('read'), { code: 'ECONNRESET' }))).toBe(true);
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    expect(isNetworkError(bug)).toBe(false);
    expect(mapGroqError(bug)).toBe(bug);
  });
});
