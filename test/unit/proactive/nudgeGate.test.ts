// WP6b — NudgeGate (01 §8.4), pure: check order, thresholds, backoff, budget, quiet hours.
import { describe, expect, it } from 'vitest';
import { clampWeight, DEFAULT_PREF, effectiveBudget, gate, jitterFor, JITTER_MAX_MS, type GateInput } from '../../../src/proactive/nudgeGate.ts';

const base = (o: Partial<GateInput> = {}): GateInput => ({
  now: 1_000, userActive: true, pref: { ...DEFAULT_PREF }, dedupeHit: false,
  candidate: { score: 0.8, priority: 'normal', countsAgainstBudget: true }, sentToday: 0, budget: 3, inQuiet: false, ...o,
});

describe('NudgeGate', () => {
  it('sends a good candidate', () => expect(gate(base())).toEqual({ action: 'send' }));

  it('checks in the §8.4 order: inactive → muted → snoozed → dedupe → score → budget → quiet', () => {
    const all = base({ userActive: false, pref: { muted: true, snoozeUntil: 5_000, weight: 0.1, ignoredStreak: 5 }, dedupeHit: true, sentToday: 9, inQuiet: true });
    expect(gate(all)).toEqual({ action: 'drop', reason: 'inactive' });
    expect(gate({ ...all, userActive: true })).toEqual({ action: 'drop', reason: 'muted' });
    expect(gate({ ...all, userActive: true, pref: { ...all.pref, muted: false } })).toEqual({ action: 'drop', reason: 'snoozed' });
    const unsnoozed = { ...all, userActive: true, pref: { ...all.pref, muted: false, snoozeUntil: 500 } };
    expect(gate(unsnoozed)).toEqual({ action: 'drop', reason: 'dedupe' });
    expect(gate({ ...unsnoozed, dedupeHit: false })).toEqual({ action: 'drop', reason: 'score' });
    const scored = { ...unsnoozed, dedupeHit: false, pref: { ...unsnoozed.pref, weight: 1, ignoredStreak: 0 } };
    expect(gate(scored)).toEqual({ action: 'drop', reason: 'budget' });
    expect(gate({ ...scored, sentToday: 0 })).toEqual({ action: 'defer' });
  });

  it('score × weight ≥ 0.4, or ≥ 0.7 once ignored_streak ≥ 3', () => {
    expect(gate(base({ candidate: { score: 0.4, priority: 'normal', countsAgainstBudget: true } })).action).toBe('send');
    expect(gate(base({ candidate: { score: 0.39, priority: 'normal', countsAgainstBudget: true } }))).toEqual({ action: 'drop', reason: 'score' });
    expect(gate(base({ pref: { ...DEFAULT_PREF, weight: 0.4 } }))).toEqual({ action: 'drop', reason: 'score' }); // 0.8 × 0.4
    expect(gate(base({ pref: { ...DEFAULT_PREF, weight: 0.5 } })).action).toBe('send'); // 0.8 × 0.5 = 0.4
    expect(gate(base({ pref: { ...DEFAULT_PREF, ignoredStreak: 2 }, candidate: { score: 0.5, priority: 'normal', countsAgainstBudget: true } })).action).toBe('send');
    expect(gate(base({ pref: { ...DEFAULT_PREF, ignoredStreak: 3 }, candidate: { score: 0.69, priority: 'normal', countsAgainstBudget: true } }))).toEqual({ action: 'drop', reason: 'score' });
    expect(gate(base({ pref: { ...DEFAULT_PREF, weight: 0.7, ignoredStreak: 3 }, candidate: { score: 1, priority: 'normal', countsAgainstBudget: true } })).action).toBe('send');
  });

  it('budget counts only budgeted nudges; budget-exempt ones pass a full budget', () => {
    expect(gate(base({ sentToday: 3 }))).toEqual({ action: 'drop', reason: 'budget' });
    expect(gate(base({ sentToday: 3, candidate: { score: 1, priority: 'high', countsAgainstBudget: false } })).action).toBe('send');
    expect(gate(base({ budget: 0 }))).toEqual({ action: 'drop', reason: 'budget' });
  });

  it('quiet hours defer high/normal and drop low', () => {
    expect(gate(base({ inQuiet: true })).action).toBe('defer');
    expect(gate(base({ inQuiet: true, candidate: { score: 0.9, priority: 'high', countsAgainstBudget: true } })).action).toBe('defer');
    expect(gate(base({ inQuiet: true, candidate: { score: 0.9, priority: 'low', countsAgainstBudget: true } }))).toEqual({ action: 'drop', reason: 'quiet_low' });
  });

  it('effectiveBudget clamps to 0..plan max; weights clamp to 0.1..1.5; jitter ≤ 10 min and deterministic', () => {
    expect(effectiveBudget(3, 5)).toBe(3);
    expect(effectiveBudget(9, 5)).toBe(5);
    expect(effectiveBudget(-1, 5)).toBe(0);
    expect(effectiveBudget(Number.NaN, 5)).toBe(3);
    expect(clampWeight(2)).toBe(1.5);
    expect(clampWeight(0)).toBe(0.1);
    expect(clampWeight(0.7000000001)).toBe(0.7);
    const j = jitterFor('n_1');
    expect(j).toBe(jitterFor('n_1'));
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(jitterFor(id)).toBeGreaterThanOrEqual(0);
      expect(jitterFor(id)).toBeLessThanOrEqual(JITTER_MAX_MS);
    }
  });
});
