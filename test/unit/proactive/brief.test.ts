// WP6b — morning brief (§8.5): opt-in cron in the owner's zone, deterministic data, one notify event run, skips.
import { afterEach, describe, expect, it } from 'vitest';
import { briefCron } from '../../../src/proactive/brief.ts';
import { createWp6bApp, type Wp6bApp } from './wp6bHarness.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
type Jobs = Map<string, { kind: string; runAt: number; cron: string | null; tz: string | null; status: string; dedupeKey?: string }>;
const briefJob = (t: Wp6bApp) => [...(t.s.scheduler as unknown as { jobs: Jobs }).jobs.values()].find((j) => j.kind === 'brief');
const briefs = (t: Wp6bApp) => t.runner.events.filter((e) => e.type === 'brief');

describe('BriefService', () => {
  it('setDaily schedules `M H * * *` in the owner zone (dedupe brief:<user>) and null cancels it', async () => {
    t = await createWp6bApp();
    const u = t.user({ tz: 'Asia/Almaty' });
    expect(briefCron('07:05')).toBe('5 7 * * *');
    t.s.brief.setDaily(u.id, '07:30');
    expect(t.s.repos.users.settings(u.id).briefTime).toBe('07:30');
    expect(briefJob(t)).toMatchObject({ cron: '30 7 * * *', tz: 'Asia/Almaty', dedupeKey: `brief:${u.id}`, runAt: Date.UTC(2026, 8, 29, 2, 30), status: 'scheduled' });
    t.s.brief.setDaily(u.id, null);
    expect(briefJob(t)!.status).toBe('cancelled');
    expect(() => t!.s.brief.setDaily(u.id, '25:00')).toThrow();
  });

  it('fires once a day: one notify event run with weather (home city, 0.1° rounding), priority proactive', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.s.repos.users.updateSettings(u.id, { homeCity: { name: 'Almaty', lat: 43.2567, lon: 76.9286 } });
    t.s.brief.setDaily(u.id, '09:30');
    await t.advance(30 * MIN);
    expect(briefs(t)).toHaveLength(1);
    const ev = briefs(t)[0]!;
    expect(ev.channel).toBe('notify');
    expect(ev.priority).toBe('proactive');
    expect(ev.body).toContain('weather (Almaty): now 17°C');
    expect(ev.body).toContain('<details>');
    expect(t.caps.weather.calls).toEqual([{ lat: 43.3, lon: 76.9, days: 1 }]);
    expect((ev.replyRef as { threadId?: number }).threadId).toBe(t.topics.fixed.find((f) => f.kind === 'today')!.threadId);
    // the next day it fires again, not twice on the same day
    await t.advance(HOUR);
    expect(briefs(t)).toHaveLength(1);
    await t.advance(23 * HOUR);
    expect(briefs(t)).toHaveLength(2);
    expect(briefJob(t)!.runAt).toBe(Date.UTC(2026, 8, 30, 9, 30));
  });

  it('a brief more than 2 h late is skipped; a paused budget skips it too', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.s.brief.setDaily(u.id, '09:30');
    await t.advance(3 * HOUR); // one tick at 12:00: 2.5 h late
    expect(briefs(t)).toHaveLength(0);
    expect(briefJob(t)!.runAt).toBe(Date.UTC(2026, 8, 29, 9, 30));
    (t.s.llmBudget as unknown as { blocked: Set<string> }).blocked.add('proactive');
    await t.advance(21 * HOUR + 30 * MIN);
    expect(briefs(t)).toHaveLength(0);
  });

  it('preview posts to the main DM right away (interactive) and does not touch the budget', async () => {
    t = await createWp6bApp();
    const u = t.user();
    await t.s.brief.run(u.id, { preview: true });
    const ev = briefs(t)[0]!;
    expect(ev.priority).toBe('interactive');
    expect(ev.replyRef).toEqual({ chatId: u.tgUserId });
    expect(ev.body).toContain('PREVIEW');
    expect(ev.body).toContain('weather: no location or home city known');
    expect(t.s.nudges.remainingToday(u.id)).toBe(3);
  });
});
