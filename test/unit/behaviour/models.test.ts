// Friend set B — the pure learned components (spec 05 C1–C4): text features, the rhythm model (C2), the style model
// (C3) and the Thompson bandit (C4). Deterministic: every random draw comes from seededRandom.
import { describe, expect, it } from 'vitest';
import type { ProactiveContentType } from '../../../src/contracts/index.ts';
import { seededRandom } from '../../../src/kernel/random.ts';
import { zonedToInstant } from '../../../src/kernel/timeMath.ts';
import { langOf, textFeatures } from '../../../src/behaviour/features.ts';
import { addMessage, binOf, decayedTo, defaultShape, effectiveWeeks, pActiveOf, populationPrior, rates, topBins } from '../../../src/behaviour/rhythm.ts';
import { emptyStyle, hintsOf, styleLine, updateStyle } from '../../../src/behaviour/style.ts';
import { gapBucketOf, othersOf, posteriorMean, posteriorOf, priorOf, thompson, type Evidence } from '../../../src/behaviour/bandit.ts';
import { bytesToHist, histToBytes } from '../../../src/behaviour/repo.ts';

const DAY = 86_400_000;
const HL = 21 * DAY;
const TZ = 'Asia/Almaty';
const at = (y: number, mo: number, d: number, h: number, mi = 0) => zonedToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, TZ).instant;

describe('text features (C1: numbers and enums only)', () => {
  it('length, emoji, script, question and ты/вы register', () => {
    expect(textFeatures('Привет! Как ты? 😀😀')).toMatchObject({ length: 18, emoji: 2, script: 'cyrillic', question: true, register: 'informal' });
    expect(textFeatures('Здравствуйте, подскажите пожалуйста время')).toMatchObject({ script: 'cyrillic', register: 'formal', question: false });
    expect(textFeatures('what should I cook tonight')).toMatchObject({ script: 'latin', question: true, register: null });
    expect(textFeatures('ok')).toMatchObject({ script: 'latin', question: false });
    expect(textFeatures('👍')).toMatchObject({ length: 1, emoji: 1, script: null });
    // "долго" (a long time) is not a marker of anything; "вы" inside another word does not count
    expect(textFeatures('выход через час').register).toBeNull();
  });
  it('langOf: the script wins over a mismatching Telegram language', () => {
    expect(langOf('cyrillic', 'en')).toBe('ru');
    expect(langOf('cyrillic', 'kk')).toBe('kk');
    expect(langOf('latin', 'ru')).toBe('en');
    expect(langOf('latin', 'de')).toBe('de');
    expect(langOf(null, 'ru')).toBeNull();
  });
});

describe('rhythm model (C2)', () => {
  it('learns peaks: 14 evenings at 20:00–21:00 → P(20:30) > P(04:00), 20:00 is in the top-30% set', () => {
    let h: Float64Array | null = null;
    let upd: number | null = null;
    for (let d = 1; d <= 14; d++) {
      for (const m of [5, 40]) {
        const r = addMessage(h, upd, at(2026, 10, d, 20, m), TZ, HL);
        h = r.hist;
        upd = r.updatedAt;
      }
    }
    const now = at(2026, 10, 15, 12);
    const prior = populationPrior([], now, HL);
    const lam = rates(decayedTo(h!, upd!, now, HL), at(2026, 10, 1, 20), now, prior, 5, HL);
    const top = topBins(lam, 0.3);
    const thu = binOf(at(2026, 10, 15, 20, 30), TZ); // Thursday
    expect(pActiveOf(lam, thu.bin)).toBeGreaterThan(pActiveOf(lam, binOf(at(2026, 10, 15, 4), TZ).bin) * 10);
    expect(pActiveOf(lam, thu.bin)).toBeGreaterThan(0.5);
    for (let wd = 0; wd < 7; wd++) expect(top.has(wd * 24 + 20)).toBe(true);
    // hours the owner never uses are not "learned" hours just because the prior ranks them
    for (let wd = 0; wd < 7; wd++) for (const hr of [3, 9, 12, 15]) expect(top.has(wd * 24 + hr)).toBe(false);
  });
  it('the population prior smooths a new user: no zeros, and a sane day shape', () => {
    const now = at(2026, 10, 15, 12);
    const lam = rates(null, null, now, populationPrior([], now, HL), 5, HL);
    for (let i = 0; i < 168; i++) expect(lam[i]).toBeGreaterThan(0);
    const top = topBins(lam, 0.3);
    expect(top.size).toBeGreaterThan(20);
    expect(top.has(1 * 24 + 4)).toBe(false); // not at 4 am
    expect(top.has(1 * 24 + 19)).toBe(true);
    expect(defaultShape().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
  it('a population of evening people shifts a newcomer toward the evening', () => {
    const now = at(2026, 10, 15, 12);
    const users = Array.from({ length: 5 }, () => {
      let h: Float64Array | null = null;
      let u: number | null = null;
      for (let d = 1; d <= 14; d++) ({ hist: h, updatedAt: u } = addMessage(h, u, at(2026, 10, d, 22, 30), TZ, HL));
      return { hist: h!, updatedAt: u!, since: at(2026, 10, 1, 22) };
    });
    const cold = rates(null, null, now, populationPrior([], now, HL), 5, HL);
    const warm = rates(null, null, now, populationPrior(users, now, HL), 5, HL);
    const bin22 = 3 * 24 + 22;
    const bin10 = 3 * 24 + 10;
    expect(warm[bin22]! / warm[bin10]!).toBeGreaterThan(cold[bin22]! / cold[bin10]!);
  });
  it('decays with a 21-day half-life; old habits fade', () => {
    const r = addMessage(null, null, at(2026, 10, 1, 9), TZ, HL);
    const b = binOf(at(2026, 10, 1, 9), TZ).bin;
    expect(decayedTo(r.hist, r.updatedAt, r.updatedAt + HL, HL)[b]).toBeCloseTo(0.5, 9);
    const r2 = addMessage(r.hist, r.updatedAt, r.updatedAt + 2 * HL, TZ, HL);
    expect(r2.hist[b]).toBeCloseTo(1.25, 9); // 0.25 left of the old one + the new one (same weekday/hour, 42 days later)
    // late (out-of-order) messages are weighted by their age instead of decaying the rest
    const r3 = addMessage(r2.hist, r2.updatedAt, r2.updatedAt - HL, TZ, HL);
    expect(r3.updatedAt).toBe(r2.updatedAt);
    expect(effectiveWeeks(null, 0, HL)).toBeCloseTo((21 / Math.LN2 / 7) * (1 - 1 / 16), 6);
    expect(bytesToHist(histToBytes(r2.hist))).toEqual(r2.hist);
  });
});

describe('style model (C3)', () => {
  it('null until 5 messages; EMAs give short / light emoji / informal / ru', () => {
    let st = emptyStyle(0);
    for (let i = 0; i < 4; i++) st = updateStyle(st, textFeatures('привет, как ты? 🙂'));
    expect(hintsOf(st, 'en')).toBeNull();
    st = updateStyle(st, textFeatures('слушай, напомни завтра про встречу'));
    expect(hintsOf(st, 'en')).toEqual({ replyLength: 'short', emoji: 'light', register: 'informal', languages: ['ru'] });
    expect(JSON.stringify(st)).not.toMatch(/привет|встреч/); // numbers only
  });
  it('long formal English writer', () => {
    let st = emptyStyle(0);
    const long = 'I would like to plan the quarterly offsite for my team. '.repeat(6);
    for (let i = 0; i < 8; i++) st = updateStyle(st, textFeatures(long));
    expect(hintsOf(st, 'en')).toMatchObject({ replyLength: 'long', emoji: 'none', register: 'mixed', languages: ['en'] });
  });
  it('explicit overrides beat learned hints in the <user_model> style line', () => {
    const h = { replyLength: 'long' as const, emoji: 'lots' as const, register: 'formal' as const, languages: ['ru', 'en'] };
    expect(styleLine(h, null)).toBe('style: reply_length=long emoji=lots register=formal lang=ru+en');
    expect(styleLine(h, { length: 'short', emoji: 'none' })).toBe('style: reply_length=short emoji=none register=formal lang=ru+en set_by_owner=length,emoji');
    expect(styleLine(null, { register: 'informal' })).toBe('style: register=informal set_by_owner=register');
    expect(styleLine(null, null)).toBeNull();
  });
});

describe('Thompson bandit (C4)', () => {
  const base = { own: new Map<string, Evidence>(), others: new Map<string, Evidence>(), unanswered: 0, annoyancePerUnanswered: 0.25, priorCap: 10, threshold: 0.3 };
  it('gap buckets', () => {
    expect([0.5, 1, 2.9, 3, 5.9, 6, 10.9, 11, 20.9, 21, 45.9, 46].map((d) => gapBucketOf(d * DAY))).toEqual(
      ['<1d', '1-2d', '1-2d', '3-5d', '3-5d', '6-10d', '6-10d', '11-20d', '11-20d', '21-45d', '21-45d', '>45d'],
    );
  });
  it('conservative start: a bare check-in right after a chat is rare; the hierarchical prior is capped at 10', () => {
    const r = seededRandom(5);
    let n = 0;
    for (let i = 0; i < 2000; i++) if (thompson(r, { ...base, available: ['checkin'], gap: '<1d' })!.send) n++;
    expect(n / 2000).toBeLessThan(0.02);
    expect(priorOf('type:checkin', undefined, 10)).toEqual({ a: expect.closeTo(1.5, 9), b: expect.closeTo(3.5, 9) });
    const p = priorOf('type:checkin', { alpha: 900, beta: 100 }, 10); // the population loves check-ins
    expect(p.a + p.b).toBeCloseTo(10, 9);
    expect(p.a / (p.a + p.b)).toBeGreaterThan(0.85);
    expect(othersOf(new Map([['type:checkin', { alpha: 5, beta: 7 }]]), new Map([['type:checkin', { alpha: 2, beta: 7 }]])).get('type:checkin')).toEqual({ alpha: 3, beta: 0 });
  });
  it('annoyance lowers the score: 4 unanswered → score 0', () => {
    const a = thompson(seededRandom(9), { ...base, available: ['follow_up'], gap: '3-5d' })!;
    const b = thompson(seededRandom(9), { ...base, available: ['follow_up'], gap: '3-5d', unanswered: 2 })!;
    const c = thompson(seededRandom(9), { ...base, available: ['follow_up'], gap: '3-5d', unanswered: 4 })!;
    expect(b.score).toBeCloseTo(a.score * 0.5, 12);
    expect(c.score).toBe(0);
    expect(c.send).toBe(false);
  });
  it('same seed → same decisions', () => {
    const run = (seed: number) => {
      const r = seededRandom(seed);
      return Array.from({ length: 50 }, () => thompson(r, { ...base, available: ['follow_up', 'useful', 'checkin'], gap: '6-10d' }));
    };
    expect(run(1)).toEqual(run(1));
    expect(run(1)).not.toEqual(run(2));
  });
  it('converges: a user who always replies to follow_up and never to checkin → follow_up dominates', () => {
    const r = seededRandom(1);
    const own = new Map<string, Evidence>();
    const bump = (k: string, a: number, b: number) => {
      const e = own.get(k) ?? { alpha: 0, beta: 0 };
      own.set(k, { alpha: e.alpha + a, beta: e.beta + b });
    };
    const sends: ProactiveContentType[] = [];
    let unanswered = 0;
    for (let i = 0; i < 200; i++) {
      const c = thompson(r, { ...base, own, available: ['follow_up', 'checkin'], gap: '3-5d', unanswered })!;
      if (!c.send) continue;
      sends.push(c.contentType);
      const replied = c.contentType === 'follow_up';
      bump(`type:${c.contentType}`, replied ? 1 : 0, replied ? 0 : 1);
      bump('gap:3-5d', replied ? 1 : 0, replied ? 0 : 1);
      unanswered = replied ? 0 : Math.min(3, unanswered + 1); // the policy's hard stop is tested separately
    }
    const last = sends.slice(-50);
    expect(sends.length).toBeGreaterThanOrEqual(50);
    expect(last.filter((x) => x === 'follow_up').length / last.length).toBeGreaterThanOrEqual(0.8);
    const mean = (k: string) => posteriorMean(posteriorOf(k, own.get(k), undefined, 10));
    expect(mean('type:checkin')).toBeLessThan(mean('type:follow_up'));
    expect(mean('type:follow_up')).toBeGreaterThan(0.8);
  });
});
