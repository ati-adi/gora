import { describe, expect, it } from 'vitest';
import { createGroqClient } from '../../../src/kernel/groqClient.ts';

describe('kernel/groqClient (03 R6)', () => {
  it('uses the injected fetch and never retries on its own (maxRetries: 0)', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '35', 'x-ratelimit-remaining-tokens': '0' },
      });
    }) as typeof fetch;
    const client = createGroqClient({ apiKey: 'gsk_test_not_real', fetchImpl });
    const err = await client.chat.completions.create({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 5 }).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(429);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions$/);
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(60_000);
  });
});
