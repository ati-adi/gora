// src/surfaces/tz.ts — lazy time zone (spec 05 A6). While users.tz_source = 'default' nothing is asked: users.tz holds
// the best guess (tz_source stays 'default') so time-dependent tools just work, and the reply carries ONE lazy
// "set my time zone" web_app button (trust/executor.ts, at most once per LIMITS.tzHintEveryMs).
//
// Best guess, in order:
//   1. the last shared location (LocationService, 1 h retention) → geo.tzForPoint;
//   2. a city: settings.homeCity (→ tzForPoint), else a city named in the profile card or the owner's profile facts
//      ("lives in Almaty", «живёт в Алматы») → geocode (rate-limited, cached 6 h);
//   3. the language default (LANG_DEFAULT_TZ below).
// A city the owner says they LIVE in ("I live in X", «живу в X», "we moved to X") or a location share CONFIRMS the zone
// silently (tz_source 'city' / 'location'). A weak "I'm in X" / «я в X» (maybe a trip, maybe "I'm in Love") only moves
// the guess; the lazy button still offers to confirm. A geocoder hit must be a populated place (GeoNames PPL*) of a
// minimum size, so "we moved to Slack" or «я в Телеграме» never becomes a home town. Only the extracted city NAME is
// sent to the geocoder, never the message; the message itself always reaches the model.
import type { Services, UserId, UserRow } from '../contracts/index.ts';
import { memoryEnabled } from '../contracts/index.ts';
import { isValidTz } from '../kernel/timeMath.ts';
import { errName, type Surf } from './util.ts';

/**
 * Language → default zone when nothing better is known (Telegram language_code, base subtag). Only languages whose
 * speakers overwhelmingly share one zone are listed; everything else is UTC.
 *   ru → Europe/Moscow · uk → Europe/Kyiv · be → Europe/Minsk · kk → Asia/Almaty
 */
export const LANG_DEFAULT_TZ: Readonly<Record<string, string>> = Object.freeze({ ru: 'Europe/Moscow', uk: 'Europe/Kyiv', be: 'Europe/Minsk', kk: 'Asia/Almaty' });

export function languageDefaultTz(languageCode: string | null | undefined): string {
  const base = (languageCode ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return LANG_DEFAULT_TZ[base] ?? 'UTC';
}

/** A capitalized place name of 1–3 words right after a marker (case-sensitive: "in Almaty and work" → "Almaty"). */
const NAME_RE = /^\s*(\p{Lu}[\p{L}'’.-]*(?:[ -]\p{Lu}[\p{L}'’.-]*){0,2})/u;
/** Strong self-statements: enough to confirm the zone. Markers are case-insensitive and end right before the name. */
const STRONG: readonly RegExp[] = [
  /\b(?:i\s+live|i['’]?m\s+living|i\s+am\s+living|i['’]?m\s+based|i\s+am\s+based|i\s+(?:just\s+)?moved|we\s+live|we\s+moved)\s+(?:in|to)(?=\s)/iu,
  /(?:^|[\s,.;:!(])(?:я\s+)?(?:живу|живём|живем|проживаю|нахожусь|переехала?|переехали)\s+(?:сейчас\s+)?(?:в|во)(?=\s)/iu,
];
/** Weak self-statements ("I'm in X", «я в X»): only in a short message. */
const WEAK: readonly RegExp[] = [
  /\b(?:i['’]?m|i\s+am)\s+(?:now\s+|currently\s+)?in(?=\s)/iu,
  /(?:^|[\s,.;:!(])я\s+(?:сейчас\s+|уже\s+)?(?:в|во)(?=\s)/iu,
];
/** Third-person statements in the profile card / facts ("Adi lives in Almaty", «живёт в Алматы», "city: Almaty"). */
const PROFILE: readonly RegExp[] = [
  /\b(?:lives|living|based|resides|located|moved)\s+(?:in|to)(?=\s)/iu,
  /(?:живёт|живет|проживает|находится|переехала?)\s+(?:в|во)(?=\s)/iu,
  /(?:^|[\s,.;:!(])(?:city|город)\s*[:—-]/iu,
];

const firstMatch = (res: readonly RegExp[], text: string): string | null => {
  for (const re of res) {
    const m = re.exec(text);
    if (!m) continue;
    const name = NAME_RE.exec(text.slice(m.index + m[0].length))?.[1]?.trim();
    if (name) return name.replace(/[.'’-]+$/u, '');
  }
  return null;
};

/** The city the owner says they live in (strong) or are in (weak), from one message; null when none (or too ambiguous). */
export function citySaid(text: string): { name: string; strong: boolean } | null {
  const t = text.trim();
  if (!t || t.length > 400) return null;
  const strong = firstMatch(STRONG, t);
  if (strong) return { name: strong, strong: true };
  const weak = t.split(/\s+/).length <= 8 ? firstMatch(WEAK, t) : null;
  return weak ? { name: weak, strong: false } : null;
}

/** The city name of citySaid (either strength). */
export function cityFromMessage(text: string): string | null {
  return citySaid(text)?.name ?? null;
}

/** Minimum GeoNames population of a geocoder hit: a "live in" statement / a weak "I'm in" (which must name a real city). */
export const MIN_POPULATION = { strong: 1_000, weak: 15_000 } as const;

/** Whether a geocoder hit is a populated place big enough for how the owner named it (fields absent: not judged). */
export function placeOk(p: { featureCode?: string; population?: number }, strength: 'strong' | 'weak' | 'profile'): boolean {
  if (p.featureCode !== undefined && !p.featureCode.startsWith('PPL')) return false;
  const min = strength === 'weak' ? MIN_POPULATION.weak : MIN_POPULATION.strong;
  if (p.population !== undefined) return p.population >= min;
  // no population: fine for a statement about home or profile text; a weak mention must name a known city
  return strength !== 'weak' || p.featureCode === undefined;
}

/** A city named in third-person profile text. */
export function cityFromProfileText(text: string): string | null {
  return firstMatch(PROFILE, text);
}

/** Russian prepositional-case candidates for the geocoder («Москве» → Москва, «Казани» → Казань, «Берлине» → Берлин). */
export function cityCandidates(name: string): string[] {
  const out = [name];
  if (/[Ѐ-ӿ]$/.test(name)) {
    if (name.endsWith('е')) out.push(`${name.slice(0, -1)}а`, name.slice(0, -1));
    if (name.endsWith('и')) out.push(`${name.slice(0, -1)}ь`, `${name.slice(0, -1)}ы`);
    if (name.endsWith('у')) out.push(`${name.slice(0, -1)}а`);
  }
  return [...new Set(out)].slice(0, 3);
}

export interface TzGuess { tz: string; via: 'location' | 'home_city' | 'profile' | 'language' }
export interface TzGuesser {
  /**
   * Refreshes the best guess of a default-zone user (and confirms from `text` when the owner names their city).
   * Never throws; returns the up-to-date row.
   */
  refresh(user: UserRow, o?: { text?: string }): Promise<UserRow>;
  /** The guess without writing (sync part only: location, home city, cached profile city, language). */
  guessSync(user: UserRow): TzGuess;
}

export const PROFILE_CITY_TTL_MS = 6 * 3_600_000;
interface CachedCity { at: number; tz: string | null }

export function createTzGuesser(surf: Surf, confirm: (user: UserRow, tz: string, source: 'city', city: { name: string; lat: number; lon: number }) => Promise<void>): TzGuesser {
  const { s } = surf;
  const cacheKey = (id: UserId) => `tzg:${id}`;

  async function geocode(name: string, lang: string | null, strength: 'strong' | 'weak' | 'profile'): Promise<{ name: string; lat: number; lon: number; tz: string } | null> {
    for (const cand of cityCandidates(name)) {
      try {
        const places = await s.caps.geo.geocodeCity(cand, lang ?? 'en');
        const hit = places.find((p) => p.tz && isValidTz(p.tz) && placeOk(p, strength));
        if (hit?.tz) return { name: hit.name, lat: hit.lat, lon: hit.lon, tz: hit.tz };
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'tz guess: geocode failed');
        return null;
      }
    }
    return null;
  }

  const pointTz = (lat: number, lon: number): string | null => {
    try {
      const tz = s.caps.geo.tzForPoint(lat, lon);
      return tz && isValidTz(tz) ? tz : null;
    } catch {
      return null;
    }
  };

  function guessSync(user: UserRow): TzGuess {
    const loc = safe(s, () => s.location.get(user.id), null);
    const fromLoc = loc ? pointTz(loc.lat, loc.lon) : null;
    if (fromLoc) return { tz: fromLoc, via: 'location' };
    const home = safe(s, () => s.repos.users.settings(user.id).homeCity, null);
    const fromHome = home ? pointTz(home.lat, home.lon) : null;
    if (fromHome) return { tz: fromHome, via: 'home_city' };
    const cached = safe(s, () => s.repos.kv.get<CachedCity>(cacheKey(user.id)), undefined);
    if (cached?.tz && isValidTz(cached.tz)) return { tz: cached.tz, via: 'profile' };
    return { tz: languageDefaultTz(user.languageCode), via: 'language' };
  }

  /** Profile card + profile facts → a geocoded city tz, cached for PROFILE_CITY_TTL_MS (null results too). */
  async function profileCityTz(user: UserRow): Promise<void> {
    const now = s.clock.now();
    const cached = safe(s, () => s.repos.kv.get<CachedCity>(cacheKey(user.id)), undefined);
    if (cached && now - cached.at < PROFILE_CITY_TTL_MS) return;
    s.repos.kv.set(cacheKey(user.id), { at: now, tz: cached?.tz ?? null } satisfies CachedCity);
    if (!memoryEnabled(user, now)) return;
    const texts: string[] = [];
    const view = safe(s, () => s.userProfile.get(user.id), null);
    if (view) texts.push(view.card.summary, ...view.card.current_context.map((c) => c.text));
    try {
      const { items } = await s.memory.list({ kind: 'user', userId: user.id }, { kind: 'profile', limit: 50 });
      texts.push(...items.filter((f) => f.status === 'active').map((f) => f.text));
    } catch {
      /* memory is optional here */
    }
    let name: string | null = null;
    for (const t of texts) if (!name && t) name = cityFromProfileText(t);
    if (!name) return;
    const hit = await geocode(name, user.languageCode, 'profile');
    s.repos.kv.set(cacheKey(user.id), { at: now, tz: hit?.tz ?? null } satisfies CachedCity);
  }

  async function refresh(user: UserRow, o: { text?: string } = {}): Promise<UserRow> {
    try {
      if (user.tzSource !== 'default' || user.status === 'deleting') return user;
      const said = o.text ? citySaid(o.text) : null;
      // "I live in X" confirms the zone; "I'm in X" only moves the guess. The geocoder is rate-limited per user and
      // only ever sees the city name, never the text.
      if (said && s.quotas.rate(`tzcity:${user.tgUserId}`, 3, 3_600_000)) {
        const hit = await geocode(said.name, user.languageCode, said.strong ? 'strong' : 'weak');
        if (hit && said.strong) {
          await confirm(user, hit.tz, 'city', { name: hit.name, lat: hit.lat, lon: hit.lon });
          s.repos.kv.set(cacheKey(user.id), null);
          return s.repos.users.getById(user.id) ?? user;
        }
        if (hit) s.repos.kv.set(cacheKey(user.id), { at: s.clock.now(), tz: hit.tz } satisfies CachedCity);
      }
      await profileCityTz(user);
      const g = guessSync(user);
      if (g.tz === user.tz) return user;
      s.repos.users.update(user.id, { tz: g.tz });
      try {
        s.reminders.rescheduleForTz(user.id, g.tz);
      } catch {
        /* best effort */
      }
      return { ...user, tz: g.tz };
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'tz guess failed');
      return user;
    }
  }

  return { refresh, guessSync };
}

function safe<T>(s: Services, f: () => T, fallback: T): T {
  try {
    return f();
  } catch (e) {
    s.log.debug({ err: errName(e) }, 'tz guess: lookup unavailable');
    return fallback;
  }
}
