// WP8 (01 §15.2): valid, tampered and stale initData; `signature` kept in the data-check-string; freshness classes.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { dataCheckString, InitDataError, MAX_FUTURE_SKEW_SEC, tmaFromHeader, validateInitData } from '../../../src/http/auth.ts';
import { TEST_TOKEN } from '../../harness/fakeTelegram.ts';
import { signInitData, staleInitData, tamperInitData, verifyInitData } from '../../harness/initData.ts';
import { TEST_USER } from '../../harness/updates.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

const NOW = Date.UTC(2026, 8, 28, 9, 0, 0);
const nowSec = Math.floor(NOW / 1000);
const DAY = 24 * 3600;

function reason(f: () => unknown): string {
  try {
    f();
    return 'ok';
  } catch (e) {
    return e instanceof InitDataError ? e.reason : `other:${String(e)}`;
  }
}

describe('validateInitData (01 §12)', () => {
  it('accepts a correctly signed payload and returns the user', () => {
    const raw = signInitData(TEST_USER, { authDate: nowSec - 60, startParam: 'approval_A7K2QX' });
    const v = validateInitData(raw, TEST_TOKEN, DAY, NOW);
    expect(v.user.id).toBe(TEST_USER.id);
    expect(v.user.first_name).toBe(TEST_USER.first_name);
    expect(v.authDate).toBe(nowSec - 60);
    expect(v.startParam).toBe('approval_A7K2QX');
    // the harness reference validator agrees
    expect(verifyInitData(raw, TEST_TOKEN, DAY, NOW).ok).toBe(true);
  });

  it('rejects a tampered user, a wrong token, a missing or malformed hash', () => {
    const raw = signInitData(TEST_USER, { authDate: nowSec });
    expect(reason(() => validateInitData(tamperInitData(raw), TEST_TOKEN, DAY, NOW))).toBe('bad_hash');
    expect(reason(() => validateInitData(raw, '999:OTHER', DAY, NOW))).toBe('bad_hash');
    const p = new URLSearchParams(raw);
    p.delete('hash');
    expect(reason(() => validateInitData(p.toString(), TEST_TOKEN, DAY, NOW))).toBe('no_hash');
    p.set('hash', 'XYZ');
    expect(reason(() => validateInitData(p.toString(), TEST_TOKEN, DAY, NOW))).toBe('bad_hash');
    const dup = `${raw}&hash=${'0'.repeat(64)}`;
    expect(reason(() => validateInitData(dup, TEST_TOKEN, DAY, NOW))).toBe('bad_hash');
    expect(reason(() => validateInitData('', TEST_TOKEN, DAY, NOW))).toBe('missing');
    expect(reason(() => validateInitData(raw, '', DAY, NOW))).toBe('no_token');
  });

  it('keeps `signature` in the data-check-string (only `hash` is excluded)', () => {
    const raw = signInitData(TEST_USER, { authDate: nowSec, signature: 'c2lnbmF0dXJl' });
    const p = new URLSearchParams(raw);
    expect(dataCheckString(p)).toContain('signature=c2lnbmF0dXJl');
    expect(dataCheckString(p)).not.toContain('hash=');
    expect(validateInitData(raw, TEST_TOKEN, DAY, NOW).user.id).toBe(TEST_USER.id);
    // A validator that dropped `signature` would compute another hash: prove the signed hash covers it.
    const secret = createHmac('sha256', 'WebAppData').update(TEST_TOKEN).digest();
    const withoutSig = [...p.entries()].filter(([k]) => k !== 'hash' && k !== 'signature').map(([k, v]) => `${k}=${v}`).sort().join('\n');
    expect(createHmac('sha256', secret).update(withoutSig).digest('hex')).not.toBe(p.get('hash'));
    // Changing the signature therefore breaks the HMAC.
    p.set('signature', 'b3RoZXI');
    expect(reason(() => validateInitData(p.toString(), TEST_TOKEN, DAY, NOW))).toBe('bad_hash');
  });

  it('rejects stale and far-future auth_date', () => {
    expect(reason(() => validateInitData(staleInitData(TEST_USER, { nowMs: NOW, ageSec: DAY + 1 }), TEST_TOKEN, DAY, NOW))).toBe('stale');
    expect(reason(() => validateInitData(staleInitData(TEST_USER, { nowMs: NOW, ageSec: DAY - 5 }), TEST_TOKEN, DAY, NOW))).toBe('ok');
    expect(reason(() => validateInitData(signInitData(TEST_USER, { authDate: nowSec + MAX_FUTURE_SKEW_SEC + 60 }), TEST_TOKEN, DAY, NOW))).toBe('future');
    const noDate = new URLSearchParams(signInitData(TEST_USER, { authDate: 0 }));
    expect(reason(() => validateInitData(noDate.toString(), TEST_TOKEN, DAY, NOW))).toBe('stale');
  });

  it('requires a user object', () => {
    const p = new URLSearchParams();
    p.set('auth_date', String(nowSec));
    const secret = createHmac('sha256', 'WebAppData').update(TEST_TOKEN).digest();
    p.set('hash', createHmac('sha256', secret).update(dataCheckString(p)).digest('hex'));
    expect(reason(() => validateInitData(p.toString(), TEST_TOKEN, DAY, NOW))).toBe('no_user');
  });

  it('parses the tma authorization scheme', () => {
    expect(tmaFromHeader('tma abc=1&hash=2')).toBe('abc=1&hash=2');
    expect(tmaFromHeader('TMA  x ')).toBe('x');
    expect(tmaFromHeader('Bearer x')).toBeNull();
    expect(tmaFromHeader(undefined)).toBeNull();
  });
});

describe('freshness classes over the API (read 24 h, write 1 h, high 10 min)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });
  const at = (app: TestApp, ageSec: number) => staleInitData(TEST_USER, { nowMs: app.clock.now(), ageSec });

  it('401 without or with bad initData; the user row is created on first valid call', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me', undefined, { initData: null })).status).toBe(401);
    const bad = await t.api('GET', '/api/me', undefined, { initData: tamperInitData(signInitData(TEST_USER, { authDate: Math.floor(t.clock.now() / 1000) })) });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: 'unauthorized', reason: 'bad_hash' });
    expect(t.s.repos.users.getByTg(TEST_USER.id)).toBeUndefined();
    const ok = await t.api('GET', '/api/me');
    expect(ok.status).toBe(200);
    const me = (await ok.json()) as { user: { tgUserId: number; memoryConsent: boolean | null } };
    expect(me.user.tgUserId).toBe(TEST_USER.id);
    expect(me.user.memoryConsent).toBeNull();
    expect(t.s.repos.users.getByTg(TEST_USER.id)).toBeDefined();
  });

  it('read accepts ≤ 24 h; write needs ≤ 1 h; high needs ≤ 10 min', async () => {
    t = await createTestApp();
    // read
    expect((await t.api('GET', '/api/settings', undefined, { initData: at(t, 23 * 3600) })).status).toBe(200);
    expect((await t.api('GET', '/api/settings', undefined, { initData: at(t, 25 * 3600) })).status).toBe(401);
    // write
    const w2h = await t.api('PATCH', '/api/settings', { quietStart: '23:00' }, { initData: at(t, 2 * 3600) });
    expect(w2h.status).toBe(401);
    expect(await w2h.json()).toMatchObject({ error: 'stale', need: 'write' });
    expect((await t.api('PATCH', '/api/settings', { quietStart: '23:00' }, { initData: at(t, 50 * 60) })).status).toBe(200);
    // high
    const h = await t.api('POST', '/api/account/delete', { confirm: 'DELETE' }, { initData: at(t, 30 * 60) });
    expect(h.status).toBe(401);
    expect(await h.json()).toMatchObject({ error: 'stale', need: 'high' });
    expect(t.s.repos.users.getByTg(TEST_USER.id)?.status).toBe('active');
  });

  it('a deleting user is refused; a blocked one (spec 05 C1: only no Gora-first messages) is not', async () => {
    t = await createTestApp();
    await t.api('GET', '/api/me');
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    t.s.repos.users.update(u.id, { status: 'blocked' });
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    t.s.repos.users.update(u.id, { status: 'deleting' });
    expect((await t.api('GET', '/api/me')).status).toBe(403);
  });
});
