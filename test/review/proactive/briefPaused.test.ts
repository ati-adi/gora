// REVIEW (proactive) — /pause turns the daily brief into a daily "⚠️ I couldn't complete a scheduled brief" DM.
// brief.ts job(): a paused (or bot-blocked) owner returns { status: 'dead', error: 'user not active' }. In the real
// scheduler a 'dead' result is treated as a permanent failure: scheduler.ts apply() → notifyDead(job) — 'brief' is in
// USER_FACING and notifyDead only skips users in status 'deleting' — so a paused owner is messaged every morning
// ("I couldn't complete a scheduled brief after several tries. Check /tasks.") plus a ledger failure entry, while the
// cron series continues. /pause is supposed to silence proactive output (NudgeGate step 1 drops for paused users).
import { afterEach, describe, expect, it } from 'vitest';
import type { Scheduler, Services } from '../../../src/contracts/index.ts';
import { createBrief } from '../../../src/proactive/brief.ts';
import { createNudges } from '../../../src/proactive/nudges.ts';
import { createProactiveRepo } from '../../../src/proactive/repo.ts';
import { createSignals } from '../../../src/proactive/signals.ts';
import { createSchedulerImpl } from '../../../src/scheduler/scheduler.ts';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('brief while paused', () => {
  it('a paused owner gets a job-failure DM instead of silence', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 12, 0) });
    const s2 = Object.create(t.s) as Services & { scheduler: Scheduler };
    const real = createSchedulerImpl(s2, { random: () => 0.5 });
    s2.scheduler = real;
    const repo = createProactiveRepo(() => t!.s.db, () => t!.s.crypto);
    const nudges = createNudges(s2, repo);
    const brief = createBrief(s2, repo, createSignals(s2, repo), nudges);
    real.register('brief', (job, ctx) => brief.job(job, ctx.now));

    const u = t.user();
    brief.service.setDaily(u.id, '08:00');
    t.s.repos.users.update(u.id, { status: 'paused' }); // /pause
    await t.clock.advance(21 * HOUR); // next day 09:00 UTC, past the 08:00 brief
    await real.tick();
    await t.settle();

    const texts = t.tg.callsOf('sendRichMessage').map((c) => JSON.stringify(c.payload));
    expect(texts.filter((x) => x.includes("couldn't complete a scheduled brief"))).toHaveLength(0);
  });
});
