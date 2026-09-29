// GR (spec 07 C4/C8) — the pure parts of the group participant: name-address detection, chattiness words, the window
// heuristic (open question / planning / venting veto / fast back-and-forth / quiet = never) and the caps.
import { describe, expect, it } from 'vitest';
import { capsCheck } from '../../../src/groups/chime.ts';
import { scoreWindow, thresholdOf, type WindowMessage } from '../../../src/groups/heuristic.ts';
import { addressedByName, chattinessFromWords, stepChattiness } from '../../../src/groups/names.ts';
import { capSentences } from '../../../src/groups/prompts.ts';
import { zonedToInstant } from '../../../src/kernel/timeMath.ts';
import { LIMITS } from '../../../src/config.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);
let id = 100;
const m = (from: number, text: string, atMs: number, o: { replyTo?: number; bot?: boolean } = {}): WindowMessage => ({
  tgMessageId: ++id, fromTgId: from, isBot: !!o.bot, text, at: atMs, replyToTgMessageId: o.replyTo ?? null,
});
const U = { threshold: (lvl: 'less' | 'normal' | 'more') => thresholdOf(lvl, 0) };
const opts = { unansweredMs: LIMITS.groupUnansweredQuestionMs };

describe('names (C4 addressed by name)', () => {
  it('matches "Гора, как думаешь?", "gora what\'s up", vocatives at the end', () => {
    for (const t of ['Гора, как думаешь?', 'гора ты тут?', 'gora what\'s up', 'Gora, help us pick', 'эй, Гора! где встречаемся?', 'а ты как думаешь, Гора?', 'thanks, Gora!', 'Горушка, привет']) {
      expect(addressedByName(t), t).toBe(true);
    }
  });
  it('does not match the common noun or names inside words', () => {
    for (const t of ['поехали в горы', 'на горе снег', 'в горах холодно', 'Горы зовут', 'горячий чай', 'gorachy', 'Gorazd is here', 'мы ходили на гору']) {
      expect(addressedByName(t), t).toBe(false);
    }
  });
  it('chattinessFromWords: RU/EN quieter, louder, quiet-only; long messages are not commands', () => {
    expect(chattinessFromWords('Гора, тише')).toBe('quieter');
    expect(chattinessFromWords('Гора, не лезь')).toBe('quieter');
    expect(chattinessFromWords('гора замолчи')).toBe('quieter');
    expect(chattinessFromWords('Gora, be quiet')).toBe('quieter');
    expect(chattinessFromWords('Гора, можешь чаще')).toBe('louder');
    expect(chattinessFromWords('Гора, будь активнее!')).toBe('louder');
    expect(chattinessFromWords('Gora, chime in more')).toBe('louder');
    expect(chattinessFromWords('Гора, отвечай только когда позовут')).toBe('quiet');
    expect(chattinessFromWords('Gora, only when mentioned please')).toBe('quiet');
    expect(chattinessFromWords('Гора, где встречаемся?')).toBeNull();
    expect(chattinessFromWords('Гора, не лезь к нему со своими советами, лучше расскажи что-нибудь про горы и про то, как туда доехать')).toBeNull();
  });
  it('chattiness steps: quiet < less < normal < more, clamped', () => {
    expect(stepChattiness('normal', 'quieter')).toBe('less');
    expect(stepChattiness('less', 'quieter')).toBe('quiet');
    expect(stepChattiness('quiet', 'quieter')).toBe('quiet');
    expect(stepChattiness('normal', 'louder')).toBe('more');
    expect(stepChattiness('more', 'louder')).toBe('more');
  });
});

describe('heuristic (C4 step 1)', () => {
  it('an open question to the group, unanswered ≥ 2 min, scores over the threshold', () => {
    const w = [m(1, 'привет всем', T0), m(2, 'хай', T0 + 10_000), m(1, 'кто-нибудь знает, во сколько закрывается Байтерек?', T0 + 20_000)];
    const early = scoreWindow(w, T0 + 20_000 + 45_000, opts);
    expect(early.score).toBeLessThan(U.threshold('normal'));
    expect(early.recheckAt).toBe(T0 + 20_000 + 2 * MIN);
    const later = scoreWindow(w, T0 + 20_000 + 2 * MIN, opts);
    expect(later.reasons).toContain('open_question');
    expect(later.kind).toBe('answer');
    expect(later.score).toBeGreaterThanOrEqual(U.threshold('normal'));
    expect(later.veto).toBe(false);
  });
  it('an answered question does not count; a question replying to one member is not to the group', () => {
    const q = m(1, 'где встречаемся?', T0);
    const answered = [q, m(2, 'у Лены', T0 + 30_000)];
    expect(scoreWindow(answered, T0 + 5 * MIN, opts).reasons).not.toContain('open_question');
    const a = m(2, 'купил билеты', T0);
    const toOne = [a, m(1, 'на какое число?', T0 + 10_000, { replyTo: a.tgMessageId })];
    expect(scoreWindow(toOne, T0 + 5 * MIN, opts).reasons).not.toContain('open_question');
  });
  it('venting vetoes (emotional words), whatever else is in the window', () => {
    const w = [m(1, 'когда соберёмся в субботу?', T0), m(2, 'мне так плохо, расстались вчера', T0 + 20_000), m(1, 'держись', T0 + 30_000)];
    const r = scoreWindow(w, T0 + 5 * MIN, opts);
    expect(r.veto).toBe(true);
    expect(r.reasons).toEqual(['venting']);
    expect(scoreWindow([m(1, 'I\'m so exhausted and sad today', T0)], T0 + 5 * MIN, opts).veto).toBe(true);
  });
  it('planning (dates, places) is positive; recommendation requests too', () => {
    const w = [m(1, 'давайте в субботу соберёмся', T0), m(2, 'где встречаемся? у Лены или в кафе', T0 + 20_000), m(3, 'можно у меня', T0 + 30_000)];
    const r = scoreWindow(w, T0 + 3 * MIN, opts);
    expect(r.reasons).toContain('planning');
    expect(r.score).toBeGreaterThan(0.3);
    expect(scoreWindow([m(1, 'посоветуйте сериал на вечер', T0)], T0 + 3 * MIN, opts).reasons).toContain('recommendation');
  });
  it('a fast back-and-forth is negative', () => {
    const w: WindowMessage[] = [];
    for (let i = 0; i < 8; i++) w.push(m(i % 2 ? 1 : 2, i === 0 ? 'кто знает, где купить билеты на концерт?' : `ага ${i}`, T0 + i * 5_000));
    const r = scoreWindow(w, T0 + 5 * MIN, opts);
    expect(r.reasons).toContain('fast_back_and_forth');
  });
  it('only what came after Gora\'s last message counts', () => {
    const w = [m(1, 'кто знает, где купить билеты?', T0), m(42, 'На kassir.kz', T0 + 3 * MIN, { bot: true })];
    expect(scoreWindow(w, T0 + 10 * MIN, opts).score).toBe(0);
  });
  it('thresholds: quiet = never (∞), less > normal > more', () => {
    expect(thresholdOf('quiet', 0)).toBe(Number.POSITIVE_INFINITY);
    expect(thresholdOf('less', 0)).toBeGreaterThan(thresholdOf('normal', 0));
    expect(thresholdOf('normal', 0)).toBeGreaterThan(thresholdOf('more', 0));
    expect(thresholdOf('normal', 0.1)).toBeGreaterThan(thresholdOf('normal', 0));
  });
});

describe('caps (C4)', () => {
  const TZ = 'Asia/Almaty';
  const local = (h: number, mi = 0, d = 28) => zonedToInstant({ year: 2026, month: 9, day: d, hour: h, minute: mi }, TZ).instant;
  const fresh = { lastChimeAt: null, chimesDay: null, chimesToday: 0 };
  it('30-min spacing, 6 per local day, never at night in the group tz, no tz → none', () => {
    expect(capsCheck(fresh, local(14), TZ, LIMITS)).toMatchObject({ ok: true, day: '2026-09-28', today: 0 });
    expect(capsCheck({ ...fresh, lastChimeAt: local(14) - 10 * MIN }, local(14), TZ, LIMITS)).toEqual({ ok: false, reason: 'spacing' });
    expect(capsCheck({ ...fresh, lastChimeAt: local(14) - 31 * MIN }, local(14), TZ, LIMITS).ok).toBe(true);
    expect(capsCheck({ ...fresh, chimesDay: '2026-09-28', chimesToday: 6 }, local(14), TZ, LIMITS)).toEqual({ ok: false, reason: 'daily' });
    // a new local day resets the counter
    expect(capsCheck({ ...fresh, chimesDay: '2026-09-27', chimesToday: 6 }, local(14), TZ, LIMITS)).toMatchObject({ ok: true, today: 0 });
    expect(capsCheck(fresh, local(23), TZ, LIMITS)).toEqual({ ok: false, reason: 'night' });
    expect(capsCheck(fresh, local(8, 59), TZ, LIMITS)).toEqual({ ok: false, reason: 'night' });
    expect(capsCheck(fresh, local(9, 0), TZ, LIMITS).ok).toBe(true);
    expect(capsCheck(fresh, local(14), null, LIMITS)).toEqual({ ok: false, reason: 'no_tz' });
  });
  it('a chime-in is at most 2 sentences', () => {
    expect(capSentences('Байтерек до 21:00. Билеты на входе. Удачи!', 2)).toBe('Байтерек до 21:00. Билеты на входе.');
    expect(capSentences('Без точки в конце', 2)).toBe('Без точки в конце');
  });
});
