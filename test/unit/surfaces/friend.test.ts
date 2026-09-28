// spec 05 set P (friend first contact, minimal UI, lazy time zone) — unit level: the best-guess zone and city parsing,
// the published menu + bot description (hash-guarded), first-contact consent, old onboarding buttons, /memory,
// /settings, location shares and the settings_update words. Pinned fakes only (createSurfacesApp), no model.
import { afterEach, describe, expect, it } from 'vitest';
import type { Api } from 'grammy';
import { memoryState } from '../../../src/contracts/index.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, commandDefs, commandsHash, PRIVATE_COMMANDS, syncCommands } from '../../../src/telegram/commands.ts';
import { SURF } from '../../../src/surfaces/strings.ts';
import { cityCandidates, cityFromMessage, cityFromProfileText, LANG_DEFAULT_TZ, languageDefaultTz } from '../../../src/surfaces/tz.ts';
import { createFakePolicy, createFakeProfileService, createRecordingSignals } from '../../harness/fakes.ts';
import { RU_USER, TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, lastButtons, sentTexts, type SurfacesTestApp } from './env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('lazy time zone helpers (05 A6)', () => {
  it('language default table: ru → Moscow, uk/be/kk their capitals’ zones, everything else UTC', () => {
    expect(languageDefaultTz('ru')).toBe('Europe/Moscow');
    expect(languageDefaultTz('ru-RU')).toBe('Europe/Moscow');
    expect(languageDefaultTz('uk')).toBe('Europe/Kyiv');
    expect(languageDefaultTz('kk')).toBe('Asia/Almaty');
    expect(languageDefaultTz('en')).toBe('UTC');
    expect(languageDefaultTz(null)).toBe('UTC');
    expect(Object.keys(LANG_DEFAULT_TZ).sort()).toEqual(['be', 'kk', 'ru', 'uk']);
  });

  it('a city the owner states about themselves; never a random capitalized word', () => {
    expect(cityFromMessage('I live in Almaty and work remotely')).toBe('Almaty');
    expect(cityFromMessage('I’m in Paris now')).toBe('Paris');
    expect(cityFromMessage('I moved to New York City last year')).toBe('New York City');
    expect(cityFromMessage('я живу в Москве')).toBe('Москве');
    expect(cityFromMessage('Я в Казани')).toBe('Казани');
    expect(cityFromMessage('Мы переехали в Санкт-Петербург')).toBe('Санкт-Петербург');
    for (const no of ['I am in love', 'я в шоке', 'Hello there', 'I got a letter from Anna', 'Paris', 'what time is it in Tokyo?']) expect(cityFromMessage(no), no).toBeNull();
    // a weak "I'm in X" only counts in a short message
    expect(cityFromMessage('so yesterday after the meeting I told them that I’m in Berlin for the whole of next month, fine')).toBeNull();
    expect(cityFromProfileText('Adi lives in Almaty, works as a designer')).toBe('Almaty');
    expect(cityFromProfileText('Живёт в Алматы, любит кофе')).toBe('Алматы');
    expect(cityFromProfileText('city: Kyiv')).toBe('Kyiv');
    expect(cityCandidates('Москве')).toEqual(['Москве', 'Москва', 'Москв']);
    expect(cityCandidates('Almaty')).toEqual(['Almaty']);
  });

  it('dm: a default-zone user gets the language guess, then the shared-location / home-city / profile-city guess; tz_source stays default', async () => {
    const profile = createFakeProfileService();
    const app = await createSurfacesApp({ extraFactories: { createProfileService: () => profile } });
    t = app;
    await app.send(U.start(undefined, { user: RU_USER }));
    const u = app.s.repos.users.getByTg(RU_USER.id)!;
    expect([u.tz, u.tzSource]).toEqual(['Europe/Moscow', 'default']);
    // a profile card that says where they live → geocoded guess (still a guess)
    profile.put(u.id, { summary: 'Damir lives in Almaty, works as a designer' }); // FakeGeo knows English names
    await app.userSends('привет', { user: RU_USER });
    expect([app.s.repos.users.getById(u.id)!.tz, app.s.repos.users.getById(u.id)!.tzSource]).toEqual(['Asia/Almaty', 'default']);
    // a home city beats the profile guess
    app.s.repos.users.updateSettings(u.id, { homeCity: { name: 'Kyiv', lat: 50.45, lon: 30.52 } });
    await app.userSends('как дела', { user: RU_USER });
    expect(app.s.repos.users.getById(u.id)!.tz).toBe('Europe/Kyiv');
    // the last shared location beats everything (stored only; a forwarded pin would not count)
    app.s.location.set(u.id, { lat: 41.0, lon: 29.0 });
    await app.userSends('ok', { user: RU_USER });
    expect([app.s.repos.users.getById(u.id)!.tz, app.s.repos.users.getById(u.id)!.tzSource]).toEqual(['Europe/Istanbul', 'default']);
    // every message still reached the model; nothing was sent to the chat about the zone
    expect(app.runner.kicks.length).toBe(3);
    expect(sentTexts(app).filter((x) => /Europe|Asia/.test(x))).toEqual([]);
  });

  it('a location share confirms a guessed zone silently (👌 reaction, no text); a confirmed zone that differs gets a proposal', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    const n = sentTexts(app).length;
    await app.send(U.location(43.238, 76.945));
    const u2 = app.s.repos.users.getById(u.id)!;
    expect([u2.tz, u2.tzSource]).toEqual(['Asia/Almaty', 'location']);
    expect(sentTexts(app).length).toBe(n);
    expect(app.tg.byMethod('setMessageReaction').at(-1)?.reaction).toEqual([{ type: 'emoji', emoji: '👌' }]);
    // travel: confirmed Almaty, a share in Istanbul → one Yes/No proposal, the share still reaches the model
    const kicks = app.runner.kicks.length;
    await app.send(U.location(41.01, 28.98));
    expect(app.lastCard().markdown).toContain('Europe/Istanbul');
    expect(lastButtons(app).map((b) => b.data?.split(/[:|]/).slice(0, 2).join(':'))).toEqual(['tz:y', 'tz:n']);
    expect(app.s.repos.users.getById(u.id)!.tz).toBe('Asia/Almaty');
    expect(app.runner.kicks.length).toBe(kicks + 1);
  });
});

describe('published menu and bot description (05 A1/A5)', () => {
  it('the private menu lists exactly /memory and /settings in both languages; descriptions are in the hash, within limits', () => {
    expect(PRIVATE_COMMANDS.map((c) => c.command)).toEqual(['memory', 'settings']);
    const calls = commandDefs('https://gora.test').calls;
    const priv = calls.filter((c) => c.method === 'setMyCommands' && (c.payload as { scope: { type: string } }).scope.type === 'all_private_chats');
    expect(priv.map((c) => (c.payload as { commands: Array<{ command: string }> }).commands.map((x) => x.command))).toEqual([['memory', 'settings'], ['memory', 'settings']]);
    expect(BOT_DESCRIPTION.ru).toBe('Гора — друг в Telegram. Пиши или отправь голосовое: посоветую, напомню, найду, запомню. Я запоминаю важное из наших разговоров, чтобы лучше тебя понимать — посмотреть или стереть можно в любой момент (/memory).');
    for (const l of ['en', 'ru'] as const) {
      expect(BOT_DESCRIPTION[l].length).toBeLessThanOrEqual(512);
      expect(BOT_DESCRIPTION[l]).toContain('/memory');
      expect(BOT_SHORT_DESCRIPTION[l].length).toBeLessThanOrEqual(120);
    }
    expect(calls.filter((c) => c.method === 'setMyDescription').map((c) => (c.payload as { language_code?: string }).language_code ?? 'default')).toEqual(['default', 'ru']);
    expect(calls.filter((c) => c.method === 'setMyShortDescription')).toHaveLength(2);
  });

  it('syncCommands applies every call once per hash (commands, menu button, both descriptions)', async () => {
    const made: string[] = [];
    const raw = new Proxy({}, { get: (_t, m: string) => async () => void made.push(m) });
    const api = { raw } as unknown as Api;
    const store = new Map<string, unknown>();
    const kv = { get: <T,>(k: string) => store.get(k) as T | undefined, set: (k: string, v: unknown) => void store.set(k, v) } as never;
    const log = createMemoryLogger();
    expect(await syncCommands(api, kv, 'https://gora.test', log)).toBe(true);
    expect(made.filter((m) => m === 'setMyDescription')).toHaveLength(2);
    expect(made.filter((m) => m === 'setMyShortDescription')).toHaveLength(2);
    expect(store.get('commands_hash')).toBe(commandsHash('https://gora.test'));
    expect(await syncCommands(api, kv, 'https://gora.test', log)).toBe(false);
    expect(made).toHaveLength(9);
  });
});

describe('first contact (05 A1/A3)', () => {
  it('the first message records consents(memory, desc-v1) once; a user who declined the old card is never re-granted', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.userSends('hi');
    await app.userSends('how are you');
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    const rows = app.s.db.prepare("SELECT text_version, via FROM consents WHERE user_id = ? AND kind = 'memory'").all<{ text_version: string; via: string }>(u.id);
    expect(rows).toEqual([{ text_version: 'desc-v1', via: 'blanket' }]);
    expect(u.memoryConsent).toBeNull();
    expect(memoryState(u, app.clock.now())).toBe('on');

    await app.userSends('hi', { user: RU_USER });
    const r = app.s.repos.users.getByTg(RU_USER.id)!;
    app.s.db.prepare("DELETE FROM consents WHERE user_id = ?").run(r.id);
    app.s.repos.users.update(r.id, { memoryConsent: false }); // declined on the old M1 card
    await app.userSends('again', { user: RU_USER });
    expect(app.s.repos.users.hasConsent(r.id, 'memory')).toBe(false);
    expect(memoryState(app.s.repos.users.getById(r.id)!, app.clock.now())).toBe('off');
  });

  it('a legacy account mid-onboarding is treated as done; old onboarding buttons answer "expired" and change nothing', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(u.id, { onboardingStep: 'tz' });
    const codec = app.s.telegram.codec;
    for (const parts of [['mem', 'y'], ['tz', 'skip'], ['task', '1'], ['brief', '08'], ['hooks', 'next']]) {
      await app.tap(codec.encode('ob', parts, TEST_USER.id));
      expect(app.tg.byMethod('answerCallbackQuery').at(-1)?.text).toBe(SURF.button_expired.en);
    }
    expect(app.brief.daily.size).toBe(0);
    expect(app.runner.kicks).toHaveLength(0);
    await app.userSends('hello');
    expect(app.s.repos.users.getById(u.id)!.onboardingStep).toBe('done');
    expect(app.s.contextProviders.some((p) => p.name === 'surfaces.onboarding')).toBe(false);
    expect(app.s.runHooks.some((h) => h.name === 'surfaces.onboarding')).toBe(false);
  });
});

describe('/memory and /settings (05 A5, B5, C5)', () => {
  it('/memory: a short summary (profile card + facts) and one Mini App button', async () => {
    const profile = createFakeProfileService();
    const app = await createSurfacesApp({ extraFactories: { createProfileService: () => profile } });
    t = app;
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    profile.put(u.id, { summary: 'Designer in Almaty who runs on Tuesdays' });
    await app.s.memory.save({ kind: 'user', userId: u.id }, { text: 'Sister Anna is allergic to nuts', kind: 'person', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'user_message' } });
    await app.send(U.command('memory'));
    const card = app.lastCard();
    expect(card.markdown).toContain('Designer in Almaty');
    expect(card.markdown).toContain('Sister Anna is allergic to nuts');
    expect(card.markdown).toContain(SURF.memory_hint.en);
    expect(card.buttons).toEqual([{ text: SURF.memory_open.en, web_app: { url: 'https://gora.test/app/?screen=memory' } }]);
  });

  it('/settings shows memory state, writing first and reply style; the memory toggle flips memory by consent', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(u.id, { proactiveLevel: 'less' });
    app.s.repos.users.updateSettings(u.id, { style: { length: 'short', register: 'informal' } });
    await app.send(U.command('settings'));
    const md = app.lastCard().markdown;
    expect(md).toContain(`${SURF.settings_memory.en}: ${SURF.memory_state_on.en}`);
    expect(md).toContain(`${SURF.settings_proactive.en}: ${SURF.proactive_less.en}`);
    expect(md).toContain(`${SURF.talk_length_short.en}, ${SURF.talk_register_informal.en}`);
    expect(md).toContain(SURF.tz_guessed.en);
    const off = lastButtons(app).find((b) => b.data?.startsWith('ob:mem:n:s'))!;
    await app.tap(off.data!);
    expect(memoryState(app.s.repos.users.getById(u.id)!, app.clock.now())).toBe('off');
    expect(app.s.repos.users.hasConsent(u.id, 'memory')).toBe(false);
    expect(app.tg.byMethod('answerCallbackQuery').at(-1)?.text).toBe(SURF.mem_off_toast.en);
    await app.send(U.command('settings'));
    await app.tap(lastButtons(app).find((b) => b.data?.startsWith('ob:mem:y:s'))!.data!);
    expect(memoryState(app.s.repos.users.getById(u.id)!, app.clock.now())).toBe('on');
    expect(app.s.db.prepare("SELECT text_version FROM consents WHERE user_id = ? AND kind = 'memory' AND revoked_at IS NULL").all(u.id)).toEqual([{ text_version: 'desc-v1' }]);
  });

  it('the lazy tz hint (NoticeService.askTimezone) is one line + one web_app button, at most once per 7 days', async () => {
    const app = await createSurfacesApp({ extraFactories: { createBehaviourModule: () => ({ signals: createRecordingSignals(), policy: createFakePolicy() }) } });
    t = app;
    await app.send(U.start());
    const u = app.s.repos.users.getByTg(TEST_USER.id)!;
    await app.s.notices.askTimezone(u.id, { chatId: TEST_USER.id });
    expect(app.lastCard().buttons).toEqual([{ text: '🕒 Set my time zone', web_app: { url: 'https://gora.test/app/?screen=tz' } }]);
    const n = app.tg.callsOf('sendRichMessage').length;
    await app.s.notices.askTimezone(u.id, { chatId: TEST_USER.id });
    expect(app.tg.callsOf('sendRichMessage').length).toBe(n);
    await app.clock.advance(7 * 86_400_000 + 1);
    await app.s.notices.askTimezone(u.id, { chatId: TEST_USER.id });
    expect(app.tg.callsOf('sendRichMessage').length).toBe(n + 1);
    // a zone set explicitly sends one short line and no buttons; a learned one sends nothing
    await app.s.notices.timezoneSet(u.id, 'Asia/Almaty', 'miniapp');
    expect(sentTexts(app).at(-1)).toContain('Asia/Almaty');
    const m = app.tg.callsOf('sendRichMessage').length;
    await app.s.notices.timezoneSet(u.id, 'Asia/Almaty', 'location');
    expect(app.tg.callsOf('sendRichMessage').length).toBe(m);
  });
});
