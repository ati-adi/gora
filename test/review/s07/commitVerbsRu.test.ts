// Review s07 (skeptic, BR, spec 07 A4 "… or the RU equivalents"). The commit-verb list (src/browser/detect.ts COMMIT_RE)
// has no «записаться / запись» — the Russian verb for booking an appointment (barber, clinic, class: exactly what the
// browse preload words «запиши меня» start). A scripted (non-<form>) «Записаться» button is therefore classified
// read_public and clicked WITHOUT an approval card. Same for EN "Complete registration" (\bregister\b misses
// "registration"). A form submit button is still caught by FieldInfo.submit; JS buttons (most booking widgets) are not.
import { describe, expect, it } from 'vitest';
import type { RawPageState } from '../../../src/contracts/index.ts';
import { classifyBrowserTool } from '../../../src/browser/classify.ts';
import { buildSnapshot } from '../../../src/browser/snapshot.ts';

function pageWithButton(name: string): RawPageState {
  return {
    url: 'https://barber.example/book', title: 'Book', viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
    nodes: [{ role: 'main', children: [{ role: 'heading', name: 'Стрижка, пт 18:00', level: 1 }, { role: 'button', name, ref: 'e1', box: { x: 10, y: 100, width: 120, height: 30 } }] }],
    fields: { e1: { tag: 'button', type: 'button', formId: null, submit: false } },
    frameHosts: [], at: 0,
  };
}

describe('s07 BR review: commit verbs', () => {
  for (const name of ['Записаться', 'Записаться на приём', 'Complete registration']) {
    it(`a click on «${name}» asks (send_external), never read_public`, () => {
      const snap = buildSnapshot(pageWithButton(name), { maxTokens: 1_800 });
      const cls = classifyBrowserTool('browser_click', { ref: 'e1' }, { snap, focus: null, ownerText: '' });
      // FAILS today: read_public → clicked without an approval card
      expect(cls.actionClass).toBe('send_external');
    });
  }
  it('control: «Забронировать» already asks', () => {
    const snap = buildSnapshot(pageWithButton('Забронировать'), { maxTokens: 1_800 });
    expect(classifyBrowserTool('browser_click', { ref: 'e1' }, { snap, focus: null, ownerText: '' }).actionClass).toBe('send_external');
  });
});
