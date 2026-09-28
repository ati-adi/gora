// REVIEW (proactive) — a transient LLM error in a semantic watcher check kills the watcher silently and permanently.
// watchers.ts check(): `await s.side.semanticCheck(...)` is not guarded; side.ts semanticCheck RE-THROWS
// TransientLlmError / AbortedError (429 rate_limit is routine on the Groq free tier). The watcher_check job (maxAttempts 3)
// therefore throws → scheduler.ts runOne → 'retry' at 30 s / 60 s → after the 3rd throw the job is 'dead'
// (scheduler.ts apply: exhausted = attempts >= maxAttempts). The watcher row stays status 'active' with no job, so it is
// never checked again, it is not 'paused' (no Resume notice per F10 "after 5 consecutive failures the watcher pauses and
// I am notified"), and watcher_manage/[Resume] is a no-op because resume only acts on status 'paused'.
import { afterEach, describe, expect, it } from 'vitest';
import type { Scheduler, Services } from '../../../src/contracts/index.ts';
import { TransientLlmError } from '../../../src/kernel/errors.ts';
import { createMissionRepo } from '../../../src/missions/repo.ts';
import { createWatcherCore } from '../../../src/missions/watchers.ts';
import { createSchedulerImpl } from '../../../src/scheduler/scheduler.ts';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const URL1 = 'https://news.example.com/concert';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('semantic watcher + transient LLM error', () => {
  it('three 429s in a row dead-letter the watcher_check job; the watcher stays "active" and is never checked again', async () => {
    t = await createWp6bApp();
    const u = t.user();
    // The production watcher core wired to the REAL scheduler (the harness pins a fake one that has no retry/dead logic).
    const s2 = Object.create(t.s) as Services & { scheduler: Scheduler };
    const real = createSchedulerImpl(s2, { random: () => 0.5 });
    s2.scheduler = real;
    let llmDown = false;
    const side = t.s.side;
    (s2 as { side: Services['side'] }).side = {
      ...side,
      semanticCheck: async (...a: Parameters<Services['side']['semanticCheck']>) => {
        if (llmDown) throw new TransientLlmError('rate_limit');
        return side.semanticCheck(...a);
      },
    };
    const core = createWatcherCore(s2, createMissionRepo(() => t!.s.db, () => t!.s.crypto));
    real.register('watcher_check', (job) => core.job(job));

    t.caps.safeFetch.set(URL1, '<p>Tour dates: TBA</p>');
    await core.internals.createWatcherWithId('WREVW01', { userId: u.id, kind: 'page', target: URL1, condition: { type: 'semantic', description: 'a date for Almaty is announced' }, intervalMin: 360 });
    t.caps.safeFetch.set(URL1, '<p>Tour dates: Almaty 12 Dec</p>');

    llmDown = true; // Groq 429 for a few minutes
    await t.clock.advance(6 * HOUR + MIN);
    await real.tick();
    for (let i = 0; i < 3; i++) {
      await t.clock.advance(10 * MIN);
      await real.tick();
    }
    llmDown = false; // the LLM is back
    const job = t.s.db.prepare(`SELECT status, attempts FROM jobs WHERE dedupe_key = ?`).get<{ status: string; attempts: number }>('wch:WREVW01');
    // Fixed: a transient LLM error is not a job failure — the job stays scheduled (was: dead after 3 attempts).
    expect(job).toMatchObject({ status: 'scheduled', attempts: 0 });

    const fetches = t.caps.safeFetch.calls.length;
    await t.clock.advance(7 * HOUR);
    await real.tick();
    core.service.manage('WREVW01', u.id, 'resume'); // even the owner's Resume does nothing
    await t.clock.advance(MIN);
    await real.tick();

    const w = core.service.list(u.id).find((x) => x.id === 'WREVW01')!;
    // The watcher keeps being checked once the LLM is back (and Resume of an 'active' watcher re-arms its job).
    expect({ status: w.status, checkedAgain: t.caps.safeFetch.calls.length > fetches }).toEqual({ status: 'active', checkedAgain: true });
  });
});
