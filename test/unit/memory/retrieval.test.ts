// Spec 05 B3: the hybrid ranking (memory/retrieval.ts) — weighted RRF of BM25 and cosine, × importance × recency decay.
// Pure and deterministic: controlled scores stand in for the embedder.
import { describe, expect, it } from 'vitest';
import { decay, hybridRank, importanceWeight, ranks, RRF_K, type RankInput } from '../../../src/memory/retrieval.ts';

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const f = (id: string, o: Partial<RankInput> = {}): RankInput => ({ id, kind: 'fact', pinned: false, importance: 0.5, updatedAt: NOW, bm: 0, cos: null, ...o });
const order = (xs: RankInput[]) =>
  hybridRank(xs, { now: NOW, halfLifeDays: 30 })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id);

describe('ranks()', () => {
  it('competition ranking: ties share the best rank, nulls stay unranked', () => {
    expect(ranks([0.5, null, 0.9, 0.5, 0.1])).toEqual([2, null, 1, 2, 4]);
    expect(ranks([3, 2, 1], (v) => v > 1)).toEqual([1, 2, null]);
  });
});

describe('hybridRank (B3)', () => {
  it('ranks a paraphrase (semantic match) above an unrelated keyword match', () => {
    // "what can't Anna eat?" → the allergy fact is a paraphrase (high cosine, no shared keyword); the recipe shares "eat"
    const allergy = f('allergy', { cos: 0.97, bm: 0 });
    const recipe = f('recipe', { cos: 0.05, bm: 2.3 });
    expect(order([recipe, allergy])).toEqual(['allergy', 'recipe']);
  });

  it('falls back to BM25 alone when there are no vectors (model unavailable)', () => {
    const allergy = f('allergy', { cos: null, bm: 0 });
    const recipe = f('recipe', { cos: null, bm: 2.3 });
    expect(order([allergy, recipe])).toEqual(['recipe']);
  });

  it('uses a relative semantic window (e5 cosines are compressed): far-below-best cosines do not count', () => {
    const r = hybridRank([f('a', { cos: 0.86 }), f('b', { cos: 0.8 }), f('c', { cos: 0.7 })], { now: NOW, halfLifeDays: 30 });
    expect(r.map((x) => x.semRank)).toEqual([1, 2, null]);
    expect(r[0]!.rrf).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('a fact matched by both legs beats one matched by a single leg', () => {
    expect(order([f('one', { cos: 0.9 }), f('both', { cos: 0.9, bm: 1 })])).toEqual(['both', 'one']);
  });

  it('decay: equal relevance, 10 vs 90 days old → the newer first; a pinned or profile-kind old fact does not decay', () => {
    const newer = f('newer', { cos: 0.9, bm: 1, updatedAt: NOW - 10 * DAY });
    const older = f('older', { cos: 0.9, bm: 1, updatedAt: NOW - 90 * DAY });
    expect(order([older, newer])).toEqual(['newer', 'older']);
    const pinnedOld = f('pinnedOld', { cos: 0.9, bm: 1, updatedAt: NOW - 90 * DAY, pinned: true });
    expect(order([newer, pinnedOld])).toEqual(['pinnedOld', 'newer']);
    const profileOld = f('profileOld', { cos: 0.9, bm: 1, updatedAt: NOW - 400 * DAY, kind: 'profile' });
    expect(order([newer, profileOld])).toEqual(['profileOld', 'newer']);
    expect(decay({ kind: 'fact', pinned: false, updatedAt: NOW - 30 * DAY }, NOW, 30)).toBeCloseTo(0.5);
    expect(decay({ kind: 'fact', pinned: false, updatedAt: NOW - 90 * DAY }, NOW, 30)).toBeCloseTo(0.125);
  });

  it('importance: higher beats lower at equal age and relevance', () => {
    const hi = f('hi', { cos: 0.9, bm: 1, importance: 0.9 });
    const lo = f('lo', { cos: 0.9, bm: 1, importance: 0.2 });
    expect(order([lo, hi])).toEqual(['hi', 'lo']);
    expect(importanceWeight(0)).toBe(0.5);
    expect(importanceWeight(1)).toBe(1.5);
    expect(importanceWeight(Number.NaN)).toBe(1);
  });

  it('is deterministic and matches nothing for an empty signal', () => {
    const xs = [f('a', { cos: 0.4, bm: 0.2 }), f('b', { cos: 0.41 }), f('c')];
    expect(hybridRank(xs, { now: NOW, halfLifeDays: 30 })).toEqual(hybridRank(xs, { now: NOW, halfLifeDays: 30 }));
    expect(hybridRank([f('c')], { now: NOW, halfLifeDays: 30 })[0]!.score).toBe(0);
  });
});
