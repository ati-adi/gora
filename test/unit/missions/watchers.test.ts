// WP6b — watchers (F10): hash first, semantic LLM only on change and within the LLM budget, failure pause + notice,
// inbox watchers via MailApi, budget-exempt watcher_hit nudges, creation rules (URL, interval, quota).
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow, WatchCondition } from '../../../src/contracts/index.ts';
import { createWp6bApp, tapButton, type Wp6bApp } from '../proactive/wp6bHarness.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const URL1 = 'https://news.example.com/concert';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const create = (t: Wp6bApp, u: UserRow, condition: WatchCondition, o: { kind?: 'page' | 'inbox'; target?: string; intervalMin?: number } = {}) =>
  t.s.watchers.create({ userId: u.id, kind: o.kind ?? 'page', target: o.target ?? URL1, condition, intervalMin: o.intervalMin ?? 360 });
const sends = (t: Wp6bApp) => t.tg.callsOf('sendRichMessage').map((c) => ({ md: String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, ''), payload: c.payload }));

describe('page watchers', () => {
  it('semantic: no LLM on the baseline or an unchanged hash; one call on change; budget-paused → retried next check', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>Tour dates: TBA</p>');
    const { id } = await create(t, u, { type: 'semantic', description: 'a date for Almaty is announced' });
    expect(t.semantic.calls).toBe(0);
    await t.advance(6 * HOUR);
    expect(t.semantic.calls).toBe(0); // same hash
    t.caps.safeFetch.set(URL1, '<p>Tour dates: Almaty 12 Dec</p>');
    (t.s.llmBudget as unknown as { blocked: Set<string> }).blocked.add('background');
    await t.advance(6 * HOUR);
    expect(t.semantic.calls).toBe(0); // paused budget: no call, hash kept
    (t.s.llmBudget as unknown as { blocked: Set<string> }).blocked.clear();
    t.semantic.next = { met: true, summary: 'Almaty on 12 Dec announced' };
    await t.advance(6 * HOUR);
    expect(t.semantic.calls).toBe(1);
    // no mission → a budget-exempt watcher_hit nudge; it is 03:00 UTC (quiet hours) → deferred to 08:00 + jitter
    expect(sends(t).filter((s) => s.md.startsWith('💡'))).toHaveLength(0);
    await t.advance(5 * HOUR + 11 * MIN);
    await t.advance(0);
    const hit = sends(t).find((s) => s.md.startsWith('💡'))!;
    expect(hit.md).toContain(`Watcher ${id} — Almaty on 12 Dec announced.`);
    await t.advance(6 * HOUR);
    expect(t.semantic.calls).toBe(1);
  });

  it('a hit nudge is sent even when the daily nudge budget is used up', async () => {
    t = await createWp6bApp();
    const u = t.user();
    for (let i = 0; i < 3; i++) await t.s.nudges.propose({ userId: u.id, kind: 'commitment_due', dedupeKey: `x${i}`, why: 'w', body: 'b', score: 1, priority: 'normal', countsAgainstBudget: true });
    expect(t.s.nudges.remainingToday(u.id)).toBe(0);
    t.caps.safeFetch.set(URL1, '<p>Sold out</p>');
    await create(t, u, { type: 'contains', text: 'Tickets available' });
    t.caps.safeFetch.set(URL1, '<p>Tickets available now</p>');
    await t.advance(6 * HOUR);
    expect(sends(t).filter((s) => s.md.startsWith('💡'))).toHaveLength(4);
  });

  it('5 consecutive failures pause the watcher and notify the owner; [Resume] resumes it', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.caps.safeFetch.set(URL1, 'x', { status: 503 });
    const { id } = await create(t, u, { type: 'changed' });
    for (let i = 0; i < 4; i++) await t.advance(6 * HOUR);
    const w = t.s.watchers.list(u.id)[0]!;
    expect(w).toMatchObject({ id, status: 'paused', failCount: 5 });
    const notice = sends(t).find((s) => s.md.includes('paused after 5 failed checks'))!;
    const kb = (notice.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0]!;
    expect(kb.map((b) => b.text)).toEqual(['▶️ Resume', '✖ Cancel']);
    const fetches = t.caps.safeFetch.calls.length;
    await t.advance(12 * HOUR);
    expect(t.caps.safeFetch.calls.length).toBe(fetches); // paused: no checks
    t.caps.safeFetch.set(URL1, '<p>ok</p>');
    expect(await tapButton(t, kb[0]!.callback_data)).toEqual({ text: 'Watcher resumed.' });
    await t.advance(MIN);
    expect(t.s.watchers.list(u.id)[0]).toMatchObject({ status: 'active', failCount: 0 });
    expect(t.caps.safeFetch.calls.length).toBe(fetches + 1);
  });

  it('creation rules: SafeFetch URL rules, plan minimum interval, watcher quota; manage is owner-only', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const other = t.user({ id: 2002 });
    t.quotas.limits.watcher = 2;
    await expect(create(t, u, { type: 'changed' }, { target: 'http://169.254.169.254/latest' })).rejects.toThrow(/private/);
    await expect(create(t, u, { type: 'changed' }, { intervalMin: 30 })).rejects.toThrow(/minimum interval/);
    t.caps.safeFetch.set(URL1, 'a');
    const a = await create(t, u, { type: 'changed' });
    await create(t, u, { type: 'changed' });
    await expect(create(t, u, { type: 'changed' })).rejects.toThrow(/limit/);
    expect(() => t!.s.watchers.manage(a.id, other.id, 'cancel')).toThrow(/not found/);
    t.s.watchers.manage(a.id, u.id, 'cancel');
    expect(t.s.quotas.check(u.id, 'watcher').used).toBe(1);
    expect(t.s.watchers.list(u.id).find((w) => w.id === a.id)!.status).toBe('cancelled');
  });
});

describe('inbox watchers', () => {
  it('need Gmail read access; `changed` fires on new threads only', async () => {
    t = await createWp6bApp();
    const u = t.user();
    await expect(create(t, u, { type: 'changed' }, { kind: 'inbox', target: 'from:airline.com' })).rejects.toThrow(/Gmail/);
    t.gmail.connected = true;
    t.gmail.level = 'read';
    t.gmail.threads = [{ threadId: 't1', from: 'Air <a@airline.com>', subject: 'Booking', snippet: '', date: 1, unread: true }];
    await create(t, u, { type: 'changed' }, { kind: 'inbox', target: 'from:airline.com' });
    t.gmail.threads = [{ ...t.gmail.threads[0]!, unread: false }];
    await t.advance(6 * HOUR);
    expect(sends(t).filter((s) => s.md.startsWith('💡'))).toHaveLength(0);
    t.gmail.threads = [...t.gmail.threads, { threadId: 't2', from: 'Air <a@airline.com>', subject: 'Check-in open', snippet: '', date: 2, unread: true }];
    await t.advance(6 * HOUR);
    const hit = sends(t).filter((s) => s.md.startsWith('💡'));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.md).toContain('1 new matching email');
  });
});
