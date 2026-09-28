import { describe, expect, it } from 'vitest';
import {
  addDaysToDate, formatDisplay, formatLocal, inQuietHours, isoWithOffset, isValidTz, localDay, nextOutsideQuiet, offsetMinutes, parseLocal, wallTimeOf, zonedToInstant,
} from '../../../src/kernel/timeMath.ts';

const Z = (y: number, mo: number, d: number, h: number, mi: number, tz: string) => zonedToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, tz);

describe('timeMath (01 §8.1)', () => {
  it('Europe/Kyiv 2027-03-28 03:30 falls in the DST gap → shifted to 04:30 (+03:00)', () => {
    const r = Z(2027, 3, 28, 3, 30, 'Europe/Kyiv');
    expect(r.adjusted).toBe('gap_shifted');
    expect(isoWithOffset(r.instant, 'Europe/Kyiv')).toBe('2027-03-28T04:30+03:00');
  });
  it('Europe/Kyiv 2026-10-25 03:30 is ambiguous → the earlier instant (+03:00)', () => {
    const r = Z(2026, 10, 25, 3, 30, 'Europe/Kyiv');
    expect(r.adjusted).toBe('overlap_earlier');
    expect(isoWithOffset(r.instant, 'Europe/Kyiv')).toBe('2026-10-25T03:30+03:00');
    expect(new Date(r.instant).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('an ordinary Kyiv time is unadjusted on both sides of DST', () => {
    expect(Z(2026, 7, 1, 12, 0, 'Europe/Kyiv')).toEqual({ instant: Date.UTC(2026, 6, 1, 9, 0), adjusted: 'none' });
    expect(Z(2026, 12, 1, 12, 0, 'Europe/Kyiv')).toEqual({ instant: Date.UTC(2026, 11, 1, 10, 0), adjusted: 'none' });
  });
  it('America/New_York gap and overlap', () => {
    const gap = Z(2026, 3, 8, 2, 30, 'America/New_York');
    expect(gap.adjusted).toBe('gap_shifted');
    expect(isoWithOffset(gap.instant, 'America/New_York')).toBe('2026-03-08T03:30-04:00');
    const ov = Z(2026, 11, 1, 1, 30, 'America/New_York');
    expect(ov.adjusted).toBe('overlap_earlier');
    expect(isoWithOffset(ov.instant, 'America/New_York')).toBe('2026-11-01T01:30-04:00');
  });
  it('Asia/Almaty is always +05:00', () => {
    for (let m = 0; m < 12; m++) expect(offsetMinutes(Date.UTC(2026, m, 15, 12), 'Asia/Almaty')).toBe(300);
    expect(Z(2026, 10, 14, 15, 0, 'Asia/Almaty')).toEqual({ instant: Date.UTC(2026, 9, 14, 10, 0), adjusted: 'none' });
  });
  it('formatDisplay gives "Tue 14 Oct, 15:00 (Asia/Almaty)"', () => {
    // 14 Oct is a Tuesday in 2025 (the spec example); 14 Oct 2026 is a Wednesday.
    const t = Z(2025, 10, 14, 15, 0, 'Asia/Almaty').instant;
    expect(formatDisplay(t, 'Asia/Almaty', 'en')).toBe('Tue 14 Oct, 15:00 (Asia/Almaty)');
    expect(formatDisplay(Z(2026, 10, 14, 15, 0, 'Asia/Almaty').instant, 'Asia/Almaty', 'en')).toBe('Wed 14 Oct, 15:00 (Asia/Almaty)');
    expect(formatDisplay(t, 'Asia/Almaty', 'ru')).toMatch(/^вт 14 окт\.?, 15:00 \(Asia\/Almaty\)$/);
    expect(formatDisplay(Date.UTC(2026, 0, 1, 0, 5), 'UTC', 'en')).toBe('Thu 1 Jan, 00:05 (UTC)');
    // 3-letter months always (ICU en-GB says "Sept")
    expect(formatDisplay(Date.UTC(2026, 8, 28, 9, 3), 'Asia/Almaty', 'en')).toBe('Mon 28 Sep, 14:03 (Asia/Almaty)');
  });
  it('wallTimeOf reports weekday and offset', () => {
    const w = wallTimeOf(Date.UTC(2026, 8, 28, 20, 30), 'Asia/Almaty');
    expect(w).toEqual({ year: 2026, month: 9, day: 29, hour: 1, minute: 30, weekday: 2, offsetMin: 300 });
  });
  it('localDay follows the zone', () => {
    const t = Date.UTC(2026, 8, 28, 20, 0);
    expect(localDay(t, 'Asia/Almaty')).toBe('2026-09-29');
    expect(localDay(t, 'UTC')).toBe('2026-09-28');
    expect(localDay(t, 'America/Los_Angeles')).toBe('2026-09-28');
  });
  it('quiet windows across midnight', () => {
    const at = (h: number, m = 0) => Z(2026, 9, 28, h, m, 'Asia/Almaty').instant;
    expect(inQuietHours(at(23), 'Asia/Almaty', '22:00', '08:00')).toBe(true);
    expect(inQuietHours(at(2), 'Asia/Almaty', '22:00', '08:00')).toBe(true);
    expect(inQuietHours(at(8), 'Asia/Almaty', '22:00', '08:00')).toBe(false);
    expect(inQuietHours(at(21, 59), 'Asia/Almaty', '22:00', '08:00')).toBe(false);
    expect(inQuietHours(at(13), 'Asia/Almaty', '12:00', '14:00')).toBe(true);
    expect(inQuietHours(at(14), 'Asia/Almaty', '12:00', '14:00')).toBe(false);
    expect(inQuietHours(at(3), 'Asia/Almaty', '00:00', '00:00')).toBe(false);
    expect(isoWithOffset(nextOutsideQuiet(at(23), 'Asia/Almaty', '22:00', '08:00'), 'Asia/Almaty')).toBe('2026-09-29T08:00+05:00');
    expect(isoWithOffset(nextOutsideQuiet(at(2), 'Asia/Almaty', '22:00', '08:00'), 'Asia/Almaty')).toBe('2026-09-28T08:00+05:00');
    expect(nextOutsideQuiet(at(10), 'Asia/Almaty', '22:00', '08:00')).toBe(at(10));
    expect(() => inQuietHours(at(1), 'UTC', '25:00', '08:00')).toThrow();
  });
  it('nextOutsideQuiet lands on the right instant across a DST change', () => {
    // Kyiv: 2026-10-25 is the fall-back night; quiet 22:00–08:00 from 23:00 on the 24th ends 08:00 (+02:00) on the 25th.
    const t = Z(2026, 10, 24, 23, 0, 'Europe/Kyiv').instant;
    expect(isoWithOffset(nextOutsideQuiet(t, 'Europe/Kyiv', '22:00', '08:00'), 'Europe/Kyiv')).toBe('2026-10-25T08:00+02:00');
  });
  it('isValidTz', () => {
    expect(isValidTz('UTC')).toBe(true);
    expect(isValidTz('Asia/Almaty')).toBe(true);
    expect(isValidTz('Europe/Kyiv')).toBe(true);
    expect(isValidTz('Mars/Olympus')).toBe(false);
    expect(isValidTz('')).toBe(false);
  });
  it('parseLocal / formatLocal / addDaysToDate', () => {
    expect(parseLocal('2026-10-14T15:00')).toEqual({ year: 2026, month: 10, day: 14, hour: 15, minute: 0 });
    expect(parseLocal('2026-02-30T10:00')).toBeNull();
    expect(parseLocal('2026-10-14 15:00')).toBeNull();
    expect(parseLocal('2026-10-14T24:00')).toBeNull();
    expect(formatLocal({ year: 2026, month: 1, day: 2, hour: 3, minute: 4 })).toBe('2026-01-02T03:04');
    expect(addDaysToDate(2026, 12, 31, 1)).toEqual({ year: 2027, month: 1, day: 1 });
  });
});
