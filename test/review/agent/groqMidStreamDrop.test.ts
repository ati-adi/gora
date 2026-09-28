// PROOF (agent review): mid-stream transport failures on the Groq path (real groq-sdk 1.6.0 stream iterator, fake fetch):
//  (a) the connection is reset after some content (undici surfaces `TypeError: terminated` from the body stream):
//      mapGroqError() returns the raw TypeError (only APIConnectionError / 5xx / SyntaxError become TransientLlmError), so
//      the engine fails the run as "unexpected" instead of retrying (03 R1: connection → TransientLlmError);
//  (b) the body ends cleanly without finish_reason / usage / [DONE]: the SDK iterator just stops, and
//      ChunkAccumulator.toMessage() returns the truncated text as a normal `end_turn` answer that the engine persists.
import Groq from 'groq-sdk';
import { describe, expect, it } from 'vitest';
import type { GroqClient, MainRequest } from '../../../src/contracts/index.ts';
import { PROVIDER_PROFILES } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { TransientLlmError } from '../../../src/kernel/errors.ts';
import { createRateGovernor } from '../../../src/agent/groq/rate.ts';
import { createGroqTransport } from '../../../src/agent/groq/transport.ts';

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
const models = { main: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', vision: 'qwen/qwen3.8-27b', sentinel: 'openai/gpt-oss-safeguard-20b', guard: 'meta-llama/llama-prompt-guard-2-86m', stt: 'whisper-large-v3-turbo', tts: 'canopylabs/orpheus-v1-english' };
const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: models.main, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;

function transportWith(body: (c: ReadableStreamDefaultController<Uint8Array>) => void) {
  const enc = new TextEncoder();
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { body({ enqueue: (x: Uint8Array | string) => c.enqueue(typeof x === 'string' ? enc.encode(x) : x), error: (e: unknown) => c.error(e), close: () => c.close() } as never); } }), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' } })) as typeof fetch;
  const client = new Groq({ apiKey: 'gsk_test', maxRetries: 0, fetch: fetchImpl }) as unknown as GroqClient;
  const clock = new FakeClock();
  const governor = createRateGovernor({ clock, log, repo: null, tier: 'free', models, interactiveWaitMs: 4_000, busyWaitMaxMs: 45_000 });
  return createGroqTransport({ client, governor, clock, log, models, profile: PROVIDER_PROFILES['groq-free'], newId: () => 'id' });
}
const req = { model: `groq:${models.main}`, max_tokens: 1200, system: [{ type: 'text', text: 'S' }], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], output_config: { effort: 'low' } } as unknown as MainRequest;

describe('Groq stream interrupted mid-way', () => {
  it('(a) a connection reset after some text is a TransientLlmError (retryable)', async () => {
    const t = transportWith((c) => {
      c.enqueue(chunk({ role: 'assistant', content: '' }) as never);
      c.enqueue(chunk({ content: 'The capital of France is' }) as never);
      c.error(new TypeError('terminated'));
    });
    const err = await t.stream(req, { onText() {} }, new AbortController().signal).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TransientLlmError);
  });

  it('(b) a body that ends without finish_reason/[DONE] is not accepted as a complete end_turn answer', async () => {
    const t = transportWith((c) => {
      c.enqueue(chunk({ role: 'assistant', content: '' }) as never);
      c.enqueue(chunk({ content: 'Step 1: stop the service. Step 2: delete' }) as never);
      c.close();
    });
    const out = await t.stream(req, { onText() {} }, new AbortController().signal).then((r) => r, (e: unknown) => e);
    expect(out instanceof TransientLlmError || (out as { message?: { stop_reason?: string } }).message?.stop_reason !== 'end_turn', `got ${JSON.stringify((out as { message?: unknown }).message ?? String(out)).slice(0, 160)}`).toBe(true);
  });
});
