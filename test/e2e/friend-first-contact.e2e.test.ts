// spec 05 §A / §E rows owned by set P (friend first contact, minimal UI, lazy time zone, settings by words), over the
// whole app with a scripted model. Replaces test/e2e/onboarding.e2e.test.ts: the M1–M9 onboarding was removed (05 A3).
// Memory, the profile card and the behaviour module are pinned to fakes (sets M and B are tested on their own); the
// recording SignalsService checks what settings_update reports to the behaviour model.
import { afterEach, describe, expect, it } from 'vitest';
import { memoryState, type Factories } from '../../src/contracts/index.ts';
import { REMINDER_ACK_EMOJI } from '../../src/reminders/tools.ts';
import { SURF } from '../../src/surfaces/strings.ts';
import { createFakePolicy, createFakeProfileService, createRecordingSignals } from '../harness/fakes.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { RU_USER, TEST_USER, U } from '../harness/updates.ts';
import { fakeMemory } from '../unit/surfaces/env.ts';

const DAY = 86_400_000;
let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function friendApp(): Promise<{ app: TestApp; signals: ReturnType<typeof createRecordingSignals> }> {
  const signals = createRecordingSignals();
  const factories: Partial<Factories> = {
    createMemoryService: () => fakeMemory(),
    createProfileService: () => createFakeProfileService(),
    createBehaviourModule: () => ({ signals, policy: createFakePolicy() }),
  };
  const app = await createTestApp({ factories });
  t = app;
  return { app, signals };
}

/** Every outbound message/edit that carries a reply_markup, with its inline buttons flattened. */
function markups(app: TestApp) {
  return app.tg.calls
    .filter((c) => c.payload?.reply_markup)
    .map((c) => ({ method: c.method, buttons: ((c.payload.reply_markup.inline_keyboard ?? []) as Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>).flat(), raw: c.payload.reply_markup }));
}
const tzButtons = (app: TestApp) => markups(app).flatMap((m) => m.buttons).filter((b) => b.web_app?.url === 'https://gora.test/app/?screen=tz');
const texts = (app: TestApp) =>
  app.tg.calls.filter((c) => ['sendRichMessage', 'sendMessage', 'editMessageText'].includes(c.method)).map((c) => String(c.payload?.rich_message?.markdown ?? c.payload?.text ?? ''));

describe('/start (05 A2)', () => {
  it('replies with exactly one localized line, no reply_markup; an existing user gets the same line and nothing is reset', async () => {
    const { app } = await friendApp();
    await app.send(U.start());
    const sent = app.tg.callsOf('sendRichMessage', 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.reply_markup).toBeUndefined();
    expect(String(sent[0]!.payload.rich_message?.markdown ?? sent[0]!.payload.text)).toBe(SURF.start_hello.en);

    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    expect(u.onboardingStep).toBe('done');
    // the owner changed things in the meantime; a second /start must not reset any of it
    app.s.repos.users.update(u.id, { personaName: 'Nova', proactiveLevel: 'less', memoryConsent: false, tz: 'Asia/Almaty', tzSource: 'manual' });
    app.s.repos.users.updateSettings(u.id, { quietStart: '23:00', style: { length: 'short' } });
    const before = { ...app.s.repos.users.getById(u.id)!, updatedAt: 0, lastSeenAt: 0 };
    const settingsBefore = app.s.repos.users.settings(u.id);
    await app.send(U.start());
    const after = { ...app.s.repos.users.getById(u.id)!, updatedAt: 0, lastSeenAt: 0 };
    expect(after).toEqual(before);
    expect(app.s.repos.users.settings(u.id)).toEqual(settingsBefore);
    const sent2 = app.tg.callsOf('sendRichMessage', 'sendMessage');
    expect(sent2).toHaveLength(2);
    expect(String(sent2[1]!.payload.rich_message?.markdown ?? sent2[1]!.payload.text)).toBe(SURF.start_hello.en);
    expect(sent2[1]!.payload.reply_markup).toBeUndefined();
    expect(app.llm.requests).toHaveLength(0); // no model run for /start
  });

  it('speaks Russian to a ru user (and starts them on the language zone guess)', async () => {
    const { app } = await friendApp();
    await app.send(U.start(undefined, { user: RU_USER }));
    const sent = app.tg.callsOf('sendRichMessage', 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.rich_message?.markdown ?? sent[0]!.payload.text)).toBe('Привет! Я Гора 🙂 Рассказывай, что у тебя?');
    expect(sent[0]!.payload.reply_markup).toBeUndefined();
    const u = app.s.repos.users.getByTg(RU_USER.id)!;
    expect([u.tz, u.tzSource]).toEqual(['Europe/Moscow', 'default']);
  });
});

describe('first contact without onboarding (05 A1/A3/A5/A6)', () => {
  it('start, three messages, a time-dependent request, two days: no card except the one lazy tz button; consent desc-v1 once', async () => {
    const { app } = await friendApp();
    const s = app.s;
    await app.send(U.start());
    const u = s.repos.users.getByTg(TEST_USER.id)!;
    for (const [q, a] of [['hey', 'Hey! How’s your day going?'], ['tired, long week', 'Oof. Anything I can take off your plate?'], ['what should I cook tonight?', 'Shakshuka — 20 minutes, one pan.']] as const) {
      app.llm.push(say(a));
      await app.userSends(q);
      await app.settle();
    }
    app.llm.push(turn().text('On it. ').toolUse('reminder_create', { text: 'call mom', kind: 'reminder', at_local: '2026-09-30T10:00' }, 'toolu_rem1'));
    app.llm.push(say('I’ll remind you Wednesday at 10:00.'));
    await app.userSends('remind me to call mom on Wednesday at 10');
    await app.settle();
    await app.advance(2 * DAY);

    // exactly one lazy tz web_app button, carried by the reply; every other button is an Undo
    expect(tzButtons(app)).toHaveLength(1);
    for (const m of markups(app)) for (const b of m.buttons) expect(b.web_app?.url === 'https://gora.test/app/?screen=tz' || (b.callback_data ?? '').startsWith('ud:')).toBe(true);
    expect(s.repos.users.getById(u.id)!.tzHintAt).not.toBeNull();
    expect(s.reminders.list({ kind: 'user', userId: u.id }, false)).toHaveLength(1); // the tool succeeded on the guess
    // the reminder is acknowledged with a reaction on the owner's message (05 A5)
    expect(app.tg.byMethod('setMessageReaction').some((p) => p.reaction?.[0]?.emoji === REMINDER_ACK_EMOJI)).toBe(true);
    // no onboarding text, no feature advertising, no "free messages left" / incognito footers
    for (const x of texts(app)) {
      expect(x).not.toMatch(/Can I remember|Welcome back|What should we start with|group|guest|free messages left|🕶/i);
    }
    // the description's memory notice is recorded once, on the first message
    const consents = s.db.prepare("SELECT text_version FROM consents WHERE user_id = ? AND kind = 'memory'").all<{ text_version: string }>(u.id);
    expect(consents.map((c) => c.text_version)).toEqual(['desc-v1']);
    expect(memoryState(s.repos.users.getById(u.id)!, s.clock.now())).toBe('on');
  });

  it('the lazy tz button: once, then not again within 7 days, then again after 7 days; never after the zone is set', async () => {
    const { app } = await friendApp();
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    const remind = async (text: string, at: string, id: string) => {
      app.llm.push(turn().toolUse('reminder_create', { text, kind: 'reminder', at_local: at }, id));
      app.llm.push(say('Done.'));
      await app.userSends(`remind me: ${text}`);
      await app.settle();
    };
    // Days pass by moving the last-hint instant back (advancing the whole app clock by weeks is too slow for e2e).
    const ago = (days: number) => app.s.repos.users.update(u.id, { tzHintAt: app.s.repos.users.getById(u.id)!.tzHintAt! - days * DAY });
    await remind('water plants', '2026-10-20T09:00', 'toolu_a');
    expect(tzButtons(app)).toHaveLength(1);
    ago(3);
    await remind('pay rent', '2026-10-21T09:00', 'toolu_b');
    expect(tzButtons(app)).toHaveLength(1); // within 7 days: no second button
    ago(4.5);
    await remind('dentist', '2026-10-22T09:00', 'toolu_c');
    expect(tzButtons(app)).toHaveLength(2); // > 7 days after the first hint
    // the Mini App TzDetect confirms the zone → one short line, and no more hints ever
    const r = await app.api('POST', '/api/settings/tz', { tz: 'Asia/Almaty' });
    expect(r.status).toBeLessThan(300);
    await app.settle();
    expect(texts(app).some((x) => x.includes('Asia/Almaty') && x.startsWith('🕒'))).toBe(true);
    ago(8);
    await remind('gym', '2026-10-30T09:00', 'toolu_d');
    expect(tzButtons(app)).toHaveLength(2);
    expect(app.s.repos.users.getById(u.id)!.tzSource).toBe('miniapp');
  });

  it('a city the owner names about themselves confirms the zone silently and still reaches the model', async () => {
    const { app } = await friendApp();
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    const outBefore = texts(app).length;
    app.llm.push(say('Almaty is lovely this time of year!'));
    await app.userSends('I live in Almaty and just got back from a trip');
    await app.settle();
    const u2 = app.s.repos.users.getById(u.id)!;
    expect([u2.tz, u2.tzSource]).toEqual(['Asia/Almaty', 'city']);
    expect(app.s.repos.users.settings(u.id).homeCity?.name).toBe('Almaty');
    expect(app.llm.requests.length).toBeGreaterThan(0); // the message was not swallowed
    // only the model's reply was sent: no tz card or confirmation text
    expect(texts(app).slice(outBefore).every((x) => !x.includes('Asia/Almaty'))).toBe(true);
    expect(markups(app)).toHaveLength(0);
  });
});

describe('settings by words (05 C5, B1) and minimal footers (A5)', () => {
  it('"don’t text me first" → proactive off + a stop feedback signal; "don’t remember" → memory off; both undoable', async () => {
    const { app, signals } = await friendApp();
    const s = app.s;
    await app.send(U.start());
    const u = s.repos.users.getByTg(TEST_USER.id)!;
    s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual' });

    app.llm.push(turn().toolUse('settings_update', { proactive: 'off' }, 'toolu_p'));
    app.llm.push(say('Got it — I won’t write first.'));
    await app.userSends('не пиши мне первым');
    await app.settle();
    expect(s.repos.users.getById(u.id)!.proactiveLevel).toBe('off');
    expect(signals.calls.filter((c) => c.op === 'feedback').map((c) => (c.arg as { kind: string }).kind)).toEqual(['stop']);

    app.llm.push(turn().toolUse('settings_update', { memory: 'off', style: { length: 'short' } }, 'toolu_m'));
    app.llm.push(say('Okay, I won’t remember anything new.'));
    await app.userSends('не запоминай ничего и пиши короче');
    await app.settle();
    const u2 = s.repos.users.getById(u.id)!;
    expect(memoryState(u2, s.clock.now())).toBe('off');
    expect(s.repos.users.hasConsent(u.id, 'memory')).toBe(false);
    expect(s.repos.users.settings(u.id).style).toEqual({ length: 'short' });

    // the reply footer carries the Undo line only; Undo restores memory "on" (never asked → on)
    const undo = markups(app).flatMap((m) => m.buttons).filter((b) => (b.callback_data ?? '').startsWith('ud:')).at(-1)!;
    await app.tap(undo.callback_data!);
    await app.settle();
    const u3 = s.repos.users.getById(u.id)!;
    expect(memoryState(u3, s.clock.now())).toBe('on');
    expect(s.repos.users.settings(u.id).style).toBeNull();
  });

  it('an incognito free user near the quota sees no 🕶 or "messages left" footer', async () => {
    const { app } = await friendApp();
    const s = app.s;
    await app.send(U.start());
    const u = s.repos.users.getByTg(TEST_USER.id)!;
    s.repos.users.update(u.id, { incognitoUntil: s.clock.now() + 3_600_000, tz: 'Asia/Almaty', tzSource: 'manual' });
    app.llm.push(say('Sure thing.'));
    await app.userSends('hi');
    await app.settle();
    const last = texts(app).at(-1)!;
    expect(last).toContain('Sure thing.');
    expect(last).not.toContain('🕶');
    expect(last).not.toMatch(/free messages left/);
  });
});
