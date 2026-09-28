// Review (reminders): time math defects.
//  (a) service.ts:69-71 MIN_CRON_INTERVAL_MS is checked only between the FIRST two occurrences after "now": a burst
//      pattern created during its own last minute passes, then fires every minute of the burst every day.
//  (b) service.ts:51-55 resolveAtLocal always takes the EARLIER instant in a DST overlap and then rejects it as past, even
//      when the later instant of the same wall time is still in the future (Europe/Kyiv, fall-back night).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createReminderModule } from '../../../src/reminders/index.ts';
import { resolveAtLocal, resolveCron, type ReminderServiceImpl } from '../../../src/reminders/service.ts';
import type { TodoServiceImpl } from '../../../src/reminders/todos.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

const MIN = 60_000;
let env: TestEnv;
let sch: Scheduler;
let mod: { reminders: ReminderServiceImpl; todos: TodoServiceImpl };

beforeEach(() => {
  env = makeEnv(); // 2026-09-28T09:00Z = 14:00 Asia/Almaty
  sch = createScheduler(env.s, { random: () => 0.5 });
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  mod = createReminderModule(env.s) as typeof mod;
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

describe('cron minimum interval', () => {
  it('rejects "* 14 * * *" as spam at any time of day', () => {
    // sanity: created at 14:00 it is rejected (first two occurrences 1 min apart)
    expect(() => resolveCron('* 14 * * *', 'Asia/Almaty', env.clock.now())).toThrow(/15 minutes/);
    // created at 14:58:30 local the first two occurrences are 14:59 today and 14:00 tomorrow → accepted
    const at1458 = Date.UTC(2026, 8, 28, 9, 58, 30);
    // regression (F4): was accepted — a 60-messages-per-day reminder
    expect(() => resolveCron('* 14 * * *', 'Asia/Almaty', at1458)).toThrow(/15 minutes/);
  });

  it('end to end: the burst reminder is rejected and never fires (was: accepted, 60 firings the next day)', async () => {
    const u = env.user({ tz: 'Asia/Almaty' });
    await env.clock.advance(58 * MIN + 30_000); // 14:58:30 local
    let created = true;
    try {
      mod.reminders.create({ scope: { kind: 'user', userId: u.id }, userId: u.id, kind: 'reminder', text: 'spam', cron: '* 14 * * *', tz: 'Asia/Almaty', chatId: u.dmChatId! });
    } catch {
      created = false;
    }
    // walk to tomorrow 15:00 minute by minute
    for (let i = 0; i < 24 * 60 + 2; i++) {
      await env.clock.advance(MIN);
      await sch.tick();
    }
    const sent = env.outbox.queued.filter((r) => r.refKind === 'reminder').length;
    // regression (F4): creation is refused; before the fix it was accepted and sent 61 reminder messages
    expect(created).toBe(false);
    expect(sent).toBe(0);
  });
});

describe('DST overlap and the past-time check', () => {
  it('Europe/Kyiv fall-back: 03:50 is 10 minutes ahead during the second 03:xx hour but is rejected as past', () => {
    // 2026-10-25: 04:00 EEST → 03:00 EET at 01:00Z. At 01:40Z the wall clock reads 03:40 (second pass, EET).
    const now = Date.UTC(2026, 9, 25, 1, 40);
    // regression (F5): threw ReminderError('past') although 03:50 EET (01:50Z) is in the future
    const r = resolveAtLocal('2026-10-25T03:50', 'Europe/Kyiv', now);
    expect(r.instant).toBe(Date.UTC(2026, 9, 25, 1, 50));
  });
});
