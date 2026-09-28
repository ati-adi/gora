// Review (platform): POST /api/memory/import (src/http/routes/memory.ts) triggers an LLM side call
// (memory.importText → side.importFacts → transport.parse, priority 'interactive') on EVERY request with no quota,
// cost-cap or cooldown check. 01 §11.8: the daily cost cap is checked "before any LLM call". The only limiter is the
// generic 240 req/min Mini App bucket — 12× the DM limit (20/min) that gates the same import in the chat — so one
// user past their daily cost cap can keep spending the operator's LLM budget (Anthropic $) or drain the shared Groq
// free-tier RPD/TPM for everyone, ~20k chars (≈6k tokens) per call.
import { afterEach, describe, expect, it } from 'vitest';
import { PLANS } from '../../../src/config.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('Mini App memory import respects the LLM cost cap / quotas', () => {
  it('a user over the daily cost cap cannot trigger more LLM calls through /api/memory/import', async () => {
    t = await createTestApp();
    expect((await t.api('PATCH', '/api/memory/consent', { on: true })).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    // Today's spend is already past the free plan's daily cost cap: the chat path refuses LLM work now.
    t.s.quotas.recordUsage(u.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: PLANS.free.dailyCostCapMicros + 1 });
    expect(t.s.quotas.check(u.id, 'cost_micros', 0).ok).toBe(false);

    const before = t.llm.parseRequests.length;
    for (let i = 0; i < 10; i++) {
      t.llm.pushParse('import', { facts: [] });
      await t.api('POST', '/api/memory/import', { text: `My notes ${i}: ${'I like tea. '.repeat(1500)}` });
    }
    const llmCalls = t.llm.parseRequests.length - before;
    expect(llmCalls, `${llmCalls} LLM calls made for a user over the daily cost cap`).toBe(0);
  });

  it('an in-quota user is limited to a few imports a minute (429 after that, no LLM call)', async () => {
    t = await createTestApp();
    expect((await t.api('PATCH', '/api/memory/consent', { on: true })).status).toBe(200);
    const statuses: number[] = [];
    const before = t.llm.parseRequests.length;
    for (let i = 0; i < 5; i++) {
      t.llm.pushParse('import', { facts: [] });
      statuses.push((await t.api('POST', '/api/memory/import', { text: `Notes ${i}: I like tea and long walks.` })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(t.llm.parseRequests.length - before).toBe(3);
  });
});
