// WP3 — the Anthropic transport: a REAL SDK client with a fake fetch returning a recorded SSE stream (01 §15.2):
// the anthropic-beta header, fallbacks:'default' in the body, deltas reach onText, abort → AbortedError, 429/529 →
// TransientLlmError, 400 system-role → BadRequestLlmError('system_role_unsupported').
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MainRequest } from '../../../src/contracts/index.ts';
import { BETAS, PROVIDER_PROFILES } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { AbortedError, BadRequestLlmError, TransientLlmError } from '../../../src/kernel/errors.ts';
import { createAnthropicTransport } from '../../../src/agent/transport.ts';

const SSE = readFileSync(new URL('../../fixtures/sse/anthropic-basic.sse', import.meta.url), 'utf8');
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

type Rec = { url: string; headers: Headers; body: Record<string, unknown> | null };

function fakeFetch(respond: (r: Rec, n: number) => Response | Promise<Response>) {
  const calls: Rec[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers as HeadersInit);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const rec = { url, headers, body };
    calls.push(rec);
    if (init?.signal?.aborted) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    return respond(rec, calls.length);
  }) as typeof fetch;
  return { f, calls };
}

const sse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_abc' } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_err', ...headers } });

const make = (f: typeof fetch) => createAnthropicTransport({ apiKey: 'sk-ant-test', sideModel: 'claude-haiku-5', profile: PROVIDER_PROFILES.anthropic, clock: new FakeClock(), log, fetchImpl: f, maxRetries: 0 });

const req = (): MainRequest => ({
  model: 'claude-opus-5', max_tokens: 32_000,
  system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral', ttl: '1h' },
  fallbacks: 'default', betas: [BETAS.fallback, BETAS.compaction],
} as MainRequest);

describe('AnthropicTransport (real SDK, fake fetch)', () => {
  it('streams a recorded SSE: beta header, fallbacks in the body, deltas → onText, final message + request id', async () => {
    const { f, calls } = fakeFetch(() => sse(SSE));
    const text: string[] = [];
    const blocks: Array<{ index: number; type: string }> = [];
    const r = await make(f).stream(req(), { onText: (d) => void text.push(d), onBlockStart: (b) => void blocks.push(b) }, new AbortController().signal);
    expect(text.join('')).toBe('Hello from Gora.');
    expect(blocks).toEqual([{ index: 0, type: 'text' }]);
    expect(r.message.stop_reason).toBe('end_turn');
    expect(r.message.content).toMatchObject([{ type: 'text', text: 'Hello from Gora.' }]);
    expect(r.requestId).toBe('req_abc');
    const c = calls[0]!;
    expect(c.url).toContain('/v1/messages');
    expect(c.headers.get('anthropic-beta')).toContain(BETAS.fallback);
    expect(c.body!['fallbacks']).toBe('default');
    expect(c.body!['stream']).toBe(true);
    expect(c.body).not.toHaveProperty('betas');
  });

  it('an abort maps to AbortedError', async () => {
    const { f } = fakeFetch(() => sse(SSE));
    const ac = new AbortController();
    ac.abort('user_stop');
    await expect(make(f).stream(req(), { onText() {} }, ac.signal)).rejects.toBeInstanceOf(AbortedError);
  });

  it('429 and 529 map to TransientLlmError (rate_limit / overloaded) with retry-after', async () => {
    const r429 = make(fakeFetch(() => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '7' })).f);
    await expect(r429.stream(req(), { onText() {} }, new AbortController().signal)).rejects.toMatchObject({ name: 'TransientLlmError', kind: 'rate_limit', retryAfterMs: 7000 });
    const r529 = make(fakeFetch(() => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } })).f);
    await expect(r529.stream(req(), { onText() {} }, new AbortController().signal)).rejects.toBeInstanceOf(TransientLlmError);
    await expect(r529.stream(req(), { onText() {} }, new AbortController().signal)).rejects.toMatchObject({ kind: 'overloaded' });
  });

  it("400 \"role 'system' is not supported\" → BadRequestLlmError(system_role_unsupported) with the request id", async () => {
    const t = make(fakeFetch(() => json(400, { type: 'error', error: { type: 'invalid_request_error', message: "messages: role 'system' is not supported on this model" } })).f);
    const e = await t.stream(req(), { onText() {} }, new AbortController().signal).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BadRequestLlmError);
    expect(e).toMatchObject({ code: 'system_role_unsupported' });
  });

  it('parse() uses the side model with a zod output format, effort low and adaptive thinking', async () => {
    const body = {
      id: 'msg_p', type: 'message', role: 'assistant', model: 'claude-haiku-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: '{"title":"Tokyo trip"}' }], usage: { input_tokens: 40, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    const { f, calls } = fakeFetch(() => json(200, body));
    const r = await make(f).parse({ purpose: 'title', system: 'S', user: 'U', schema: z.object({ title: z.string().nullable() }) });
    expect(r.parsed).toEqual({ title: 'Tokyo trip' });
    expect(r.usage.inputTokens).toBe(40);
    expect(calls[0]!.body).toMatchObject({ model: 'claude-haiku-5', thinking: { type: 'adaptive' }, output_config: { effort: 'low', format: { type: 'json_schema' } } });
  });
});
