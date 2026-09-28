// WP1 — scripts/admin.ts (01 §11.8): stats, verify-ledger, purge-user, refund, set-webhook, rewrap. Offline: the app and
// fetch are injected; tokens are never printed.
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../src/app.ts';
import { mergeConfig, type Config } from '../../../src/config.ts';
import { ALLOWED_UPDATES_ALL } from '../../../src/contracts/telegram.ts';
import { createCrypto } from '../../../src/db/crypto.ts';
import { openKeyStore } from '../../../src/db/keystore.ts';
import { createPrivacyService } from '../../../src/privacy/index.ts';
import { runAdmin, type AdminDeps } from '../../../scripts/admin.ts';
import { HASH_KEY } from '../db/env.ts';
import { privEnv, seedUser, type PrivEnv } from './env.ts';

let p: PrivEnv;
afterEach(() => p?.dispose());

const TOKEN = '123456:SECRET-token';
function deps(o: Partial<AdminDeps> & { cfg?: Partial<Config> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const config = mergeConfig(p.s.config, { dataDir: p.dataDir, keysDbPath: p.keysDbPath, ...(o.cfg ?? {}) } as never);
  const d: AdminDeps = {
    config,
    env: {},
    fetchImpl: (async () => {
      throw new Error('no network');
    }) as unknown as typeof fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...o,
  };
  return { d, out, err, json: () => JSON.parse(out.join('\n')) as Record<string, any> };
}

describe('scripts/admin.ts', () => {
  it('stats reports counts from gora.db', async () => {
    p = privEnv();
    seedUser(p);
    seedUser(p);
    const x = deps();
    expect(await runAdmin(['stats'], x.d)).toBe(0);
    const j = x.json();
    expect(j.usersByStatus).toEqual({ active: 2 });
    expect(j.usersByPlan).toEqual({ free: 2 });
    expect(j.ledgerRows).toBe(4);
    expect(j.epochsAwaitingShred).toBe(2);
  });

  it('verify-ledger verifies one user by Telegram id; unknown ids and bad args fail', async () => {
    p = privEnv();
    seedUser(p, 777);
    const x = deps();
    expect(await runAdmin(['verify-ledger', '777'], x.d)).toBe(0);
    expect(x.json()).toEqual({ tgUserId: 777, ok: true });
    const y = deps();
    expect(await runAdmin(['verify-ledger', '778'], y.d)).toBe(1);
    expect(y.err.join()).toMatch(/no user/);
    const z = deps();
    expect(await runAdmin(['verify-ledger', 'abc'], z.d)).toBe(2);
    expect(z.err.join()).toMatch(/usage/);
    expect(await runAdmin(['bogus'], deps().d)).toBe(2);
    expect(await runAdmin([], deps().d)).toBe(0);
  });

  it('purge-user runs the full deletion plan through the app services', async () => {
    p = privEnv();
    const { u } = seedUser(p, 555);
    p.s.privacy = createPrivacyService(p.s);
    let stopped = false;
    const app = { s: p.s, stop: async () => void (stopped = true) } as unknown as App;
    const x = deps({ openApp: async () => app });
    expect(await runAdmin(['purge-user', '555'], x.d)).toBe(0);
    expect(p.repos.users.getById(u.id)).toBeUndefined();
    expect(stopped).toBe(true);
    expect(x.json()).toEqual({ purged: true, tgUserId: 555 });
  });

  it('refund calls s.payments.refund(tgUserId, chargeId)', async () => {
    p = privEnv();
    const calls: unknown[] = [];
    const app = { s: { payments: { refund: async (...a: unknown[]) => void calls.push(a) } }, stop: async () => {} } as unknown as App;
    const x = deps({ openApp: async () => app });
    expect(await runAdmin(['refund', '42', 'ch_1'], x.d)).toBe(0);
    expect(calls).toEqual([[42, 'ch_1']]);
    expect(await runAdmin(['refund', '42'], deps({ openApp: async () => app }).d)).toBe(2);
  });

  it('set-webhook posts url, secret and allowedUpdates(features) and never prints the token', async () => {
    p = privEnv();
    const seen: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: true, description: 'Webhook was set' }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const x = deps({ fetchImpl, cfg: { publicUrl: 'https://gora.example.com/', telegram: { ...p.s.config.telegram, token: TOKEN, webhookSecret: 'whsec' }, features: { ...p.s.config.features, business: false, guest: true } } });
    expect(await runAdmin(['set-webhook'], x.d)).toBe(0);
    expect(seen[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(seen[0]!.body).toMatchObject({ url: 'https://gora.example.com/tg/webhook', secret_token: 'whsec', max_connections: 40, drop_pending_updates: false });
    expect(seen[0]!.body.allowed_updates.some((u: string) => u.includes('business'))).toBe(false);
    expect(seen[0]!.body.allowed_updates).toContain('guest_message');
    expect(seen[0]!.body.allowed_updates.length).toBeLessThan(ALLOWED_UPDATES_ALL.length);
    expect(x.out.join() + x.err.join()).not.toContain('SECRET');
    const y = deps({ cfg: { publicUrl: 'http://insecure' , telegram: { ...p.s.config.telegram, token: TOKEN } } });
    expect(await runAdmin(['set-webhook'], y.d)).toBe(1);
    expect(y.err.join()).toMatch(/https/);
  });

  it('rewrap re-wraps every DEK under GORA_KEK_NEW after backing keys.db up', async () => {
    p = privEnv();
    seedUser(p);
    const ct = p.crypto.seal('sys', 'payload', 'a');
    p.ks.close();
    const newKek = new Uint8Array(32).fill(11);
    const x = deps({ env: { GORA_KEK_NEW: Buffer.from(newKek).toString('base64') } });
    expect(await runAdmin(['rewrap'], x.d)).toBe(0);
    const j = x.json();
    expect(j.rewrapped).toBeGreaterThanOrEqual(4);
    expect(j.kekVersion).toBe(2);
    expect(j.backup).toMatch(/keys-\d{8}T\d{6}Z\.db$/);
    const ks = openKeyStore(p.keysDbPath, newKek);
    expect(createCrypto(ks, HASH_KEY).openText(ct, 'a')).toBe('payload');
    ks.close();
    expect(await runAdmin(['rewrap'], deps().d)).toBe(2); // GORA_KEK_NEW missing
  });
});
