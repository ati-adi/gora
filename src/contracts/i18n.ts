// ── contracts/i18n.ts (WP0, frozen) — UI strings shared across work packages (01 §3 "UI strings come from surfaces/strings.ts").
// WP7 implements `Strings` in src/surfaces/strings.ts (`createStrings()`), with English and Russian for every STRING_KEYS entry.
// app.ts builds it first (before any other factory), so `s.strings.t(...)` may be called at any time, even at factory time.
// Module-private text that no other WP needs may stay in the module, using `uiLang()` to pick the language.

/** The two UI languages. */
export type UiLang = 'en' | 'ru';

/** 01 §3: `language_code` ru/uk/kk/be → Russian; everything else (including null) → English. */
export function uiLang(languageCode: string | null | undefined): UiLang {
  const l = (languageCode ?? '').trim().toLowerCase().slice(0, 2);
  return l === 'ru' || l === 'uk' || l === 'kk' || l === 'be' ? 'ru' : 'en';
}

/**
 * Every key other work packages rely on, with its English reference text and placeholders (`{name}`).
 * WP7 MUST provide en + ru for each (the en text may be polished but keeps the placeholders and meaning).
 * `user` = shown to the user; `model` = written into the transcript (synthetic rows / tool results), keep it terse.
 */
export const STRING_KEYS = Object.freeze({
  // ── WP2 channels
  stopped: { en: '⏹ Stopped', vars: [], who: 'WP2', audience: 'user' },
  busy_retrying: { en: '⏳ Busy — retrying in {seconds}s', vars: ['seconds'], who: 'WP2', audience: 'user' },
  continue_button: { en: 'Continue ▶', vars: [], who: 'WP2/WP3', audience: 'user' },
  retry_button: { en: '↻ Retry', vars: [], who: 'WP2', audience: 'user' },
  listen_button: { en: '🔊 Listen', vars: [], who: 'WP2', audience: 'user' },
  use_privately_button: { en: '🔒 Use Gora privately', vars: [], who: 'WP2', audience: 'user' },
  continue_privately_button: { en: '🔒 Continue privately', vars: [], who: 'WP2', audience: 'user' },
  guest_placeholder: { en: '…', vars: [], who: 'WP2', audience: 'user' },
  slow_down: { en: 'Slow down a bit — I’m still on your last messages.', vars: [], who: 'WP2', audience: 'user' },
  // ── WP3 engine
  llm_busy: { en: 'Busy — retrying…', vars: [], who: 'WP3', audience: 'user' },
  temp_error: { en: 'I couldn’t get an answer just now. Please try again in a moment.', vars: [], who: 'WP3', audience: 'user' },
  failed_ref: { en: 'Something went wrong on my side (ref {ref}).', vars: ['ref'], who: 'WP3', audience: 'user' },
  refusal: { en: 'I can’t help with that one.', vars: [], who: 'WP3', audience: 'user' },
  refusal_cooldown: { en: 'Let’s take a short break — I’ll be back at {time}.', vars: ['time'], who: 'WP3', audience: 'user' },
  prompt_budget: { en: 'That was too long for me to process — could you split it?', vars: [], who: 'WP3', audience: 'user' },
  too_long: { en: 'That answer got too long to finish. Ask me for a shorter version?', vars: [], who: 'WP3', audience: 'user' },
  free_left: { en: '({n} free messages left today)', vars: ['n'], who: 'WP3', audience: 'user' },
  step_cap: { en: '[step limit reached — the owner can tap Continue]', vars: [], who: 'WP3', audience: 'model' },
  no_reply_temp_error: { en: '[no reply: temporary error]', vars: [], who: 'WP3', audience: 'model' },
  context_full: { en: '[context full — continuing in a fresh thread]', vars: [], who: 'WP3', audience: 'model' },
  declined: { en: '[declined]', vars: [], who: 'WP3', audience: 'model' },
  // ── WP4 trust
  already_handled: { en: 'Already handled', vars: [], who: 'WP4', audience: 'user' },
  tap_the_card: { en: 'Tap the button on the card.', vars: [], who: 'WP4', audience: 'user' },
  approve_button: { en: '✅ Approve', vars: [], who: 'WP4', audience: 'user' },
  approve_24h_button: { en: '✅ Approve for 24 h', vars: [], who: 'WP4', audience: 'user' },
  deny_button: { en: '✖ Deny', vars: [], who: 'WP4', audience: 'user' },
  undo_button: { en: '↩ Undo', vars: [], who: 'WP4', audience: 'user' },
  approval_not_sent: { en: '✖ Not sent', vars: [], who: 'WP4', audience: 'user' },
  approval_expired: { en: '⌛ Expired', vars: [], who: 'WP4', audience: 'user' },
  approval_superseded: { en: 'Superseded', vars: [], who: 'WP4', audience: 'user' },
  draft_changed: { en: 'Draft changed since you saw it — please review again', vars: [], who: 'WP4', audience: 'user' },
  safety_check: { en: 'Safety check: {rationale}', vars: ['rationale'], who: 'WP4', audience: 'user' },
  undone: { en: 'Undone ✓', vars: [], who: 'WP4', audience: 'user' },
  undo_expired: { en: 'Too late to undo.', vars: [], who: 'WP4', audience: 'user' },
  // ── WP5 tools / integrations
  connect_button: { en: 'Connect {service}', vars: ['service'], who: 'WP5', audience: 'user' },
  share_location_button: { en: '📍 Share location', vars: [], who: 'WP5', audience: 'user' },
  // ── WP6 reminders / nudges / missions
  late: { en: '(late)', vars: [], who: 'WP6', audience: 'user' },
  missed: { en: '(missed)', vars: [], who: 'WP6', audience: 'user' },
  done_button: { en: '✓ Done', vars: [], who: 'WP6', audience: 'user' },
  snooze_10m_button: { en: '⏰ 10 min', vars: [], who: 'WP6', audience: 'user' },
  snooze_1h_button: { en: '⏰ 1 h', vars: [], who: 'WP6', audience: 'user' },
  tomorrow_button: { en: 'Tomorrow', vars: [], who: 'WP6', audience: 'user' },
  nudge_do_button: { en: 'Do it', vars: [], who: 'WP6', audience: 'user' },
  nudge_snooze_button: { en: 'Snooze', vars: [], who: 'WP6', audience: 'user' },
  nudge_never_button: { en: 'Never this kind', vars: [], who: 'WP6', audience: 'user' },
  mission_stop_button: { en: '⏹ Stop mission', vars: [], who: 'WP6', audience: 'user' },
  mission_budget_exhausted: { en: 'Budget used up ({spent} of {budget}).', vars: ['spent', 'budget'], who: 'WP6', audience: 'user' },
  // ── WP7 own notices other WPs trigger through NoticeService (listed so the catalog is complete)
  quota_exceeded: { en: 'You’ve used today’s {what} ({used}/{limit}). It resets {resets}.', vars: ['what', 'used', 'limit', 'resets'], who: 'WP7', audience: 'user' },
  plans_button: { en: '⭐ Plans', vars: [], who: 'WP7', audience: 'user' },
  // ── friend mode (spec 05, set P): the lazy time zone button (A6), pushed by trust/executor.ts
  tz_hint_button: { en: '🕒 Set my time zone', vars: [], who: 'friend-P', audience: 'user' },
} as const satisfies Record<string, { en: string; vars: readonly string[]; who: string; audience: 'user' | 'model' }>);

export type StringKey = keyof typeof STRING_KEYS;
export type StringVars = Record<string, string | number>;

export interface Strings {
  /**
   * The text for `key` in `lang` (a UiLang or a raw Telegram language_code, mapped with uiLang), with `{name}`
   * placeholders filled from `vars`. Never throws: a missing placeholder stays as written.
   */
  t(key: StringKey, lang: string | null | undefined, vars?: StringVars): string;
}
