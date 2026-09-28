// PROOF (agent review): tool_use_failed is retried at TWO layers. GroqTransport.stream() already does the one retry the
// specs call for (02 §B.5 / 03 R1: "append a system note listing the valid tool names, retry once"), then throws
// BadRequestLlmError('tool_use_failed'); engine.ts handleError() treats that code like a JSON error and re-issues the whole
// stream up to twice more (`jsonRetries < 2`), each re-issue again doing the transport's retry — and WITHOUT the note.
// One failing step = 6 full-prompt main-model calls (~6 × 5 000 tokens against an 8 000 TPM bucket).
import { readFileSync } from 'node:fs';
import { APIError } from 'groq-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'groq-sdk/resources/chat/completions';
import type { GroqClient } from '../../../src/contracts/index.ts';
import { createRateGovernor } from '../../../src/agent/groq/rate.ts';
import { createGroqTransport } from '../../../src/agent/groq/transport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, userSays } from './_app.ts';

const chunks = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/sse/${name}`, import.meta.url), 'utf8')) as ChatCompletionChunk[];
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('tool_use_failed retry budget', () => {
  it('a step that keeps failing with tool_use_failed costs at most 2 main-model calls (one retry)', async () => {
    const x = await agentApp({ env: { LLM_PROVIDER: 'groq' } });
    app = x.t;
    const models = x.t.s.config.groq.models;
    let calls = 0;
    const client = {
      chat: { completions: { create() {
        calls += 1;
        return { withResponse: async () => ({
          response: { headers: new Headers({ 'x-request-id': `r${calls}` }), status: 200 },
          data: (async function* () {
            for (const c of chunks('groq-text.json').slice(0, 3)) yield c;
            throw new APIError(undefined, { message: "Tool call validation failed: attempted to call tool 'gmail_send' which was not in request.tools", type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: '{}', status_code: 400 }, undefined, undefined);
          })(),
        }) };
      } } },
    } as unknown as GroqClient;
    const governor = createRateGovernor({ clock: x.t.clock, log, repo: null, tier: 'free', models, interactiveWaitMs: 4_000, busyWaitMaxMs: 45_000 });
    const groq = createGroqTransport({ client, governor, clock: x.t.clock, log, models, profile: x.t.s.config.profile, newId: () => 'id' });
    (x.t.llm as unknown as { stream: typeof groq.stream }).stream = (req, h, sig, o) => groq.stream(req, h, sig, o);
    await userSays(x.t, x.conv, 'email Anna that I am late');
    expect(calls).toBeLessThanOrEqual(2);
  });
});
