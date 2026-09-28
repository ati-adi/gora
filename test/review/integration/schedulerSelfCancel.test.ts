// INTEGRATION (F7): a handler that cancels its own job (e.g. a brief cron that fires after the brief was disabled) ends
// the series: finish() leaves a 'cancelled' row alone (it only updates 'leased' rows), for 'done' and 'reschedule' results.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createJobsRepo } from '../../../src/scheduler/repo.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
let sch: Scheduler;
beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s, { random: () => 0.5 });
  (env.s as { scheduler: Scheduler }).scheduler = sch;
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

describe('scheduler: a handler cancels its own job (F7)', () => {
  for (const result of ['done', 'reschedule'] as const) {
    it(`cron job cancelled by its handler stays cancelled (${result})`, async () => {
      let runs = 0;
      sch.register('brief', async (_j, ctx) => {
        runs++;
        sch.cancel('brief:u1');
        return result === 'done' ? { status: 'done' } : { status: 'reschedule', runAt: ctx.now + 60_000 };
      });
      const id = sch.schedule({ kind: 'brief', runAt: env.clock.now(), cron: '0 9 * * *', tz: 'UTC', userId: 'u1', refId: 'u1', dedupeKey: 'brief:u1' });
      expect(await sch.tick()).toBe(1);
      expect(createJobsRepo(env.db).byId(id)!.status).toBe('cancelled');
      await env.clock.advance(2 * 86_400_000);
      await sch.tick();
      expect(runs).toBe(1);
    });
  }
});
