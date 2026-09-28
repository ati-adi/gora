// privacy/index.ts (WP1) — createPrivacyService(s): /export, /deletemydata, epoch/conversation shredding and the
// retention sweep (01 §7.2, §11.7, §11.9), plus WP1's jobs (04 §9): 'shred_epoch', 'retention_sweep' (hourly) and
// 'backup' (nightly). Handlers and the two system cron jobs are registered at factory time (04 §3 timing rule).
//
// 'shred_epoch' job contract (scheduled by WP3 for forget / wipe / incognito_end rotations, §5.9 step 3):
//   { kind:'shred_epoch', runAt, refId: conversationId, payload: { conversationId, epoch, reason } }
//   (payload.conversationId wins over refId; reason defaults to 'rotation'). Shredding the current epoch of an active
//   conversation is refused (the rotation must happen first) and the job goes dead with that error.
import type { JobHandler, JobKind, Ms, PrivacyService, Services } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { runBackup } from './backup.ts';
import { createDeleter } from './delete.ts';
import { exportUserBytes } from './export.ts';
import { createRetention } from './retention.ts';
import { createShredder, ShredCurrentEpochError } from './shred.ts';

export const RETENTION_CRON = '7 * * * *';
export const BACKUP_CRON = '30 3 * * *';
const HOUR = 3_600_000;

/** The next instant after `now` matching minute `m` of every hour (UTC). */
function nextHourlyAt(now: Ms, minute: number): Ms {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), minute);
  return t > now ? t : t + HOUR;
}
/** The next instant after `now` at hh:mm UTC. */
function nextDailyAt(now: Ms, hour: number, minute: number): Ms {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  return t > now ? t : t + 24 * HOUR;
}

export function createPrivacyService(s: Services): PrivacyService {
  const shredder = createShredder(s);
  const deleter = createDeleter(s, shredder);
  const retention = createRetention(s, shredder, deleter);

  const register = (kind: JobKind, h: JobHandler): void => {
    try {
      s.scheduler.register(kind, h);
    } catch (e) {
      // A handler registered earlier (a test override) is kept.
      s.log.warn({ kind, err: errorMessage(e) }, 'privacy: job handler not registered');
    }
  };

  register('shred_epoch', async (job) => {
    const p = job.payload;
    const conversationId = typeof p.conversationId === 'string' && p.conversationId ? p.conversationId : job.refId;
    const epoch = typeof p.epoch === 'number' ? p.epoch : Number(p.epoch);
    if (!conversationId || !Number.isInteger(epoch) || epoch < 1) return { status: 'dead', error: 'shred_epoch: bad payload' };
    const reason = typeof p.reason === 'string' && p.reason ? p.reason : 'rotation';
    try {
      await shredder.shredEpoch(conversationId, epoch, reason);
      return { status: 'done' };
    } catch (e) {
      if (e instanceof ShredCurrentEpochError) return { status: 'dead', error: 'current_epoch' };
      return { status: 'retry', error: errorMessage(e).slice(0, 200) };
    }
  });

  register('retention_sweep', async (_job, ctx) => {
    await retention.sweep(ctx.now);
    return { status: 'done' };
  });

  register('backup', async (_job, ctx) => {
    try {
      await runBackup(s, ctx.now);
      return { status: 'done' };
    } catch (e) {
      s.log.error({ err: errorMessage(e) }, 'backup failed');
      return { status: 'retry', error: errorMessage(e).slice(0, 200) };
    }
  });

  const now = s.clock.now();
  s.scheduler.schedule({ kind: 'retention_sweep', runAt: nextHourlyAt(now, 7), cron: RETENTION_CRON, tz: 'UTC', dedupeKey: 'sys:retention_sweep', maxAttempts: 3 });
  s.scheduler.schedule({ kind: 'backup', runAt: nextDailyAt(now, 3, 30), cron: BACKUP_CRON, tz: 'UTC', dedupeKey: 'sys:backup', maxAttempts: 5 });

  return {
    exportUser: (userId) => exportUserBytes(s, userId),
    deleteUser: (userId, reason) => deleter.deleteUser(userId, reason),
    shredEpoch: (conversationId, epoch, reason) => shredder.shredEpoch(conversationId, epoch, reason),
    shredConversation: (conversationId, reason) => shredder.shredConversation(conversationId, reason),
    retentionSweep: async (at) => {
      await retention.sweep(at);
    },
  };
}

export { createShredder, ShredCurrentEpochError, type Shredder } from './shred.ts';
export { createDeleter, deletedUserRef, type Deleter } from './delete.ts';
export { buildExport, exportUserBytes, EXPORT_FORMAT, EXPORT_VERSION } from './export.ts';
export { createRetention, RETENTION, type RetentionReport } from './retention.ts';
export { runBackup, pruneBackups, backupStamp, parseBackupStamp, BACKUP_RETENTION_MS } from './backup.ts';
