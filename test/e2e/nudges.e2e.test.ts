// WP6b — 01 §15.2 nudges.e2e: budget of 3; quiet-hours deferral; dedupe; "never this kind"; backoff after ignoring;
// spec 05 A5: no "Why now:" label (the details stay as a plain line); disable_notification for low priority. Fakes pinned in wp6bHarness (strings echo keys).
import { afterEach, describe, expect, it } from 'vitest';
import type { NudgeCandidate, UserRow } from '../../src/contracts/index.ts';
import { createWp6bApp, tapButton, type Wp6bApp } from '../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const cand = (u: UserRow, over: Partial<NudgeCandidate> = {}): NudgeCandidate => ({
  userId: u.id, kind: 'commitment_due', dedupeKey: `k:${Math.random()}`, why: 'You told Anna you would send the deck by 15:00.', body: 'Send the deck to Anna',
  score: 0.8, priority: 'normal', countsAgainstBudget: true, ...over,
});
const nudgeSends = (t: Wp6bApp) => t.tg.callsOf('sendRichMessage').filter((c) => String((c.payload.rich_message as { markdown?: string })?.markdown ?? '').startsWith('💡'));
const md = (c: { payload: Record<string, unknown> }) => String((c.payload.rich_message as { markdown: string }).markdown);

describe('nudges (e2e)', () => {
  it('sends into ☀️ Today with the details line but no "Why now:" label, three buttons and no silent flag for normal priority', async () => {
    t = await createWp6bApp();
    const u = t.user();
    expect(await t.s.nudges.propose(cand(u))).toBe('sent');
    await t.settle();
    const [send] = nudgeSends(t);
    expect(send).toBeDefined();
    expect(md(send!)).toContain('💡 Send the deck to Anna');
    expect(md(send!).replace(/\\/g, '')).toContain('_You told Anna you would send the deck by 15:00._');
    expect(md(send!)).not.toContain('why_now');
    expect(send!.payload.message_thread_id).toBe(t.topics.fixed.find((f) => f.kind === 'today')!.threadId);
    expect(send!.payload.disable_notification).toBeUndefined();
    const kb = (send!.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(kb[0]!.map((b) => b.text)).toEqual(['nudge_do_button', 'nudge_snooze_button', 'nudge_never_button']);
    expect(kb[0]!.map((b) => b.callback_data.split('|')[0]!.split(':').pop())).toEqual(['do', 'sz', 'nv']);
    // the ledger records it without content
    const led = (t.s.ledger as unknown as { entries: Array<{ kind: string; summary: string }> }).entries.filter((e) => e.kind === 'nudge_sent');
    expect(led).toHaveLength(1);
    expect(led[0]!.summary).not.toContain('deck');
    // /why "nudge reason"
    const id = kb[0]![0]!.callback_data.split('|')[0]!.split(':')[1]!;
    expect(t.s.nudges.get(id)?.why).toContain('Anna');
  });

  it('low priority → disable_notification', async () => {
    t = await createWp6bApp();
    const u = t.user();
    await t.s.nudges.propose(cand(u, { priority: 'low' }));
    await t.settle();
    expect(nudgeSends(t)[0]!.payload.disable_notification).toBe(true);
  });

  it('budget of 3 per local day; budget-exempt nudges still go out; the next day resets', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await t.s.nudges.propose(cand(u)));
    expect(r).toEqual(['sent', 'sent', 'sent', 'dropped']);
    expect(t.s.nudges.remainingToday(u.id)).toBe(0);
    expect(await t.s.nudges.propose(cand(u, { kind: 'watcher_hit', countsAgainstBudget: false }))).toBe('sent');
    await t.settle();
    expect(nudgeSends(t)).toHaveLength(4);
    await t.advance(24 * HOUR);
    expect(t.s.nudges.remainingToday(u.id)).toBe(3);
    // (the three commitment_due nudges were ignored meanwhile → that kind is backed off; use another kind)
    // spec 05 C4: four unanswered Gora-first messages → the hard stop holds unrequested kinds until the owner writes
    expect(await t.s.nudges.propose(cand(u, { kind: 'date_from_memory', dedupeKey: 'date:hs' }))).toBe('dropped');
    t.s.signals.inbound(u.id, { at: t.clock.now(), text: 'hey' });
    expect(await t.s.nudges.propose(cand(u, { kind: 'date_from_memory' }))).toBe('sent');
  });

  it('quiet hours: normal is deferred to nextOutsideQuiet + ≤10 min jitter and then sent; low is dropped', async () => {
    t = await createWp6bApp();
    const u = t.user({ tz: 'Asia/Almaty' }); // 09:00 UTC = 14:00 Almaty
    await t.advance(9 * HOUR); // 23:00 Almaty — inside 22:00–08:00
    expect(await t.s.nudges.propose(cand(u, { priority: 'low' }))).toBe('dropped');
    expect(await t.s.nudges.propose(cand(u, { dedupeKey: 'defer-me' }))).toBe('deferred');
    await t.settle();
    expect(nudgeSends(t)).toHaveLength(0);
    await t.advance(8 * HOUR); // 07:00 Almaty — still quiet
    expect(nudgeSends(t)).toHaveLength(0);
    await t.advance(HOUR + 11 * 60_000); // 08:11 — past 08:00 + max jitter
    await t.advance(0);
    const sends = nudgeSends(t);
    expect(sends).toHaveLength(1);
    expect(md(sends[0]!)).toContain('Send the deck');
  });

  it('dedupe: the same dedupe_key within 7 days is dropped, after 7 days it may go again', async () => {
    t = await createWp6bApp();
    const u = t.user();
    expect(await t.s.nudges.propose(cand(u, { dedupeKey: 'cm:1:due' }))).toBe('sent');
    expect(await t.s.nudges.propose(cand(u, { dedupeKey: 'cm:1:due' }))).toBe('dropped');
    await t.advance(6 * 24 * HOUR);
    expect(await t.s.nudges.propose(cand(u, { dedupeKey: 'cm:1:due' }))).toBe('dropped');
    await t.advance(24 * HOUR + 60_000);
    expect(await t.s.nudges.propose(cand(u, { dedupeKey: 'cm:1:due' }))).toBe('sent');
  });

  it('"Never this kind" mutes the kind; other kinds still go out', async () => {
    t = await createWp6bApp();
    const u = t.user();
    await t.s.nudges.propose(cand(u));
    await t.settle();
    const kb = (nudgeSends(t)[0]!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard;
    await tapButton(t, kb[0]![2]!.callback_data);
    expect(t.s.nudges.prefs(u.id).find((p) => p.kind === 'commitment_due')!.muted).toBe(true);
    expect(await t.s.nudges.propose(cand(u))).toBe('dropped');
    expect(await t.s.nudges.propose(cand(u, { kind: 'calendar_conflict' }))).toBe('sent');
    // the buttons are removed from the tapped nudge
    expect(t.tg.callsOf('editMessageReplyMarkup').length).toBeGreaterThanOrEqual(1);
  });

  it('backoff: 3 ignored nudges (12 h each) raise the threshold to 0.7; "Do it" resets the streak and starts nudge_do', async () => {
    t = await createWp6bApp();
    const u = t.user();
    for (let i = 0; i < 3; i++) {
      expect(await t.s.nudges.propose(cand(u, { score: 0.8 }))).toBe('sent');
      await t.advance(12 * HOUR + 60_000); // nudge_ignore fires
    }
    await t.advance(24 * HOUR); // a fresh budget day
    // weight 1.0 − 3×0.1 = 0.7; 0.8 × 0.7 = 0.56 < 0.7 (streak ≥ 3)
    expect(await t.s.nudges.propose(cand(u, { score: 0.8 }))).toBe('dropped');
    expect(await t.s.nudges.propose(cand(u, { score: 1 }))).toBe('sent'); // 1 × 0.7 = 0.7 ≥ 0.7
    await t.settle();
    const last = nudgeSends(t).at(-1)!;
    const kb = (last.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard;
    await tapButton(t, kb[0]![0]!.callback_data); // Do it
    const ev = t.runner.events.find((e) => e.type === 'nudge_do');
    expect(ev).toBeDefined();
    expect(ev!.priority).toBe('interactive');
    // streak reset → the 0.4 threshold applies again: 0.8 × 0.8 = 0.64 ≥ 0.4
    expect(await t.s.nudges.propose(cand(u, { score: 0.8 }))).toBe('sent');
    // a second tap on the same nudge is "Already handled"
    expect(await tapButton(t, kb[0]![0]!.callback_data)).toEqual({ text: expect.stringMatching(/Already handled/) });
  });

  it('snooze re-delivers the same nudge 3 h later; a stranger cannot tap it', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.user({ id: 2002 });
    await t.s.nudges.propose(cand(u));
    await t.settle();
    const kb = (nudgeSends(t)[0]!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard;
    await expect(tapButton(t, kb[0]![1]!.callback_data, 2002)).rejects.toThrow(/not_owner/);
    await tapButton(t, kb[0]![1]!.callback_data);
    await t.advance(2 * HOUR);
    expect(nudgeSends(t)).toHaveLength(1);
    await t.advance(HOUR + 11 * 60_000);
    await t.advance(0);
    expect(nudgeSends(t)).toHaveLength(2);
  });
});
