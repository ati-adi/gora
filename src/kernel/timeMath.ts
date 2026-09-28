// kernel/timeMath.ts (WP0) — DST-correct time-zone arithmetic (01 §8.1). Pure; no Date.now().
import type { Ms } from '../contracts/common.ts';

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number }
export type ZonedAdjust = 'none' | 'gap_shifted' | 'overlap_earlier';

const MIN = 60_000;
const HOUR = 3_600_000;
const partsFmt = new Map<string, Intl.DateTimeFormat>();
const offsetFmt = new Map<string, Intl.DateTimeFormat>();
let validZones: Set<string> | null = null;

function fmtParts(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    partsFmt.set(tz, f);
  }
  return f;
}
function fmtOffset(tz: string): Intl.DateTimeFormat {
  let f = offsetFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset', year: 'numeric' });
    offsetFmt.set(tz, f);
  }
  return f;
}

/** UTC offset in minutes of `tz` at `instant` (from Intl longOffset, e.g. "GMT+05:00" → 300). */
export function offsetMinutes(instant: Ms, tz: string): number {
  const name = fmtOffset(tz).formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(name);
  if (!m || !m[1]) return 0;
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -v : v;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallTimeOf(instant: Ms, tz: string): WallTime & { weekday: number; offsetMin: number } {
  const p: Record<string, string> = {};
  for (const x of fmtParts(tz).formatToParts(instant)) p[x.type] = x.value;
  return {
    year: Number(p['year']),
    month: Number(p['month']),
    day: Number(p['day']),
    hour: Number(p['hour']) % 24,
    minute: Number(p['minute']),
    weekday: WEEKDAYS[p['weekday'] ?? 'Sun'] ?? 0,
    offsetMin: offsetMinutes(instant, tz),
  };
}

/**
 * Converts a wall-clock time in `tz` to an instant.
 * - DST gap (the wall time does not exist): shifted forward by the gap length → 'gap_shifted'.
 * - DST overlap (it exists twice): the earlier instant → 'overlap_earlier'.
 * Candidate offsets are sampled 14 h either side, then each candidate is refined/validated by a round trip.
 */
export function zonedToInstant(w: WallTime, tz: string): { instant: Ms; adjusted: ZonedAdjust } {
  const local = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const oEarly = offsetMinutes(local - 14 * HOUR, tz);
  const oLate = offsetMinutes(local + 14 * HOUR, tz);
  const valid: Ms[] = [];
  for (const o of oEarly === oLate ? [oEarly] : [oEarly, oLate]) {
    const t = local - o * MIN;
    if (offsetMinutes(t, tz) === o) valid.push(t);
  }
  if (valid.length === 0) {
    // Also try the offset at the naive instant (transitions outside the ±14 h window, e.g. zones that change twice a day).
    const o = offsetMinutes(local, tz);
    const t = local - o * MIN;
    if (offsetMinutes(t, tz) === o) return { instant: t, adjusted: 'none' };
    // Gap: interpreting with the pre-transition offset lands after the transition, i.e. wall + gap length.
    return { instant: local - oEarly * MIN, adjusted: 'gap_shifted' };
  }
  if (valid.length === 2 && valid[0] !== valid[1]) return { instant: Math.min(valid[0]!, valid[1]!), adjusted: 'overlap_earlier' };
  return { instant: valid[0]!, adjusted: 'none' };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * "Tue 14 Oct, 15:00 (Asia/Almaty)" — fixed 3-letter English names (never ICU's "Sept"), because models are told to
 * copy these strings verbatim. Russian-family languages get Intl short names ("вт 14 окт., 15:00 (Asia/Almaty)").
 */
export function formatDisplay(instant: Ms, tz: string, lang: string): string {
  const w = wallTimeOf(instant, tz);
  const locale = pickLocale(lang);
  if (locale !== 'ru-RU') return `${WD_EN[w.weekday]} ${w.day} ${MON_EN[w.month - 1]}, ${pad(w.hour)}:${pad(w.minute)} (${tz})`;
  const parts: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(instant)) parts[x.type] = x.value;
  const wd = parts['weekday'] ?? '';
  const mon = parts['month'] ?? '';
  return `${wd} ${w.day} ${mon}, ${pad(w.hour)}:${pad(w.minute)} (${tz})`;
}

function pickLocale(lang: string): string {
  const l = (lang || 'en').toLowerCase().slice(0, 2);
  return ['ru', 'uk', 'kk', 'be'].includes(l) ? 'ru-RU' : 'en-GB';
}

/**
 * Intl.supportedValuesOf('timeZone') ∪ 'UTC', plus IANA aliases the engine accepts (e.g. 'Europe/Kyiv', which this ICU
 * lists only under its legacy canonical name 'Europe/Kiev'). Offsets like '+05:00' are rejected: a zone must be IANA.
 */
export function isValidTz(tz: string): boolean {
  if (!validZones) validZones = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (validZones.has(tz)) return true;
  if (!/^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    validZones.add(tz);
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD' in tz. */
export function localDay(instant: Ms, tz: string): string {
  const w = wallTimeOf(instant, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

function hhmmToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new RangeError(`bad HH:mm: ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new RangeError(`bad HH:mm: ${s}`);
  return h * 60 + mi;
}

/** True when the wall time at `instant` is inside [start, end). Windows that cross midnight are supported; start == end means no quiet window. */
export function inQuietHours(instant: Ms, tz: string, start: string, end: string): boolean {
  const s = hhmmToMin(start);
  const e = hhmmToMin(end);
  if (s === e) return false;
  const w = wallTimeOf(instant, tz);
  const m = w.hour * 60 + w.minute;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** `instant` if outside quiet hours, else the instant the window ends (wall time `end` on the right day, DST-aware). */
export function nextOutsideQuiet(instant: Ms, tz: string, start: string, end: string): Ms {
  if (!inQuietHours(instant, tz, start, end)) return instant;
  const s = hhmmToMin(start);
  const e = hhmmToMin(end);
  const w = wallTimeOf(instant, tz);
  const m = w.hour * 60 + w.minute;
  // crossing midnight and currently in the evening part → the window ends tomorrow
  const addDays = s > e && m >= s ? 1 : 0;
  const d = addDaysToDate(w.year, w.month, w.day, addDays);
  const r = zonedToInstant({ ...d, hour: Math.floor(e / 60), minute: e % 60 }, tz).instant;
  return r > instant ? r : instant;
}

export function addDaysToDate(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(year, month - 1, day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Parses 'YYYY-MM-DDTHH:mm' (the `*_local` tool format) into a WallTime; null if malformed or out of range. */
export function parseLocal(s: string): WallTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const w = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
  if (w.month < 1 || w.month > 12 || w.hour > 23 || w.minute > 59 || w.day < 1) return null;
  const check = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (check.getUTCMonth() !== w.month - 1) return null;
  return w;
}

/** WallTime → 'YYYY-MM-DDTHH:mm'. */
export function formatLocal(w: WallTime): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** ISO string with the zone's offset, e.g. '2026-10-14T15:00+05:00'. */
export function isoWithOffset(instant: Ms, tz: string): string {
  const w = wallTimeOf(instant, tz);
  const o = w.offsetMin;
  const sign = o < 0 ? '-' : '+';
  const a = Math.abs(o);
  return `${formatLocal(w)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
