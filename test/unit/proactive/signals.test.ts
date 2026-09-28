// WP6b — signal scan (§8.4): per-user local slots, deterministic sources, trusted-sender inbox signal.
import { afterEach, describe, expect, it } from 'vitest';
import type { CalEvent } from '../../../src/contracts/index.ts';
import { emailOf, monthDayOf, overlaps, slotAt } from '../../../src/proactive/signals.ts';
import { createWp6bApp, type Wp6bApp } from './wp6bHarness.ts';

const HOUR = 3_600_000;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const nudgeMd = (t: Wp6bApp) => t.tg.callsOf('sendRichMessage').map((c) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, '')).filter((m) => m.startsWith('💡'));

describe('signal helpers', () => {
  it('slotAt: 09:30 / 13:30 / 18:30 local, 30-minute windows', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 8, 28, h, m);
    expect(slotAt(at(9, 30), 'UTC')).toBe('morning');
    expect(slotAt(at(9, 59), 'UTC')).toBe('morning');
    expect(slotAt(at(10, 0), 'UTC')).toBeNull();
    expect(slotAt(at(13, 45), 'UTC')).toBe('midday');
    expect(slotAt(at(13, 30), 'Asia/Almaty')).toBe('evening'); // 18:30 +05:00
  });
  it('overlaps: timed events only', () => {
    const e = (id: string, start: string, end: string): CalEvent => ({ id, title: id, start, end, tz: 'UTC', attendees: [], organizerSelf: true });
    const pairs = overlaps([e('a', '2026-09-29T10:00:00Z', '2026-09-29T11:00:00Z'), e('b', '2026-09-29T10:30:00Z', '2026-09-29T12:00:00Z'), e('c', '2026-09-29T12:00:00Z', '2026-09-29T13:00:00Z'), e('d', '2026-09-29', '2026-09-30')]);
    expect(pairs.map(([x, y]) => `${x.id}${y.id}`)).toEqual(['ab']);
  });
  it('monthDayOf / emailOf', () => {
    expect(monthDayOf("Anna's birthday is 14 October")).toEqual({ month: 10, day: 14 });
    expect(monthDayOf('Mom born 1961-03-02')).toEqual({ month: 3, day: 2 });
    expect(monthDayOf('Anniversary: Oct 3rd')).toEqual({ month: 10, day: 3 });
    expect(monthDayOf('день рождения 5 мая')).toEqual({ month: 5, day: 5 });
    expect(monthDayOf('likes tea')).toBeNull();
    expect(emailOf('Anna Lee <Anna@X.com>')).toBe('anna@x.com');
    expect(emailOf('bob@y.org')).toBe('bob@y.org');
  });
});

describe('proactive_scan', () => {
  it('is a sys cron job; scans a user only in their local slot and proposes due commitments', async () => {
    t = await createWp6bApp();
    const sched = t.s.scheduler as unknown as { jobs: Map<string, { kind: string; dedupeKey?: string; cron: string | null }> };
    expect([...sched.jobs.values()].find((j) => j.kind === 'proactive_scan')).toMatchObject({ dedupeKey: 'sys:proactive_scan', cron: '*/30 * * * *' });
    const u = t.user({ tz: 'Asia/Almaty' }); // 09:00 UTC = 14:00 local
    // due tonight; the followup job is at 20:00 local, the 18:30 scan sees it first
    t.s.commitments.add({ userId: u.id, source: 'dm', direction: 'i_owe', text: 'send the invoice', counterpart: 'Timur', dueLocal: '2026-09-28T20:00' });
    await t.advance(HOUR); // 15:00 local — no slot
    expect(nudgeMd(t)).toHaveLength(0);
    await t.advance(3.5 * HOUR); // 18:30 local
    await t.advance(0);
    expect(nudgeMd(t)).toHaveLength(1);
    expect(nudgeMd(t)[0]).toContain('You told Timur');
    // the followup job at 20:00 hits the same dedupe key → no second nudge
    await t.advance(2 * HOUR);
    expect(nudgeMd(t)).toHaveLength(1);
  });

  it('inbox_important only for trusted senders, older than 24 h, with inbox_checkins on', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.s.repos.users.updateSettings(u.id, { inboxCheckins: true });
    t.gmail.connected = true;
    t.gmail.level = 'read';
    const old = t.clock.now() - 30 * HOUR;
    t.gmail.threads = [
      { threadId: 'th1', from: 'Boss <boss@corp.com>', subject: 'Q3 numbers', snippet: '', date: old, unread: true },
      { threadId: 'th2', from: 'Spam <promo@shop.com>', subject: 'SALE', snippet: '', date: old, unread: true },
      { threadId: 'th3', from: 'Boss <boss@corp.com>', subject: 'fresh', snippet: '', date: t.clock.now() - HOUR, unread: true },
    ];
    t.s.trustedTargets.add(u.id, { kind: 'email', value: 'boss@corp.com', source: 'miniapp' });
    await t.advance(30 * 60_000); // 09:30 UTC
    await t.advance(0);
    const md = nudgeMd(t);
    expect(md).toHaveLength(1);
    expect(md[0]).toContain('Unanswered email from Boss');
    expect(md[0]).toContain('Q3 numbers');
    // turned off → nothing next day
    t.s.repos.users.updateSettings(u.id, { inboxCheckins: false });
    const searches = t.gmail.searches;
    await t.advance(24 * HOUR);
    expect(t.gmail.searches).toBe(searches);
  });
});
