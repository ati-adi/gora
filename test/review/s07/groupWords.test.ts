// s07 red team — GROUPS: "тише" can be turned into "louder" (spec 07 C4: "тише" raises the threshold).
// groups/names.ts chattinessFromWords tests LOUDER before QUIETER and neither pattern knows negation, so a short request
// to chime in LESS that contains a louder phrase ("встревай чаще", "more often", "talk more") steps chattiness UP.
// The surface (surfaces/group.ts) applies the result immediately with setChattiness(…, {reason:'words'}) and answers
// with the "louder" acknowledgement.
import { describe, expect, it } from 'vitest';
import { chattinessFromWords } from '../../../src/groups/names.ts';

describe('s07 red team: negated chattiness words', () => {
  it.each([
    'Гора, не встревай чаще раза в день',
    'Гора, не пиши чаще',
    "Gora, you don't need to chime in more often",
    "Gora, don't talk more than needed",
  ])('%s → never "louder"', (text) => {
    expect(chattinessFromWords(text)).not.toBe('louder');
  });

  it('control: the plain forms work', () => {
    expect(chattinessFromWords('Гора, тише')).toBe('quieter');
    expect(chattinessFromWords('Гора, можешь чаще')).toBe('louder');
  });
});
