// src/surfaces/onboarding.ts — first contact in friend mode (spec 05 §A; replaces the 01 §3 M1–M9 onboarding).
//  - /start answers with exactly ONE short localized line, no buttons, nothing reset (A2). Deep links (g_, me_) keep
//    working silently and replace the greeting; bizChat… is passed on to WP7b; grp_ / ref_ / unknown → the greeting.
//  - First contact records the memory notice consent (`desc-v1`, the bot description carries the notice — A1).
//  - No onboarding cards, no RunHook, no onboarding context (A3). The `ob` callback stays registered because old
//    buttons exist in live chats: every old card answers "expired"; only the /settings memory toggle (ob:mem:y|n:s) acts.
//  - Time zone (A6): the NoticeService is the lazy tz hint (a short line + ONE web_app button, at most once per 7 days),
//    the `tz:` callbacks for an explicit proposal (/settings city) and the "type your city" await. A location share or
//    a city named in conversation confirms the zone silently (location.ts / dm.ts through `setTimezone`).
import type { User } from 'grammy/types';
import type { CallbackAnswer, CallbackCtx, ChatRef, NoticeService, UserId, UserRow } from '../contracts/index.ts';
import { memoryEnabled } from '../contracts/index.ts';
import { isValidTz, offsetMinutes } from '../kernel/timeMath.ts';
import type { PaymentsModule } from './payments.ts';
import { st } from './strings.ts';
import { languageDefaultTz } from './tz.ts';
import { appUrl, cbBtn, deepLink, errName, langOf, sendRich, setKeyboard, utcOffsetLabel, webAppBtn, type Keyboard, type Surf } from './util.ts';

/** The notice the bot description carries (spec 05 A1); every friend-mode memory grant uses this version. */
export const MEMORY_TEXT_VERSION = 'desc-v1';
export const IMPORT_MIN_CHARS = 200;
const AWAIT_MS = 30 * 60_000;
const PROPOSAL_MS = 30 * 60_000;

export interface ObState {
  await?: 'city' | 'import';
  awaitUntil?: number;
}
export interface TzProposal { tz: string; source: 'location' | 'city'; city?: { name: string; lat: number; lon: number }; at: number }

export interface OnboardingDeps {
  payments: PaymentsModule;
  /** /start payloads other than the greeting (g_, me_): true when handled. Set by index.ts. */
  handlePayload: (user: UserRow, payload: string, chat: ChatRef, updateId: number | null) => Promise<boolean>;
}

export interface Onboarding {
  notices: NoticeService;
  onStart(p: { from: User; chatId: number; payload: string; updateId: number; messageId: number }): Promise<'handled' | 'next'>;
  onObCallback(c: CallbackCtx): Promise<CallbackAnswer>;
  onTzCallback(c: CallbackCtx): Promise<CallbackAnswer>;
  /** Free text in the main DM: true when an explicit await (/import paste, "type your city") consumed it. */
  interceptText(user: UserRow, text: string, chat: ChatRef, o: { replyToMessageId?: number; updateId: number }): Promise<boolean>;
  /** An explicit tz proposal card ([Yes]/[No]); only for user-initiated flows (/settings city, travel). */
  proposeTz(user: UserRow, p: Omit<TzProposal, 'at'>, chat: ChatRef, idem: string): Promise<void>;
  /** First contact (A1): records consents(memory, desc-v1) once for a user who was never asked; returns the fresh row. */
  firstContact(user: UserRow): UserRow;
  armImport(user: UserRow): void;
  state(userId: UserId): ObState;
  /** tz writer shared with /settings, the location flow and the silent city confirmation. */
  setTimezone(user: UserRow, tz: string, source: UserRow['tzSource'], city?: { name: string; lat: number; lon: number }): Promise<void>;
  /** Short city-like text → geocode → proposal card; false when not found. */
  proposeCity(user: UserRow, name: string, chat: ChatRef, idem: string): Promise<boolean>;
  /** The lazy tz hint line (A6), gated by users.tz_hint_at (LIMITS.tzHintEveryMs) unless `force`. True when sent. */
  tzHint(user: UserRow, chat: ChatRef, idem: string, o?: { force?: boolean }): Promise<boolean>;
}

export function createOnboarding(surf: Surf, deps: OnboardingDeps): Onboarding {
  const { s } = surf;
  const kvKey = (userId: UserId) => `ob:${userId}`;
  const getState = (userId: UserId): ObState => {
    const raw = s.repos.kv.get<ObState & Record<string, unknown>>(kvKey(userId)) ?? {};
    // Old onboarding records carried more fields (shown, payload, name/brief awaits…): only these two survive.
    return { ...(raw.await === 'city' || raw.await === 'import' ? { await: raw.await } : {}), ...(typeof raw.awaitUntil === 'number' ? { awaitUntil: raw.awaitUntil } : {}) };
  };
  const putState = (userId: UserId, patch: Partial<ObState>): ObState => {
    const next: ObState = { ...getState(userId), ...patch };
    for (const k of Object.keys(next) as Array<keyof ObState>) if (next[k] === undefined) delete next[k];
    s.repos.kv.set(kvKey(userId), Object.keys(next).length ? next : null);
    return next;
  };
  const clearAwait = (userId: UserId) => putState(userId, { await: undefined, awaitUntil: undefined });
  const dmChat = (u: UserRow): ChatRef => ({ chatId: u.dmChatId ?? u.tgUserId });
  const fresh = (userId: UserId) => s.repos.users.getById(userId);

  // ── first contact
  function firstContact(user: UserRow): UserRow {
    let u = user;
    try {
      // null = never asked (on by default); a user who declined the old card (false) or already granted keeps that.
      if (u.memoryConsent === null && !s.repos.users.hasConsent(u.id, 'memory')) {
        s.repos.users.grantConsent({ userId: u.id, kind: 'memory', textVersion: MEMORY_TEXT_VERSION, via: 'blanket' });
      }
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'first contact: consent record failed');
    }
    // A new account starts on the language's zone (best guess, still tz_source 'default'); dm.ts refines it.
    if (u.tzSource === 'default' && u.tz === 'UTC') {
      const guess = languageDefaultTz(u.languageCode);
      if (guess !== u.tz) {
        s.repos.users.update(u.id, { tz: guess });
        u = { ...u, tz: guess };
      }
    }
    if (u.onboardingStep !== 'done') {
      // Live accounts created under the old flow are treated as done (A3); nothing branches on the step any more.
      s.repos.users.update(u.id, { onboardingStep: 'done' });
      u = { ...u, onboardingStep: 'done' };
    }
    return u;
  }

  // ── tz
  async function setTimezone(user: UserRow, tz: string, source: UserRow['tzSource'], city?: { name: string; lat: number; lon: number }): Promise<void> {
    if (!isValidTz(tz)) throw new Error('invalid tz');
    const changed = user.tz !== tz;
    s.repos.users.update(user.id, { tz, tzSource: source });
    if (getState(user.id).await === 'city') clearAwait(user.id); // any confirmed zone ends a "type your city" await
    if (city) s.repos.users.updateSettings(user.id, { homeCity: city });
    if (changed) {
      try {
        s.reminders.rescheduleForTz(user.id, tz); // local-time reminders/crons follow the new zone
      } catch {
        /* best effort: the reminder module logs its own failures */
      }
    }
    try {
      s.ledger.append({ userId: user.id, actor: 'user', kind: 'settings', summary: `Time zone set to ${tz}`, detail: { tz, source } });
    } catch {
      /* ledger is best effort here */
    }
    await notices.timezoneSet(user.id, tz, source);
  }

  async function proposeTz(user: UserRow, p: Omit<TzProposal, 'at'>, chat: ChatRef, idem: string): Promise<void> {
    const lang = langOf(user);
    s.repos.kv.set(`tzp:${user.id}`, { ...p, at: s.clock.now() } satisfies TzProposal);
    const text = p.city ? st('tz_guess_city', lang, { city: s.telegram.render.escape(p.city.name), tz: p.tz }) : st('tz_guess', lang, { tz: p.tz });
    const kb: Keyboard = [[cbBtn(surf, st('tz_yes', lang), 'tz', ['y'], user.tgUserId, 'success'), cbBtn(surf, st('tz_no', lang), 'tz', ['n'], user.tgUserId)]];
    await sendRich(surf, { ...chat, userId: user.id }, text, { idem, keyboard: kb });
  }

  async function proposeCity(user: UserRow, name: string, chat: ChatRef, idem: string): Promise<boolean> {
    let places: Awaited<ReturnType<typeof s.caps.geo.geocodeCity>> = [];
    try {
      places = await s.caps.geo.geocodeCity(name.trim(), langOf(user));
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'tz: geocode failed');
      return false;
    }
    const hit = places.find((p) => p.tz && isValidTz(p.tz)) ?? null;
    if (!hit || !hit.tz) return false;
    await proposeTz(user, { tz: hit.tz, source: 'city', city: { name: hit.name, lat: hit.lat, lon: hit.lon } }, chat, idem);
    return true;
  }

  async function tzHint(user: UserRow, chat: ChatRef, idem: string, o: { force?: boolean } = {}): Promise<boolean> {
    const now = s.clock.now();
    const u = fresh(user.id) ?? user;
    if (!o.force && (u.tzSource !== 'default' || (u.tzHintAt !== null && now - u.tzHintAt < s.config.limits.tzHintEveryMs))) return false;
    const lang = langOf(u);
    s.repos.users.update(u.id, { tzHintAt: now });
    const kb: Keyboard = [[webAppBtn(s.strings.t('tz_hint_button', lang), appUrl(surf, 'tz'))]];
    await sendRich(surf, { ...chat, userId: u.id }, st('tz_hint_line', lang, { tz: u.tz }), { idem, keyboard: kb });
    return true;
  }

  // ── NoticeService
  const notices: NoticeService = {
    quotaExceeded: (userId, k, chat) => deps.payments.quotaExceeded(userId, k, chat),
    async askTimezone(userId, chat) {
      const user = fresh(userId);
      if (!user) return;
      await tzHint(user, chat, `tzask:${userId}:${Math.floor(s.clock.now() / 60_000)}`);
    },
    async timezoneSet(userId, tz, source) {
      // Silent for a zone learned from a location or a city in conversation; one short line (no buttons) when the owner
      // set it explicitly (Mini App, /settings, a tapped proposal).
      if (source !== 'miniapp' && source !== 'manual') return;
      const user = fresh(userId);
      if (!user) return;
      const offset = utcOffsetLabel(offsetMinutes(s.clock.now(), tz));
      await sendRich(surf, { ...dmChat(user), userId }, st('tz_set', langOf(user), { tz, offset }), { idem: `tzset:${userId}:${tz}:${source}:${Math.floor(s.clock.now() / 1000)}` });
    },
  };

  // ── /start (A2): one line, nothing reset
  async function onStart(p: { from: User; chatId: number; payload: string; updateId: number; messageId: number }): Promise<'handled' | 'next'> {
    const payload = p.payload.trim();
    const refSource = payload.startsWith('ref_') ? payload.slice(4, 64) : undefined;
    let user = s.repos.users.upsertFromTelegram(p.from, { dmChatId: p.chatId, ...(refSource ? { refSource } : {}) });
    if (user.status === 'deleting') return 'handled';
    if (user.botBlocked || user.status === 'blocked') {
      s.repos.users.update(user.id, { botBlocked: false, ...(user.status === 'blocked' ? { status: 'active' as const } : {}) });
      user = { ...user, botBlocked: false, ...(user.status === 'blocked' ? { status: 'active' as const } : {}) };
    }
    user = firstContact(user);
    if (payload.startsWith('bizChat')) return 'next'; // WP7b's per-chat card (01 §10.2 step 8)
    if (payload && (await deps.handlePayload(user, payload, { chatId: p.chatId }, p.updateId))) return 'handled';
    await sendRich(surf, { chatId: p.chatId, userId: user.id }, st('start_hello', langOf(user)), { idem: `hello:${p.updateId}` });
    return 'handled';
  }

  // ── ob: old onboarding buttons (expired) + the /settings memory toggle
  async function onObCallback(c: CallbackCtx): Promise<CallbackAnswer> {
    const user = c.user;
    if (!user) return { text: st('start_first', null) };
    const lang = langOf(user);
    const [what, arg, from] = c.parts;
    if (what !== 'mem' || from !== 's' || (arg !== 'y' && arg !== 'n')) return { text: st('button_expired', lang) };
    const on = arg === 'y';
    setMemory(user, on, 'callback');
    if (c.message) await setKeyboard(surf, { chatId: c.message.chatId, messageId: c.message.messageId, userId: user.id }, null, `obm:kb:${c.message.chatId}:${c.message.messageId}`);
    return { text: st(on ? 'mem_on_toast' : 'mem_off_toast', lang) };
  }

  function setMemory(user: UserRow, on: boolean, via: 'callback' | 'command'): void {
    if (on) s.repos.users.grantConsent({ userId: user.id, kind: 'memory', textVersion: MEMORY_TEXT_VERSION, via });
    else if (s.repos.users.hasConsent(user.id, 'memory')) s.repos.users.revokeConsent(user.id, 'memory');
    s.repos.users.update(user.id, { memoryConsent: on });
    try {
      s.ledger.append({ userId: user.id, actor: 'user', kind: 'consent', summary: on ? 'Memory on' : 'Memory off', detail: { kind: 'memory', textVersion: MEMORY_TEXT_VERSION, granted: on } });
    } catch {
      /* best effort */
    }
  }

  // ── tz: callbacks (explicit flows only)
  async function onTzCallback(c: CallbackCtx): Promise<CallbackAnswer> {
    const user = c.user;
    if (!user) return { text: st('start_first', null) };
    const lang = langOf(user);
    const at = c.message ? { chatId: c.message.chatId, messageId: c.message.messageId, userId: user.id } : null;
    const chat = { chatId: user.dmChatId ?? user.tgUserId };
    switch (c.parts[0]) {
      case 'y': {
        const p = s.repos.kv.get<TzProposal>(`tzp:${user.id}`);
        if (!p || s.clock.now() - p.at > PROPOSAL_MS || !isValidTz(p.tz)) return { text: st('tz_proposal_gone', lang), alert: true };
        s.repos.kv.set(`tzp:${user.id}`, null);
        if (at) await setKeyboard(surf, at, null, `tzy:kb:${at.chatId}:${at.messageId}`);
        // A tapped proposal is an explicit choice: one confirmation line (source stays what it was learned from).
        await setTimezone(user, p.tz, p.source, p.city);
        const offset = utcOffsetLabel(offsetMinutes(s.clock.now(), p.tz));
        await sendRich(surf, { ...chat, userId: user.id }, st('tz_set', lang, { tz: p.tz, offset }), { idem: `tzy:${c.callbackQueryId}` });
        return { text: st('done_toast', lang) };
      }
      case 'n': {
        if (at) await setKeyboard(surf, at, null, `tzn:kb:${at.chatId}:${at.messageId}`);
        s.repos.kv.set(`tzp:${user.id}`, null);
        putState(user.id, { await: 'city', awaitUntil: s.clock.now() + AWAIT_MS });
        await sendRich(surf, { ...chat, userId: user.id }, st('tz_type_city', lang), { idem: `tzn:${c.callbackQueryId}` });
        return;
      }
      case 'ch':
        putState(user.id, { await: 'city', awaitUntil: s.clock.now() + AWAIT_MS });
        await tzHint(user, chat, `tzch:${c.callbackQueryId}`, { force: true });
        return;
      case 'skip':
        if (at) await setKeyboard(surf, at, null, `tzs:kb:${at.chatId}:${at.messageId}`);
        return;
      default:
        return { text: st('button_invalid', lang) };
    }
  }

  // ── explicit awaits only: a city after [No]/[Change], a paste after /import
  const looksLikeCity = (t: string) => t.length >= 2 && t.length <= 40 && !/[?!\n@/]/.test(t) && t.trim().split(/\s+/).length <= 4 && !/^\d+$/.test(t.trim());

  async function interceptText(user: UserRow, text: string, chat: ChatRef, o: { replyToMessageId?: number; updateId: number }): Promise<boolean> {
    const st0 = getState(user.id);
    const now = s.clock.now();
    const awaiting = st0.await && (st0.awaitUntil ?? 0) > now ? st0.await : undefined;
    if (!awaiting) return false;
    const t = text.trim();
    if (awaiting === 'city') {
      if (!looksLikeCity(t)) {
        clearAwait(user.id);
        return false;
      }
      const found = await proposeCity(user, t, chat, `obcity:${o.updateId}`);
      if (found) {
        clearAwait(user.id);
        return true;
      }
      if (t.split(/\s+/).length <= 2) {
        await sendRich(surf, { ...chat, userId: user.id }, st('tz_city_not_found', langOf(user)), { idem: `obcity:${o.updateId}` });
        return true;
      }
      clearAwait(user.id);
      return false;
    }
    if (awaiting === 'import' && t.length > IMPORT_MIN_CHARS) {
      clearAwait(user.id);
      await runImport(user, t, chat, o.updateId);
      return true;
    }
    return false;
  }

  async function runImport(user: UserRow, text: string, chat: ChatRef, updateId: number): Promise<void> {
    const lang = langOf(user);
    const to = { ...chat, userId: user.id };
    const cur = fresh(user.id) ?? user;
    if (!memoryEnabled(cur, s.clock.now())) {
      await sendRich(surf, to, st('import_memory_off', lang), { idem: `imp:${updateId}` });
      return;
    }
    // PLAT-1: the chat import is an LLM side call like a turn: refusal cooldown, daily cost cap and turn quota first
    // (the same gate as the Mini App importGate in http/routes/memory.ts), then one turn is spent.
    try {
      const cd = s.quotas.cooldownUntil(user.id);
      if (cd !== null && cd > s.clock.now()) {
        const time = s.telegram.render.tgTime(Math.floor(cd / 1000), 't', `${new Date(cd).toISOString().slice(11, 16)} UTC`);
        await sendRich(surf, to, s.strings.t('refusal_cooldown', lang, { time }), { idem: `imp:${updateId}` });
        return;
      }
      const costOk = s.quotas.check(user.id, 'cost_micros').ok;
      if (!costOk || !s.quotas.check(user.id, 'turn').ok) {
        await s.notices.quotaExceeded(user.id, !costOk ? 'cost_micros' : 'turn', chat);
        return;
      }
      s.quotas.consume(user.id, 'turn');
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'import: quota check failed');
      await sendRich(surf, to, st('something_wrong', lang), { idem: `imp:${updateId}` });
      return;
    }
    let facts: Array<{ id: string; text: string }> = [];
    try {
      if (!s.repos.users.hasConsent(user.id, 'import')) s.repos.users.grantConsent({ userId: user.id, kind: 'import', textVersion: 'imp-v1', via: 'command' });
      facts = await s.memory.importText(user.id, text);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'import failed');
      await sendRich(surf, to, st('something_wrong', lang), { idem: `imp:${updateId}` });
      return;
    }
    if (facts.length === 0) {
      await sendRich(surf, to, st('import_none', lang), { idem: `imp:${updateId}` });
      return;
    }
    // The owner asked for this import: one review card (✓/✗ per fact) is the explicit, user-initiated exception.
    const shown = facts.slice(0, 10);
    const esc = s.telegram.render.escape;
    const lines = shown.map((f, i) => `${i + 1}. ${esc(f.text.length > 200 ? f.text.slice(0, 199) + '…' : f.text)}`);
    const kb: Keyboard = shown.map((f, i) => [cbBtn(surf, `✓ ${i + 1}`, 'mm', ['imp', f.id, 'y'], user.tgUserId, 'success'), cbBtn(surf, `✗ ${i + 1}`, 'mm', ['imp', f.id, 'n'], user.tgUserId, 'danger')]);
    kb.push([cbBtn(surf, st('import_save', lang), 'mm', ['imp', 'save'], user.tgUserId, 'primary')]);
    await sendRich(surf, to, `🧠 **${st('import_title', lang, { n: shown.length })}**\n\n${lines.join('\n')}\n\n${st('import_hint', lang)}`, { idem: `imp:${updateId}`, keyboard: kb });
  }

  return {
    notices,
    onStart,
    onObCallback,
    onTzCallback,
    interceptText,
    proposeTz,
    firstContact,
    armImport(user) {
      putState(user.id, { await: 'import', awaitUntil: s.clock.now() + AWAIT_MS });
    },
    state: getState,
    setTimezone,
    proposeCity,
    tzHint,
  };
}

/** For tests and sim: the deep link a guest reply carries. */
export const guestContinueUrl = (surf: Surf, token: string) => deepLink(surf, `g_${token}`);
