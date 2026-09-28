// REVIEW (proactive) — watcher hits the owner explicitly asked for are silently dropped after 4 unanswered hits.
// watchers.ts onHit proposes { kind: 'watcher_hit', score: 1, countsAgainstBudget: false } through the normal NudgeGate.
// Each hit nobody taps within 12 h is 'ignored' (weight −0.1, streak +1; the hit is informational — people read it and
// do not press a button). Gate step 4: after 3 ignores the bar is 0.7 and weight is 0.7 → the 4th still passes;
// after the 4th, weight 0.6 → score×weight 0.6 < 0.7 → every later hit of EVERY watcher is dropped ('score'), with no
// notice. F10: "A hit wakes the mission or sends a nudge that does not count against the budget, because I asked for it."
import { afterEach, describe, expect, it } from 'vitest';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
const URL1 = 'https://news.example.com/fares';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('watcher_hit backoff', () => {
  it('the 5th daily hit of a watcher is dropped because the owner did not tap buttons on the first four', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 0, 0) });
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>fare v0</p>');
    const { id } = await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'changed' }, intervalMin: 360 });
    for (let day = 1; day <= 5; day++) {
      t.caps.safeFetch.set(URL1, `<p>fare v${day}</p>`); // the page changes once a day
      for (let h = 0; h < 24; h++) await t.advance(HOUR);
    }
    const hits = t.tg.callsOf('sendRichMessage')
      .map((c) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, ''))
      .filter((m) => m.startsWith('💡') && m.includes(`Watcher ${id}`));
    expect(hits).toHaveLength(5); // actual: 4
  });
});
