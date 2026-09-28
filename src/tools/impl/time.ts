// tools/impl/time.ts (WP5) — time_resolve (01 §6, §8.1): chrono-node on the owner's wall clock, then converted to an
// instant in the zone with kernel/timeMath (DST gaps shift forward, overlaps take the earlier instant).
import * as chrono from 'chrono-node';
import { z } from 'zod';
import type { Ms, ToolSpec } from '../../contracts/index.ts';
import { formatDisplay, isoWithOffset, isValidTz, wallTimeOf, zonedToInstant, type WallTime } from '../../kernel/timeMath.ts';
import { zTz } from '../schema.ts';
import { L, READ_PUBLIC, toolError } from './common.ts';

const input = z.object({
  expression: z.string().min(1).max(200),
  tz: zTz.optional(),
});
type In = z.infer<typeof input>;

export interface ResolvedTime { iso: string; unix: number; display: string; tz: string; ambiguous: boolean; alternatives: string[]; adjusted?: 'gap_shifted' | 'overlap_earlier' }

type Parsed = { start: { get(c: string): number | null; isCertain(c: string): boolean }; text: string };

function parseWith(expr: string, refWall: Date): Parsed[] {
  const ref = { instant: refWall, timezone: 0 };
  const cyr = /[Ѐ-ӿ]/.test(expr);
  const primary = cyr ? chrono.ru.casual : chrono.casual;
  const secondary = cyr ? chrono.casual : chrono.ru.casual;
  const r = primary.parse(expr, ref, { forwardDate: true }) as unknown as Parsed[];
  return r.length ? r : (secondary.parse(expr, ref, { forwardDate: true }) as unknown as Parsed[]);
}

function wallOf(p: Parsed): WallTime | null {
  const g = (c: string) => p.start.get(c);
  const [year, month, day] = [g('year'), g('month'), g('day')];
  if (year === null || month === null || day === null) return null;
  return { year, month, day, hour: g('hour') ?? 9, minute: g('minute') ?? 0 };
}

/** Pure resolver (exported for tests and for other WP5 code). Returns null when nothing parses. */
export function resolveTime(expression: string, tz: string, now: Ms, lang: string): ResolvedTime | null {
  const w = wallTimeOf(now, tz);
  const refWall = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute));
  const results = parseWith(expression, refWall);
  const first = results[0];
  if (!first) return null;
  const wall = wallOf(first);
  if (!wall) return null;
  const { instant, adjusted } = zonedToInstant(wall, tz);
  const alternatives: string[] = [];
  const pushAlt = (t: Ms) => {
    const d = formatDisplay(t, tz, lang);
    if (t !== instant && !alternatives.includes(d)) alternatives.push(d);
  };
  // An hour ≤ 12 without a certain meridiem ("at 5") could be either half of the day.
  const hour = first.start.get('hour');
  if (hour !== null && hour >= 1 && hour <= 12 && first.start.isCertain('hour') && !first.start.isCertain('meridiem')) {
    const other = { ...wall, hour: hour === 12 ? 0 : hour + 12 };
    if (other.hour <= 23) pushAlt(zonedToInstant(other, tz).instant);
  }
  // "next Friday" is read by chrono as the week after; offer the coming one too.
  if (/\bnext\s+(mon|tue|wed|thu|fri|sat|sun)/i.test(expression)) pushAlt(instant - 7 * 86_400_000);
  for (const r of results.slice(1, 3)) {
    const wr = wallOf(r);
    if (wr) pushAlt(zonedToInstant(wr, tz).instant);
  }
  const out: ResolvedTime = {
    iso: isoWithOffset(instant, tz), unix: Math.floor(instant / 1000), display: formatDisplay(instant, tz, lang), tz,
    ambiguous: alternatives.length > 0 || adjusted !== 'none', alternatives,
  };
  if (adjusted !== 'none') out.adjusted = adjusted;
  return out;
}

export const timeTool: ToolSpec<In, ResolvedTime> = {
  name: 'time_resolve',
  description: 'Resolve a time phrase to an exact instant before quoting or scheduling it.',
  input,
  surfaces: ['dm', 'topic', 'mission', 'group', 'guest', 'biz_draft'],
  parallelSafe: true,
  classify: () => READ_PUBLIC,
  statusLabel: (_i, lang) => L(lang, '🕒 Checking the time…', '🕒 Уточняю время…'),
  async execute(i, ctx) {
    const tz = i.tz ?? ctx.tz;
    if (!isValidTz(tz)) return toolError('INVALID_TZ', `unknown time zone ${tz}`);
    const r = resolveTime(i.expression, tz, ctx.now, ctx.lang);
    if (!r) return toolError('UNPARSEABLE', 'could not understand that time; ask the user for a date and time');
    return { content: JSON.stringify(r), data: r };
  },
};
