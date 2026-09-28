// Review proof (surfaces/dm forwards, 01 §10.1 / §11.2): dm.ts:84 routes ANY message with `location` to the location
// flow before the forward check (dm.ts:135-144). A location or venue FORWARDED from someone else (a friend's pin, a
// restaurant venue) is recorded as the owner's own current position (location_state), triggers a time-zone change
// proposal, and becomes an owner-authored, untrusted:false "[location shared …]" input — the forward provenance is lost.
import { afterEach, describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';
import { OTHER_USER, TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, lastButtons, sentTexts, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('forwarded location / venue', () => {
  it('is not taken as the owner’s own position and keeps forward provenance', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(user.id, { onboardingStep: 'done', tz: 'Asia/Almaty', tzSource: 'manual' });
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });

    // Anna's pin in Istanbul, forwarded by the owner ("what do you think of this place?").
    const u = U.location(41.01, 28.98) as Update & { message: Record<string, unknown> };
    u.message['forward_origin'] = { type: 'user', date: Math.floor(app.clock.now() / 1000) - 600, sender_user: { id: OTHER_USER.id, is_bot: false, first_name: OTHER_USER.first_name } };
    const before = sentTexts(app).length;
    await app.send(u);

    const proposals = sentTexts(app).slice(before).filter((x) => x.includes('Europe/Istanbul'));
    expect(proposals).toHaveLength(0); // no tz proposal for someone else’s pin
    const inputs = app.s.repos.inputs.pending(conv.id);
    expect(inputs.some((i) => i.untrusted && i.kind === 'forward')).toBe(true);
    expect(inputs.some((i) => !i.untrusted)).toBe(false);
    expect(app.s.location.get(user.id)).toBeNull(); // not stored as the owner’s own position
  });

  it('a venue the owner picks is a place input, not their position', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(user.id, { onboardingStep: 'done', tz: 'Asia/Almaty', tzSource: 'manual' });
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });
    const u = U.location(41.01, 28.98) as Update & { message: Record<string, unknown> };
    u.message['venue'] = { location: { latitude: 41.01, longitude: 28.98 }, title: 'Cafe Nar', address: 'Istiklal 5' };
    const before = sentTexts(app).length;
    await app.send(u);
    expect(sentTexts(app).slice(before).filter((x) => x.includes('Europe/Istanbul'))).toHaveLength(0);
    const inputs = app.s.repos.inputs.pending(conv.id);
    expect(inputs).toHaveLength(1);
    expect(JSON.stringify(inputs[0]!.content)).toContain('Cafe Nar');
    expect(app.s.location.get(user.id)).toBeNull();
  });
});
