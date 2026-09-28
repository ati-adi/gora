// Shared env for WP5 capability tests: a fake groq-sdk client recording every request, a pass-through governor, and the
// Services bits the capabilities touch.
import type { GroqClient, LlmCallRecord, Services } from '../../../src/contracts/index.ts';
import { PROVIDER_PROFILES, testConfig } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { createFakeCapabilities, createFakeCrypto, createFakeKeyStore, createFakeQuotas, createMemoryCoreRepos, notImplemented } from '../../harness/fakes.ts';

export interface Recorded { api: 'chat' | 'transcribe' | 'speech'; body: Record<string, unknown> }

/** `reply(api, body)` returns the parsed payload (or a Response for speech); throw to simulate an API error. */
export function fakeGroq(reply: (api: Recorded['api'], body: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: Recorded[] = [];
  const wrap = (api: Recorded['api'], body: Record<string, unknown>) => {
    calls.push({ api, body });
    const p = Promise.resolve().then(() => reply(api, body));
    return Object.assign(p, { withResponse: async () => ({ data: await p, response: new Response(null, { status: 200, headers: { 'x-request-id': 'req_1' } }) }) });
  };
  const client = {
    chat: { completions: { create: (b: Record<string, unknown>) => wrap('chat', b) } },
    audio: { transcriptions: { create: (b: Record<string, unknown>) => wrap('transcribe', b) }, speech: { create: (b: Record<string, unknown>) => wrap('speech', b) } },
  } as unknown as GroqClient;
  return { client, calls };
}

export function capEnv(o: { groq?: GroqClient | null; provider?: 'anthropic' | 'groq' } = {}) {
  const clock = new FakeClock();
  const repos = createMemoryCoreRepos(clock);
  const llmCalls: LlmCallRecord[] = [];
  (repos.runs as unknown as { recordLlmCall: (c: LlmCallRecord) => void }).recordLlmCall = (c) => llmCalls.push(c);
  const acquired: Array<{ role: string; model: string; priority: string }> = [];
  const s = {
    config: testConfig(), clock, log: nullLogger, repos, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(3)), quotas: createFakeQuotas(clock),
    groq: o.groq ?? null,
    profile: o.provider === 'groq' ? PROVIDER_PROFILES['groq-free'] : PROVIDER_PROFILES.anthropic,
    rateGovernor: { acquire: async (q: { role: string; model: string; priority: string }) => (acquired.push({ role: q.role, model: q.model, priority: q.priority }), { model: q.model }), observe: () => {} },
    caps: createFakeCapabilities(() => clock.now()),
    telegram: notImplemented('telegram'),
    transport: notImplemented('transport'),
  } as unknown as Services & { caps: ReturnType<typeof createFakeCapabilities> };
  s.capabilities = s.caps;
  return { s, clock, llmCalls, acquired };
}
