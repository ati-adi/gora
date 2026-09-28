import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BETAS, betasFor, BLOCKED_DOMAINS, decodeKey, loadConfig, mergeConfig, PLANS, PROVIDER_PROFILES, resolveProfile, ROUTES, testConfig } from '../../../src/config.ts';
import { ConfigError } from '../../../src/kernel/errors.ts';

const b64 = () => randomBytes(32).toString('base64');
const prodEnv = (): Record<string, string> => ({
  NODE_ENV: 'production',
  GORA_MODE: 'webhook',
  TELEGRAM_BOT_TOKEN: '123456:AAAA-fake-token-for-tests',
  TELEGRAM_WEBHOOK_SECRET: 'wh_secret-1',
  GORA_KEK: b64(),
  GORA_CALLBACK_KEY: b64(),
  GORA_HASH_KEY: b64(),
  GROQ_API_KEY: 'gsk_fake_not_a_real_key',
  PUBLIC_URL: 'https://bot.gora-test.dev',
  DATA_DIR: '/data',
  KEYS_DB_PATH: '/keys/keys.db',
  INTEGRATIONS_PROVIDER: 'none',
});
const issuesOf = (env: Record<string, string>): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
};

describe('config (01 §14, 02 §F, 03 R2/R7)', () => {
  it('test mode forces fakes, polling, the demo transport and a test token; no env needed', () => {
    const c = loadConfig({ NODE_ENV: 'test', GORA_MODE: 'webhook', STT_PROVIDER: 'groq', WEATHER_PROVIDER: 'openmeteo', FX_PROVIDER: 'erapi', GEO_PROVIDER: 'live', INTEGRATIONS_PROVIDER: 'composio', GROQ_API_KEY: 'gsk_x', ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(c.env).toBe('test');
    expect(c.mode).toBe('polling');
    expect(c.providers).toMatchObject({ integrations: 'fake', stt: 'fake', weather: 'fake', fx: 'fake', geo: 'fake' });
    expect(c.llm.transport).toBe('demo');
    expect(c.anthropic.apiKey).toBeUndefined();
    expect(c.groq.apiKey).toBeUndefined();
    expect(c.keys.groq).toBeUndefined();
    expect(c.telegram.token).toBe('TEST_TOKEN');
    expect(c.telegram.webhookSecret).toBeTruthy();
    expect(c.secrets.insecureDefaults).toBe(true);
    expect(c.secrets.kek).toHaveLength(32);
    expect(c.profile.id).toBe('anthropic');
  });
  it('test mode can select the Groq profile explicitly', () => {
    const c = loadConfig({ NODE_ENV: 'test', LLM_PROVIDER: 'groq' });
    expect(c.profile.id).toBe('groq-free');
    expect(c.profile.toolMode).toBe('toolkits');
    expect(c.llm.transport).toBe('demo');
  });
  it('development defaults', () => {
    const c = loadConfig({});
    expect(c.env).toBe('development');
    expect(c.mode).toBe('polling');
    expect(c.port).toBe(8080);
    expect(c.providers.integrations).toBe('fake');
    expect(c.providers.weather).toBe('openmeteo');
    expect(c.features).toMatchObject({ serverCompaction: true, clearAt: false, webFetchUrlSources: true, businessRich: false });
    expect(c.frameAncestors).toBe('https://web.telegram.org https://*.telegram.org');
    expect(c.llm.transport).toBe('demo');
    expect(c.routes).toBe(ROUTES);
    expect(c.plans).toBe(PLANS);
    expect(c.blockedDomains).toBe(BLOCKED_DOMAINS);
  });
  it('production accepts a complete env (Groq key only — ANTHROPIC_API_KEY is optional, 03 R7)', () => {
    const c = loadConfig(prodEnv());
    expect(c.env).toBe('production');
    expect(c.mode).toBe('webhook');
    expect(c.llm.transport).toBe('groq');
    expect(c.profile.id).toBe('groq-free');
    expect(c.secrets.insecureDefaults).toBe(false);
    expect(c.anthropic.apiKey).toBeUndefined();
  });
  it('production requirements', () => {
    const all = issuesOf({ NODE_ENV: 'production' });
    for (const needle of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'GORA_KEK', 'GORA_CALLBACK_KEY', 'GORA_HASH_KEY', 'LLM key', 'INTEGRATIONS_PROVIDER=fake']) {
      expect(all.join('\n')).toContain(needle);
    }
    expect(issuesOf({ ...prodEnv(), PUBLIC_URL: 'http://bot.gora-test.dev' }).join()).toContain('https');
    expect(issuesOf({ ...prodEnv(), KEYS_DB_PATH: '/data/keys/keys.db' }).join()).toContain('KEYS_DB_PATH');
    expect(issuesOf({ ...prodEnv(), INTEGRATIONS_PROVIDER: 'fake' }).join()).toContain('INTEGRATIONS_PROVIDER=fake');
    expect(issuesOf({ ...prodEnv(), GROQ_API_KEY: '' }).join()).toContain('LLM key');
    expect(issuesOf({ ...prodEnv(), LLM_PROVIDER: 'anthropic' }).join()).toContain('LLM key');
    expect(issuesOf({ ...prodEnv(), INTEGRATIONS_PROVIDER: 'composio' }).join()).toContain('COMPOSIO_API_KEY');
  });
  it('STT provider: auto resolves from the keys (02 §A); fake is refused against a real bot token', () => {
    expect(loadConfig({ GROQ_API_KEY: 'gsk_fake' }).providers.stt).toBe('groq');
    expect(loadConfig({ GROQ_API_KEY: 'gsk_fake', STT_PROVIDER: 'auto' }).providers.sttModel).toBe('whisper-large-v3-turbo');
    expect(loadConfig({ OPENAI_API_KEY: 'sk-fake' }).providers).toMatchObject({ stt: 'openai', sttModel: 'gpt-transcribe' });
    expect(loadConfig({}).providers.stt).toBe('none');
    expect(loadConfig({ GROQ_API_KEY: 'gsk_fake', STT_PROVIDER: 'none' }).providers.stt).toBe('none');
    expect(loadConfig({ STT_PROVIDER: 'fake' }).providers.stt).toBe('fake');
    expect(issuesOf({ STT_PROVIDER: 'fake', TELEGRAM_BOT_TOKEN: '123456:AAAA-fake-token-for-tests' }).join()).toContain('STT_PROVIDER=fake');
    expect(loadConfig({ ...prodEnv() }).providers.stt).toBe('groq');
    expect(loadConfig({ NODE_ENV: 'test', GROQ_API_KEY: 'gsk_x', STT_PROVIDER: 'auto' }).providers.stt).toBe('fake');
  });
  it('rejects malformed values with readable errors', () => {
    expect(issuesOf({ PORT: 'abc' }).join()).toContain('PORT');
    expect(issuesOf({ TELEGRAM_BOT_TOKEN: 'nope' }).join()).toContain('TELEGRAM_BOT_TOKEN');
    expect(issuesOf({ TELEGRAM_WEBHOOK_SECRET: 'bad secret!' }).join()).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(issuesOf({ GORA_MODE: 'push' }).join()).toContain('GORA_MODE');
    expect(issuesOf({ FEATURE_GUEST: 'maybe' }).join()).toContain('FEATURE_GUEST');
    expect(issuesOf({ ADMIN_TG_IDS: '1,x' }).join()).toContain('ADMIN_TG_IDS');
    expect(issuesOf({ PRICING_OVERRIDES_JSON: '{' }).join()).toContain('PRICING_OVERRIDES_JSON');
    expect(issuesOf({ GORA_MODE: 'webhook' }).join()).toContain('TELEGRAM_WEBHOOK_SECRET');
  });
  it('secret decoding: base64 or base64url, exactly 32 bytes', () => {
    const issues: string[] = [];
    const k = randomBytes(32);
    expect(Buffer.from(decodeKey('K', k.toString('base64'), issues)!)).toEqual(k);
    expect(Buffer.from(decodeKey('K', k.toString('base64url'), issues)!)).toEqual(k);
    expect(issues).toEqual([]);
    expect(decodeKey('K', undefined, issues)).toBeNull();
    expect(decodeKey('K', randomBytes(16).toString('base64'), issues)).toBeNull();
    expect(decodeKey('K', 'not base64 !!', issues)).toBeNull();
    expect(issues).toHaveLength(2);
    const c = loadConfig({ GORA_KEK: k.toString('base64'), GORA_CALLBACK_KEY: b64(), GORA_HASH_KEY: b64() });
    expect(Buffer.from(c.secrets.kek)).toEqual(k);
    expect(c.secrets.insecureDefaults).toBe(false);
    expect(issuesOf({ GORA_KEK: 'AAAA' }).join()).toContain('GORA_KEK');
  });
  it('booleans, lists and numbers', () => {
    const c = loadConfig({ FEATURE_CLEAR_AT: 'true', FEATURE_BUSINESS: '0', ADMIN_TG_IDS: '1, 2,3', PORT: '9000', TELEGRAM_TEST_ENV: 'yes' });
    expect(c.features.clearAt).toBe(true);
    expect(c.features.business).toBe(false);
    expect(c.telegram.adminIds).toEqual([1, 2, 3]);
    expect(c.port).toBe(9000);
    expect(c.telegram.testEnv).toBe(true);
  });
  it('resolveProfile (03 R2)', () => {
    expect(resolveProfile({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ requested: 'auto', transport: 'anthropic', profile: { id: 'anthropic' } });
    expect(resolveProfile({ ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'g' }).transport).toBe('anthropic');
    expect(resolveProfile({ GROQ_API_KEY: 'g' })).toMatchObject({ transport: 'groq', profile: { id: 'groq-free', maxPromptTokens: 5_200, epochRotateTokens: 2_400, maxToolSteps: 8, caching: false, systemVariant: 'compact' } });
    expect(resolveProfile({ GROQ_API_KEY: 'g', GROQ_TIER: 'dev' }).profile).toMatchObject({ id: 'groq-dev', maxPromptTokens: 60_000, epochRotateTokens: 40_000 });
    expect(resolveProfile({})).toMatchObject({ transport: 'demo', profile: { id: 'anthropic' } });
    expect(resolveProfile({ LLM_PROVIDER: 'groq' })).toMatchObject({ requested: 'groq', transport: 'demo', profile: { provider: 'groq' } });
    expect(resolveProfile({ LLM_PROVIDER: 'anthropic', GROQ_API_KEY: 'g' })).toMatchObject({ transport: 'demo', profile: { id: 'anthropic' } });
    expect(resolveProfile({ GROQ_API_KEY: 'g', LLM_MAX_PROMPT_TOKENS: '4000' }).profile.maxPromptTokens).toBe(4000);
    expect(resolveProfile({ GROQ_API_KEY: 'g', GROQ_MODEL_MAIN: 'openai/gpt-oss-20b' }).profile.models.main).toBe('openai/gpt-oss-20b');
    expect(resolveProfile({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-opus-5-5' }).profile.models.main).toBe('claude-opus-5-5');
    expect(resolveProfile({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL_MAIN: 'a', ANTHROPIC_MODEL: 'b' }).profile.models.main).toBe('a');
    expect(PROVIDER_PROFILES.anthropic).toMatchObject({ maxPromptTokens: 150_000, epochRotateTokens: 120_000, maxToolSteps: 24, caching: true, toolMode: 'static' });
    expect(Object.isFrozen(resolveProfile({}).profile)).toBe(true);
  });
  it('betasFor, ROUTES, PLANS', () => {
    expect(betasFor({ serverCompaction: true, clearAt: false, cacheDiagnosis: false })).toEqual([BETAS.fallback, BETAS.compaction]);
    expect(betasFor({ serverCompaction: false, clearAt: true, cacheDiagnosis: true })).toEqual([BETAS.fallback, BETAS.clearAt, BETAS.cacheDiagnosis]);
    expect(ROUTES.chat).toEqual({ effort: 'medium', maxTokens: 32_000, toolset: 'FULL', maxTurns: 25 });
    expect(ROUTES.mission.maxTurns).toBe(40);
    expect(ROUTES.guest.toolset).toBe('GUEST');
    expect(PLANS.free.turnsPerDay).toBe(40);
    for (const p of Object.values(PLANS)) expect(p.priceXtr).toBeLessThanOrEqual(10_000);
    expect(BLOCKED_DOMAINS).toContain('webhook.site');
  });
  it('testConfig / mergeConfig', () => {
    const c = testConfig({ DATA_DIR: '/tmp/x' }, { features: { guest: false }, publicUrl: 'https://t.test' });
    expect(c.dataDir).toBe('/tmp/x');
    expect(c.features.guest).toBe(false);
    expect(c.features.groups).toBe(true);
    expect(c.publicUrl).toBe('https://t.test');
    expect(mergeConfig(c, {}).features).toEqual(c.features);
  });
});
