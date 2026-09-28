// PROOF (agent review): the tool_use_failed retry (groq/transport.ts stream(), `code === 'tool_use_failed'` branch)
// appends toolUseFailedNote() to the ALREADY-FITTED translation and re-sends it without re-applying fitToBudget. A request
// sitting just under the groq-free hard ceiling (5 200 estimated tokens, 03 R2) is re-sent above it. The note grows with
// the active tool names and the 200-char error text, so with many kits loaded the overshoot is ~100–200 tokens.
import { readFileSync } from 'node:fs';
import { APIError } from 'groq-sdk';
import { describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'groq-sdk/resources/chat/completions';
import type { GroqClient, MainRequest } from '../../../src/contracts/index.ts';
import { PROVIDER_PROFILES } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createRateGovernor } from '../../../src/agent/groq/rate.ts';
import { createGroqTransport } from '../../../src/agent/groq/transport.ts';
import { estimateTranslated, translateRequest } from '../../../src/agent/groq/map.ts';

const chunks = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/sse/${name}`, import.meta.url), 'utf8')) as ChatCompletionChunk[];
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
const models = { main: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', vision: 'qwen/qwen3.8-27b', sentinel: 'openai/gpt-oss-safeguard-20b', guard: 'meta-llama/llama-prompt-guard-2-86m', stt: 'whisper-large-v3-turbo', tts: 'canopylabs/orpheus-v1-english' };

describe('tool_use_failed retry and the hard ceiling', () => {
  it('the retried request still fits maxPromptTokens', async () => {
    const profile = PROVIDER_PROFILES['groq-free'];
    const sent: Array<Record<string, unknown>> = [];
    let n = 0;
    const client = {
      chat: { completions: { create(params: Record<string, unknown>) {
        sent.push(structuredClone(params));
        const i = n++;
        return { withResponse: async () => {
          const response = { headers: new Headers({ 'x-request-id': `req_${i}` }), status: 200 };
          async function* gen() {
            const all = chunks('groq-text.json');
            if (i === 0) {
              for (const c of all.slice(0, 3)) yield c; // reasoning deltas…
              throw new APIError(undefined, { message: "Tool call validation failed: attempted to call tool 'calendar_find_free_slots_for_everyone' which was not in request.tools", type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: '{}', status_code: 400 }, undefined, undefined);
            }
            for (const c of all) yield c;
          }
          return { data: gen(), response };
        } };
      } } },
    } as unknown as GroqClient;
    const clock = new FakeClock();
    const governor = createRateGovernor({ clock, log, repo: null, tier: 'free', models, interactiveWaitMs: 4_000, busyWaitMaxMs: 45_000 });
    const transport = createGroqTransport({ client, governor, clock, log, models, profile, newId: () => 'id' });
    const tools = Array.from({ length: 20 }, (_, i) => ({ name: `tool_number_${i}`, description: 'x', input_schema: { type: 'object', properties: {} } }));
    const base = (text: string) => ({
      model: `groq:${models.main}`, max_tokens: 1_200, system: [{ type: 'text', text: 'SYSTEM' }], tools,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }], output_config: { effort: 'low' },
    }) as unknown as MainRequest;
    // size the owner's (current run-start) message so the translated request is just under the ceiling
    let len = 1_000;
    const est = (l: number) => estimateTranslated(translateRequest(base('a'.repeat(l)), { mediaText: () => '', maxOutputTokens: 1_200 }));
    while (est(len + 32) <= profile.maxPromptTokens) len += 32;
    expect(est(len)).toBeLessThanOrEqual(profile.maxPromptTokens);
    await transport.stream(base('a'.repeat(len)), { onText() {} }, new AbortController().signal);
    expect(sent).toHaveLength(2);
    const retried = { messages: sent[1]!['messages'] as never, tools: (sent[1]!['tools'] ?? []) as never };
    const size = estimateTranslated(retried);
    expect(size, `retried request is ${size} estimated tokens`).toBeLessThanOrEqual(profile.maxPromptTokens);
  });
});
