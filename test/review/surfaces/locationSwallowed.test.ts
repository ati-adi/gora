// Review proof (surfaces/location; updated for friend mode 05 A6: a share now confirms a guessed zone silently): a user who skipped the tz card (every card has Skip, 01 §3) keeps
// tz_source='default'. location.ts:39 treats `tzSource === 'default'` as "in the tz flow", so EVERY later location share
// is turned into a "Looks like … — right?" tz proposal and returns before the share becomes a conversation input. The
// answer to the model's own `location_request` ("find a café near me") never reaches the model: the run never resumes.
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, sentTexts, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('location share after skipping the tz step', () => {
  it('a location sent in answer to location_request becomes model input', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start()); // friend mode: no tz card at all, the zone stays a guess (tz_source 'default')
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    expect(app.s.repos.users.getById(user.id)!.tzSource).toBe('default');
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });

    // The model asked "📍 share your location" (location_request); the user taps the button and shares a point.
    const kicksBefore = app.runner.kicks.length;
    await app.send(U.location(43.238, 76.945));
    const inputs = app.s.repos.inputs.pending(conv.id).filter((i) => i.kind === 'location');
    expect(inputs).toHaveLength(1); // the share reaches the model
    expect(app.runner.kicks.length).toBeGreaterThan(kicksBefore);
    // spec 05 A6: the share confirms the zone silently (no proposal card, no text)
    const u2 = app.s.repos.users.getById(user.id)!;
    expect([u2.tz, u2.tzSource]).toEqual(['Asia/Almaty', 'location']);
    expect(sentTexts(app).some((x) => x.includes('Asia/Almaty'))).toBe(false);
  });
});
