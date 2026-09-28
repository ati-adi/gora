// Review proof (surfaces/onboarding §3 "Typing free text always goes straight to normal chat"). Updated for friend mode
// (spec 05 A3: M4 is gone; see the first two cases). Original finding: after tapping
// M4 "✏️ Your own", ANY message ≤ 30 chars in the next 30 min becomes the assistant's name (onboarding.ts:503-517),
// whether or not it replies to the force_reply prompt (o.replyToMessageId is passed in but never checked, although the
// file header promises only "a reply to the name prompt" is intercepted). A question typed instead is swallowed: it never
// reaches the model and the persona is renamed to the question text.
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_USER, U } from '../../harness/updates.ts';
import { SURF } from '../../../src/surfaces/strings.ts';
import { createSurfacesApp, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('M4 "your own" name prompt', () => {
  // Friend mode (spec 05 A3) removed M4: a live account left at step 'name' is treated as done, nothing is intercepted,
  // and the name is set by words (settings_update persona_name).
  it('a normal question from a legacy account at step "name" goes to chat and does not rename the assistant', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(user.id, { onboardingStep: 'name', tz: 'Asia/Almaty', tzSource: 'manual' });
    app.s.repos.kv.set(`ob:${user.id}`, { shown: 'name', await: 'name', awaitUntil: app.clock.now() + 60_000 }); // an old record
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });

    await app.userSends('Jarvis');
    expect(app.s.repos.users.getById(user.id)!.personaName).not.toBe('Jarvis');
    expect(app.s.repos.inputs.pending(conv.id)).toHaveLength(1); // reaches chat
    expect(app.s.repos.users.getById(user.id)!.onboardingStep).toBe('done');
  });

  it('an old "✏️ Your own" button answers expired and changes nothing', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    await app.tap(app.s.telegram.codec.encode('ob', ['name', 'own'], TEST_USER.id));
    expect(app.tg.byMethod('answerCallbackQuery').at(-1)?.text).toBe(SURF.button_expired.en);
    expect(app.s.repos.users.getById(user.id)!.personaName).toBe(user.personaName);
    expect(app.tg.callsOf('sendMessage').filter((c) => c.payload?.reply_markup?.force_reply)).toHaveLength(0);
  });

  it('a long non-city text while a city is awaited goes to chat', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(user.id, { onboardingStep: 'done', tz: 'Asia/Almaty', tzSource: 'manual' });
    app.s.repos.kv.set(`ob:${user.id}`, { await: 'city', awaitUntil: app.clock.now() + 60_000 });
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });
    await app.userSends('remind me tomorrow morning');
    expect(app.s.repos.inputs.pending(conv.id)).toHaveLength(1);
  });
});
