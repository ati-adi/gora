// REVIEW (proactive) — a nudge the owner explicitly snoozed is silently dropped when it comes back.
// nudges.ts outcome('snooze') re-inserts the nudge as a new 'deferred' row with countsAgainstBudget copied from the
// original; jobDeferred re-runs the full gate, so at +3 h it is budget-checked AGAIN (step 5). If the day's budget was
// used meanwhile (the snoozed nudge itself already consumed one slot) it is dropped with no trace: the owner tapped
// "Snooze" (01 §8.4 "Snooze sets +3 h") and never hears of it again. Same for a kind muted/backoff in between.
import { afterEach, describe, expect, it } from 'vitest';
import { createWp6bApp, tapButton, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const nudges = (t: Wp6bApp) =>
  t.tg.callsOf('sendRichMessage')
    .map((c) => ({ md: String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, ''), payload: c.payload }))
    .filter((m) => m.md.startsWith('💡'));

describe('snooze', () => {
  it('the snoozed nudge never returns when the budget filled up in the 3 h window', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 10, 0) });
    const u = t.user();
    const c = (k: string, body: string) => ({ userId: u.id, kind: 'commitment_due' as const, dedupeKey: k, why: 'w', body, score: 0.9, priority: 'normal' as const, countsAgainstBudget: true });
    expect(await t.s.nudges.propose(c('a', 'Send the deck to Anna'))).toBe('sent');
    await t.settle();
    const a = nudges(t)[0]!;
    const sz = (a.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0]!.find((b) => b.text === 'nudge_snooze_button')!;
    await tapButton(t, sz.callback_data); // "remind me in 3 h"
    await t.advance(HOUR);
    await t.s.nudges.propose(c('b', 'Other 1'));
    await t.s.nudges.propose(c('c', 'Other 2')); // budget 3 now used: A, B, C
    await t.advance(2 * HOUR + 11 * 60_000);
    await t.advance(0);
    expect(nudges(t).filter((n) => n.md.includes('Send the deck to Anna'))).toHaveLength(2); // actual: 1 (dropped)
  });
});
