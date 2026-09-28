// WP5 — time_resolve (01 §6, §8.1): chrono-node on the wall clock, converted in the zone; ambiguity; DST.
import { describe, expect, it } from 'vitest';
import { resolveTime, timeTool } from '../../../src/tools/impl/time.ts';
import { createToolEnv } from './env.ts';

// FakeClock starts at 2026-09-28 09:00 UTC = 14:00 in Asia/Almaty (UTC+5, no DST).
const NOW = Date.UTC(2026, 8, 28, 9, 0);

describe('time_resolve', () => {
  it('"tomorrow 3pm" in Asia/Almaty', () => {
    const r = resolveTime('tomorrow 3pm', 'Asia/Almaty', NOW, 'en')!;
    expect(r.iso).toBe('2026-09-29T15:00+05:00');
    expect(r.unix).toBe(Date.UTC(2026, 8, 29, 10, 0) / 1000);
    expect(r.display).toBe('Tue 29 Sep, 15:00 (Asia/Almaty)');
    expect(r.tz).toBe('Asia/Almaty');
    expect(r.ambiguous).toBe(false);
  });

  it('Russian input and a relative offset', () => {
    expect(resolveTime('завтра в 15:00', 'Asia/Almaty', NOW, 'ru')!.iso).toBe('2026-09-29T15:00+05:00');
    expect(resolveTime('in 2 hours', 'Asia/Almaty', NOW, 'en')!.iso).toBe('2026-09-28T16:00+05:00');
  });

  it('ambiguous input offers alternatives', () => {
    const r = resolveTime('at 5', 'Asia/Almaty', NOW, 'en')!;
    expect(r.ambiguous).toBe(true);
    expect(r.alternatives.some((a) => a.includes('17:00'))).toBe(true);
    const nf = resolveTime('next friday 10:00', 'Asia/Almaty', NOW, 'en')!;
    expect(nf.ambiguous).toBe(true);
    expect(nf.alternatives.length).toBeGreaterThan(0);
  });

  it('DST gap shifts forward and an overlap takes the earlier instant (Europe/Berlin)', () => {
    const gap = resolveTime('March 28 2027 2:30', 'Europe/Berlin', NOW, 'en')!;
    expect(gap.adjusted).toBe('gap_shifted');
    expect(gap.iso).toBe('2027-03-28T03:30+02:00');
    expect(gap.ambiguous).toBe(true);
    const overlap = resolveTime('October 25 2026 2:30', 'Europe/Berlin', NOW, 'en')!;
    expect(overlap.adjusted).toBe('overlap_earlier');
    expect(overlap.iso).toBe('2026-10-25T02:30+02:00');
  });

  it('unparseable input and a bad zone are clean tool errors', async () => {
    const env = createToolEnv();
    const bad = await env.run(timeTool, { expression: 'blorp' });
    expect(bad.isError).toBe(true);
    expect(() => timeTool.input.parse({ expression: 'tomorrow', tz: '+05:00' })).toThrow();
    const ok = await env.run(timeTool, { expression: 'tomorrow 3pm', tz: 'Europe/Moscow' });
    expect(JSON.parse(ok.content).iso).toBe('2026-09-29T15:00+03:00');
    expect(timeTool.classify({ expression: 'x' }, env.ctx())).toMatchObject({ actionClass: 'read_public', risk: 0 });
  });
});
