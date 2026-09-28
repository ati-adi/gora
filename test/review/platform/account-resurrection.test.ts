// Review (platform): after a Mini App account deletion, the SAME still-valid initData (read class: 24 h) re-creates
// the user on the very next /api/* call. http/auth.ts authMiddleware upserts any unknown tg user, so navigating back
// in the still-open Mini App (or any refetch) silently resurrects the account the user just deleted: a fresh `users`
// row (name, username, language) plus user_settings/permissions defaults are written again with refSource 'miniapp'.
// FIXED: deletion leaves a pseudonymous kv marker (hmac of the tg id, swept after 3 days); authMiddleware refuses to
// auto-create from initData signed before it (403 reason 'deleted').
import { afterEach, describe, expect, it } from 'vitest';
import { signInitData } from '../../harness/initData.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('Mini App account deletion is final for the open session', () => {
  it('a post-deletion API call with the same initData must not re-create the deleted user', async () => {
    t = await createTestApp();
    const initData = signInitData(TEST_USER, { authDate: Math.floor(t.clock.now() / 1000), token: t.config.telegram.token ?? 'TEST_TOKEN' });
    expect((await t.api('GET', '/api/me', undefined, { initData })).status).toBe(200);
    const before = t.s.repos.users.getByTg(TEST_USER.id);
    expect(before).toBeTruthy();

    const del = await t.api('POST', '/api/account/delete', { confirm: 'DELETE' }, { initData });
    expect(del.status).toBe(200);
    expect(t.s.repos.users.getByTg(TEST_USER.id)).toBeUndefined();

    // The user taps Back in the still-open Mini App: Home refetches with the same session initData.
    await t.clock.advance(60_000);
    const after = await t.api('GET', '/api/home', undefined, { initData });
    // Expected: the deleted account stays deleted (the request is refused, nothing is written).
    expect(after.status).not.toBe(200);
    expect(t.s.repos.users.getByTg(TEST_USER.id)).toBeUndefined();
    expect(await after.json()).toMatchObject({ error: 'forbidden', reason: 'deleted' });

    // Reopening the Mini App later (fresh initData, signed after the deletion) signs up again.
    await t.clock.advance(5_000);
    const reopened = signInitData(TEST_USER, { authDate: Math.floor(t.clock.now() / 1000), token: t.config.telegram.token ?? 'TEST_TOKEN' });
    expect((await t.api('GET', '/api/me', undefined, { initData: reopened })).status).toBe(200);
    expect(t.s.repos.users.getByTg(TEST_USER.id)).toBeTruthy();
  });
});
