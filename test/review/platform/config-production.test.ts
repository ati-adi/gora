// Review (platform): 01 §14 — "In production: … an HTTPS PUBLIC_URL [is] required". PUBLIC_URL has a schema default
// ('https://gora.example.com', src/config.ts EnvSchema) and the production check only tests startsWith('https://'),
// so a production deployment that forgot PUBLIC_URL boots fine: setWebhook, the menu button, the Mini App links, the
// OAuth callbackUrl and the export download URL all point at gora.example.com (webhook mode: the bot goes deaf).
// FIXED: src/config.ts requires an explicitly set, non-placeholder PUBLIC_URL in production.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.ts';

const key = () => randomBytes(32).toString('base64');
const PROD = {
  NODE_ENV: 'production',
  GORA_MODE: 'webhook',
  TELEGRAM_BOT_TOKEN: '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ',
  TELEGRAM_WEBHOOK_SECRET: 'whsecret',
  GORA_KEK: key(),
  GORA_CALLBACK_KEY: key(),
  GORA_HASH_KEY: key(),
  GROQ_API_KEY: 'gsk_test_not_used',
  INTEGRATIONS_PROVIDER: 'none',
  DATA_DIR: '/srv/gora/data',
  KEYS_DB_PATH: '/srv/gora/keys/keys.db',
  BACKUP_DIR: '/srv/gora/backups',
};

describe('production config validation', () => {
  it('sanity: a complete production env loads', () => {
    expect(loadConfig({ ...PROD, PUBLIC_URL: 'https://bot.real-domain.test' }).publicUrl).toBe('https://bot.real-domain.test');
  });
  it('refuses to boot in production without PUBLIC_URL (no silent placeholder domain)', () => {
    expect(() => loadConfig(PROD)).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...PROD, PUBLIC_URL: '  ' })).toThrow(/PUBLIC_URL/);
  });
  it('refuses the example placeholder domain in production', () => {
    expect(() => loadConfig({ ...PROD, PUBLIC_URL: 'https://gora.example.com' })).toThrow(/PUBLIC_URL/);
  });
  it('development still loads without PUBLIC_URL', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).publicUrl).toBe('https://gora.example.com');
  });
});
