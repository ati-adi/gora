// scheduler/index.ts (WP6a) — factory. Built early by app.ts (right after the core repos) so every later factory can
// register job handlers and upsert system cron jobs at factory time.
import type { Scheduler, Services } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { createJobsRepo } from './repo.ts';
import { createSchedulerImpl, type SchedulerOptions } from './scheduler.ts';

export { assertCron, cronNext, retryDelay } from './scheduler.ts';

/** Finished job rows are kept this long for /why and debugging, then purged by the retention sweep. */
const FINISHED_JOB_RETENTION_MS = 30 * 86_400_000;

export function createScheduler(s: Services, o: SchedulerOptions = {}): Scheduler {
  const scheduler = createSchedulerImpl(s, o);
  s.privacyHooks.push({
    name: 'scheduler',
    async onDeleteUser(userId) {
      // WP1 deletes the rows (USER_DATA_TABLES step 1); cancelling first stops a claim racing the deletion.
      createJobsRepo(s.db).cancelAllForUser(userId, s.clock.now());
    },
    async retentionSweep(now) {
      try {
        createJobsRepo(s.db).purgeFinished(now - FINISHED_JOB_RETENTION_MS);
      } catch (e) {
        s.log.warn({ mod: 'scheduler', err: errorMessage(e) }, 'jobs retention sweep failed');
      }
    },
  });
  return scheduler;
}
