// WP6b — commitments (F11, §8.3 followup_due): due jobs, dedupe on re-extraction, source shown, deletion by source.
import { afterEach, describe, expect, it } from 'vitest';
import { followupAt, parseDue, THEY_OWE_STALE_MS } from '../../../src/proactive/commitments.ts';
import { createWp6bApp, type Wp6bApp } from './wp6bHarness.ts';

const HOUR = 3_600_000;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
type Jobs = Map<string, { kind: string; runAt: number; refId: string | null; status: string; dedupeKey?: string }>;
const jobs = (t: Wp6bApp) => [...((t.s.scheduler as unknown as { jobs: Jobs }).jobs.values())];
const nudgeMd = (t: Wp6bApp) => t.tg.callsOf('sendRichMessage').map((c) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, '')).filter((m) => m.startsWith('💡'));

describe('parseDue / followupAt', () => {
  it('parses local datetimes and date-only (09:00) in the owner zone', () => {
    expect(parseDue('2026-10-14T15:00', 'UTC')).toBe(Date.UTC(2026, 9, 14, 15, 0));
    expect(parseDue('2026-10-14', 'Asia/Almaty')).toBe(Date.UTC(2026, 9, 14, 4, 0)); // 09:00 +05:00
    expect(parseDue('tomorrow', 'UTC')).toBeNull();
    expect(parseDue(null, 'UTC')).toBeNull();
  });
  it('i_owe follows up at the due time; they_owe 3 days after (or after due)', () => {
    expect(followupAt({ direction: 'i_owe', dueAt: 500, createdAt: 0 })).toBe(500);
    expect(followupAt({ direction: 'i_owe', dueAt: null, createdAt: 0 })).toBeNull();
    expect(followupAt({ direction: 'they_owe', dueAt: null, createdAt: 10 })).toBe(10 + THEY_OWE_STALE_MS);
    expect(followupAt({ direction: 'they_owe', dueAt: 10 * THEY_OWE_STALE_MS, createdAt: 10 })).toBe(10 * THEY_OWE_STALE_MS);
  });
});

describe('CommitmentService', () => {
  it('i_owe: a followup_due job at the due time → a commitment_due nudge that names the source', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const id = t.s.commitments.add({ userId: u.id, source: 'dm', direction: 'i_owe', text: 'send the deck', counterpart: 'Anna', dueLocal: '2026-09-28T15:00', sourceInputId: 'in_1' });
    expect(id).toMatch(/^cm_/);
    const job = jobs(t).find((j) => j.kind === 'followup_due')!;
    expect(job).toMatchObject({ refId: id, runAt: Date.UTC(2026, 8, 28, 15, 0), dedupeKey: `fu:${id}` });
    // re-extraction of the same input does not duplicate
    expect(t.s.commitments.add({ userId: u.id, source: 'dm', direction: 'i_owe', text: 'Send the deck', counterpart: 'Anna', sourceInputId: 'in_1' })).toBe(id);
    await t.advance(6 * HOUR);
    const md = nudgeMd(t);
    expect(md).toHaveLength(1);
    expect(md[0]).toContain('You told Anna you');
    expect(md[0]).toContain('send the deck');
    expect(md[0]).toContain('from your chat with me');
  });

  it('they_owe: stale after 3 days → low-priority they_owe_stale nudge', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.s.commitments.add({ userId: u.id, source: 'business', direction: 'they_owe', text: 'the signed contract', counterpart: 'Timur', businessConnectionId: 'bc1', chatId: 77, sourceMessageId: 5 });
    await t.advance(3 * 24 * HOUR - HOUR);
    expect(nudgeMd(t)).toHaveLength(0);
    await t.advance(2 * HOUR);
    const sends = t.tg.callsOf('sendRichMessage').filter((c) => String((c.payload.rich_message as { markdown: string }).markdown).startsWith('💡'));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.disable_notification).toBe(true);
    expect(nudgeMd(t)[0]).toContain('Timur promised the signed contract 3 days ago');
    expect(nudgeMd(t)[0]).toContain('from a business chat');
  });

  it('deleteBySourceMessages removes the rows and cancels their jobs', async () => {
    t = await createWp6bApp();
    const u = t.user();
    const a = t.s.commitments.add({ userId: u.id, source: 'business', direction: 'i_owe', text: 'call back', dueLocal: '2026-09-29T10:00', businessConnectionId: 'bc1', chatId: 77, sourceMessageId: 5 });
    t.s.commitments.add({ userId: u.id, source: 'business', direction: 'i_owe', text: 'other', dueLocal: '2026-09-29T10:00', businessConnectionId: 'bc1', chatId: 77, sourceMessageId: 6 });
    expect(t.s.commitments.deleteBySourceMessages('bc1', 77, [5, 99])).toBe(1);
    expect(jobs(t).find((j) => j.refId === a)!.status).toBe('cancelled');
    await t.advance(26 * HOUR);
    expect(nudgeMd(t)).toHaveLength(1); // only the remaining one
  });
});
