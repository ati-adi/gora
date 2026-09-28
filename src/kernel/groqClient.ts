// kernel/groqClient.ts (WP0) — the ONLY construction site of the groq-sdk client (03 R6).
// maxRetries:0 because the SDK sleeps uncapped on retry-after; the RateGovernor (WP3) owns retries.
import Groq from 'groq-sdk';
import type { GroqClient } from '../contracts/llm.ts';

export function createGroqClient(o: { apiKey: string; fetchImpl: typeof fetch; timeoutMs?: number; baseURL?: string }): GroqClient {
  return new Groq({ apiKey: o.apiKey, maxRetries: 0, fetch: o.fetchImpl, timeout: o.timeoutMs ?? 60_000, ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
}
