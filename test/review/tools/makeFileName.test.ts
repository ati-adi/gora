// REVIEW (tools): make_file's safeFilename (tools/impl/makeFile.ts:26-30) strips C0 controls but keeps Unicode bidi
// overrides / invisible format characters (U+202E RLO, U+2066-2069, U+200B-200F). A model steered by injected content can
// name the sendDocument file "invoice<RLO>gpj.csv", which Telegram clients render as "invoicevsc.jpg" (extension
// spoofing). Dot-only names also survive ("..") -> "...csv".
import { describe, expect, it } from 'vitest';
import { safeFilename } from '../../../src/tools/impl/makeFile.ts';

describe('make_file filename sanitization', () => {
  it('removes bidi/format control characters', () => {
    const name = safeFilename('invoice‮gpj.exe', 'csv');
    expect(name).not.toMatch(/[​-‏‪-‮⁦-⁩]/);
  });
  it('never produces a dot-only stem', () => {
    expect(safeFilename('..', 'csv')).not.toBe('...csv');
  });
});
