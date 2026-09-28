// Review (scheduler): system cron jobs are re-upserted at every boot (privacy/index.ts:79-80, proactive/index.ts:26,
// surfaces/index.ts:90, trust/callbacks.ts:38) and repo.upsert (scheduler/repo.ts:66-74) overwrites run_at of the existing row.
//  (a) a run that came due while the process was down is silently dropped (run_at jumps to the next occurrence), contrary
//      to 01 §8.2 "missed runs … coalesced into one run";
//  (b) if the previous process died while the job was leased, the new process marks it `rearmed` (scheduler.ts:258) with a
//      run_at that is never advanced again: when it finally runs, apply() (scheduler.ts:124-128) re-schedules it at the same,
//      already-past run_at, so it runs twice back-to-back.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
const MIN = 60_000;
const at = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m);
const bootSchedule = (sch: Scheduler) =>
  // exactly what privacy/index.ts:80 does at factory time: runAt = the next daily 03:30 UTC
  sch.schedule({ kind: 'backup', runAt: env.s.clock.now() < at(29, 3, 30) ? at(29, 3, 30) : env.s.clock.now() < at(30, 3, 30) ? at(30, 3, 30) : at(31, 3, 30), cron: '30 3 * * *', tz: 'UTC', dedupeKey: 'sys:backup', maxAttempts: 5 });

beforeEach(() => {
  env = makeEnv(); // 2026-09-28 09:00Z
});
afterEach(() => env.close());

describe('restart and system cron jobs', () => {
  it('a daily run that came due during downtime still runs once after restart', async () => {
    const a = createScheduler(env.s);
    a.register('backup', async () => ({ status: 'done' }));
    bootSchedule(a);
    await env.clock.advance(at(29, 3, 0) - env.clock.now()); // process A stops at 03:00
    await a.stop();
    await env.clock.advance(40 * MIN); // down 03:00-03:40, the 03:30 run is missed
    const b = createScheduler(env.s);
    let runs = 0;
    b.register('backup', async () => {
      runs++;
      return { status: 'done' };
    });
    bootSchedule(b); // boot upsert
    await b.tick();
    // regression (was failing before the fix): 0 — the missed 29 Sep backup is dropped (run_at overwritten with 30 Sep 03:30)
    expect(runs).toBe(1);
  });

  it('a job leased by a crashed process runs exactly once per occurrence afterwards', async () => {
    const a = createScheduler(env.s);
    a.register('backup', () => new Promise(() => {})); // process A hangs/crashes mid-backup
    bootSchedule(a);
    await env.clock.advance(at(29, 3, 30) - env.clock.now());
    void a.tick();
    await env.clock.advance(2 * MIN); // crash; restart at 03:32 while the lease (5 min) is still valid
    const b = createScheduler(env.s);
    let runs = 0;
    b.register('backup', async () => {
      runs++;
      return { status: 'done' };
    });
    bootSchedule(b); // upsert on a *leased* row → rearmed
    await env.clock.advance(at(30, 3, 30) - env.clock.now());
    await b.tick();
    await b.tick();
    await b.tick();
    // regression (was failing before the fix): 2 — the 30 Sep occurrence runs twice
    expect(runs).toBe(1);
  });
});
