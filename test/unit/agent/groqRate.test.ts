// WP3 — 03 R6 RateGovernor: reset-duration parser, window accounting, header sync, fallback chain, priority deferral,
// interactive busy wait, 429 penalty, daily counters in llm_rate_daily, and the daily degrade (LlmBudget).
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { TransientLlmError } from '../../../src/kernel/errors.ts';
import { createRateGovernor, parseResetDuration, passThroughGovernor } from '../../../src/agent/groq/rate.ts';
import { createRateDailyRepo, utcDay } from '../../../src/agent/groq/repo.ts';
import { budgetAllows, createGroqBudget } from '../../../src/agent/groq/budget.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
const models = { main: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', vision: 'qwen/qwen3.8-27b', sentinel: 'openai/gpt-oss-safeguard-20b', guard: 'meta-llama/llama-prompt-guard-2-86m', stt: 'whisper-large-v3-turbo', tts: 'canopylabs/orpheus-v1-english' };
const gov = (clock: FakeClock, repo: ReturnType<typeof createRateDailyRepo> | null = null) =>
  createRateGovernor({ clock, log, repo, tier: 'free', models, interactiveWaitMs: 4_000, busyWaitMaxMs: 45_000 });

describe('parseResetDuration', () => {
  it('parses the Groq formats', () => {
    expect(parseResetDuration('2.085s')).toBe(2085);
    expect(parseResetDuration('1m26.4s')).toBe(86_400);
    expect(parseResetDuration('7h12m0s')).toBe(25_920_000);
    expect(parseResetDuration('450ms')).toBe(450);
    expect(parseResetDuration('0s')).toBe(0);
    expect(parseResetDuration('35')).toBe(35_000);
    expect(parseResetDuration('soon')).toBeNull();
    expect(parseResetDuration('')).toBeNull();
    expect(parseResetDuration(null)).toBeNull();
  });
});

describe('RateGovernor', () => {
  it('window accounting: TPM fills, then the fallback chain takes over (main 120b → qwen → 20b)', async () => {
    const clock = new FakeClock();
    const g = gov(clock);
    expect(g.chain('main', models.main)).toEqual([models.main, models.vision, models.fast]);
    expect(g.chain('fast', models.fast)).toEqual([models.fast, models.main]);
    expect(g.chain('guard', models.guard)).toEqual([models.guard]);
    expect((await g.acquire({ role: 'main', model: models.main, estTokens: 5_000, priority: 'interactive' })).model).toBe(models.main);
    // 5 000 + 5 000 > 8 000 TPM: the wait is ~60 s > 4 s → the next model of the chain
    expect((await g.acquire({ role: 'main', model: models.main, estTokens: 5_000, priority: 'interactive' })).model).toBe(models.vision);
    expect(g.waitMs(models.main, 5_000, 'interactive')).toBeGreaterThan(4_000);
    await clock.advance(61_000);
    expect(g.waitMs(models.main, 5_000, 'interactive')).toBe(0);
  });

  it('header sync: remaining tokens from x-ratelimit-* bound the bucket; usage settles the reservation', async () => {
    const clock = new FakeClock();
    const g = gov(clock);
    await g.acquire({ role: 'main', model: models.main, estTokens: 1_000, priority: 'interactive' });
    g.observe(models.main, { headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '1200', 'x-ratelimit-reset-tokens': '50s', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '990', 'x-ratelimit-reset-requests': '7h12m0s' }, status: 200 });
    expect(g.waitMs(models.main, 2_000, 'interactive')).toBeGreaterThan(0);
    expect(g.waitMs(models.main, 1_000, 'interactive')).toBe(0);
    g.observe(models.main, { usage: { promptTokens: 900, completionTokens: 50 } });
    expect(g.snapshot()[models.main]!.rpdUsed).toBe(10);
    expect(g.snapshot()[models.main]!.rpdLimit).toBe(1000);
  });

  it('priority deferral: background keeps a reserve free for interactive and is deferred with rate_limit', async () => {
    const clock = new FakeClock();
    const g = gov(clock);
    await g.acquire({ role: 'fast', model: models.fast, estTokens: 5_500, priority: 'interactive' });
    await g.acquire({ role: 'main', model: models.main, estTokens: 5_500, priority: 'interactive' });
    // 8 000 − 5 500 = 2 500 left on each; background must leave 25 % (2 000) → 1 000 does not fit anywhere
    await expect(g.acquire({ role: 'fast', model: models.fast, estTokens: 1_000, priority: 'background' })).rejects.toBeInstanceOf(TransientLlmError);
    // interactive may use it all
    expect((await g.acquire({ role: 'fast', model: models.fast, estTokens: 1_000, priority: 'interactive' })).model).toBe(models.fast);
  });

  it('interactive busy wait: onBusy(seconds), then goes when a bucket frees up (≤ 45 s)', async () => {
    const clock = new FakeClock();
    const g = gov(clock);
    for (const m of [models.main, models.vision, models.fast]) {
      await g.acquire({ role: m === models.fast ? 'fast' : 'main', model: m, estTokens: 7_900, priority: 'interactive' });
      g.observe(m, { status: 429, headers: { 'retry-after': '20' } });
    }
    const busy: number[] = [];
    const p = g.acquire({ role: 'main', model: models.main, estTokens: 3_000, priority: 'interactive', onBusy: (s) => busy.push(s) });
    await Promise.resolve();
    await clock.advance(25_000);
    await clock.advance(40_000);
    const r = await p;
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]).toBeGreaterThan(0);
    expect([models.main, models.vision, models.fast]).toContain(r.model);
  });

  it('429 penalty honours retry-after and a hopeless interactive call throws rate_limit with retryAfterMs', async () => {
    const clock = new FakeClock();
    const g = gov(clock);
    g.observe(models.guard, { status: 429, headers: { 'retry-after': '120' } });
    await expect(g.acquire({ role: 'guard', model: models.guard, estTokens: 100, priority: 'interactive' })).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('daily counters persist in llm_rate_daily and reload after a restart', async () => {
    const t = openTmpDb();
    try {
      const clock = new FakeClock();
      const repo = createRateDailyRepo(t.db);
      const g = gov(clock, repo);
      await g.acquire({ role: 'fast', model: models.fast, estTokens: 100, priority: 'background' });
      g.observe(models.fast, { usage: { promptTokens: 80, completionTokens: 20 } });
      const row = repo.get(models.fast, utcDay(clock.now()))!;
      expect(row).toMatchObject({ requests: 1, tokens: 100 });
      g.observe(models.fast, { headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '900' } });
      expect(repo.get(models.fast, utcDay(clock.now()))).toMatchObject({ requests: 100, rpdLimit: 1000 });
      const g2 = gov(clock, repo);
      expect(g2.dailyUse(models.fast)).toBeCloseTo(0.1, 5);
      expect(repo.pruneBefore('2099-01-01')).toBeGreaterThan(0);
    } finally {
      t.close();
      t.cleanup();
    }
  });

  it('pass-through governor (anthropic) never waits', async () => {
    expect(await passThroughGovernor().acquire({ role: 'main', model: 'm', estTokens: 1e9, priority: 'proactive' })).toEqual({ model: 'm' });
  });
});

describe('daily degrade (LlmBudget)', () => {
  it('≥ 85 % pauses proactive and background; ≥ 97 % only interactive', () => {
    expect(budgetAllows('proactive', 0.5, 0.85, 0.97)).toBe(true);
    expect(budgetAllows('proactive', 0.86, 0.85, 0.97)).toBe(false);
    expect(budgetAllows('background', 0.86, 0.85, 0.97)).toBe(false);
    expect(budgetAllows('reminder', 0.86, 0.85, 0.97)).toBe(true);
    expect(budgetAllows('approval', 0.97, 0.85, 0.97)).toBe(false);
    expect(budgetAllows('interactive', 0.99, 0.85, 0.97)).toBe(true);
  });
  it('reads the main model daily use from the governor', () => {
    const clock = new FakeClock();
    const g = gov(clock);
    g.observe(models.main, { headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '100', 'x-ratelimit-reset-requests': '1h0m0s' } });
    const b = createGroqBudget(g, models.main, { proactiveAt: 0.85, interactiveOnlyAt: 0.97 });
    expect(b.allow('background')).toBe(false);
    expect(b.allow('reminder')).toBe(true);
    expect(b.snapshot()[models.main]).toMatchObject({ rpdUsed: 900, rpdLimit: 1000 });
  });
});
