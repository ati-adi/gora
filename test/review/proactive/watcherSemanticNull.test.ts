// REVIEW (proactive) — a semantic check that keeps failing (side call returns null: schema/parse failure, 4xx, refusal)
// is retried on EVERY interval forever: never counted as a failure, never paused, owner never told.
// watchers.ts check(): `if (r === null) { repo.recordCheck(w, { at: t, next }); return; }` — recordCheck resets
// fail_count = 0 and keeps the OLD hash, so the next check sees the same "change" and calls the LLM again. The
// "5 consecutive failures → pause + notify" rule (F10) never triggers; each interval spends one Groq call indefinitely.
import { afterEach, describe, expect, it } from 'vitest';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
const URL1 = 'https://news.example.com/concert';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('semantic check keeps failing', () => {
  it('10 consecutive failed semantic evaluations: 10 LLM calls, watcher still active with failCount 0', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>Tour dates: TBA</p>');
    const { id } = await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'semantic', description: 'a date for Almaty is announced' }, intervalMin: 360 });
    t.caps.safeFetch.set(URL1, '<p>Tour dates: Almaty 12 Dec</p>');
    t.semantic.next = null; // the side call fails the same way every time
    for (let i = 0; i < 10; i++) await t.advance(6 * HOUR);
    const w = t.s.watchers.list(u.id).find((x) => x.id === id)!;
    // Expected: paused after 5 failures (and the owner notified), so at most 5 LLM calls.
    expect({ status: w.status, calls: t.semantic.calls }).toEqual({ status: 'paused', calls: 5 });
  });
});
