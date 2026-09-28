// memory/incognito.ts (WP6a) — the incognito_end job (01 §9 "Incognito"). WP7's /incognito sets users.incognito_until,
// rotates the DM (reason incognito_start) and schedules this job (dedupe 'incog:<userId>'); `/incognito off` clears
// incognito_until and schedules it for now. The handler finalizes the incognito window:
//  - no extraction of window content: every conversation's extraction watermark moves to the window's end, so a
//    memory_extract job that fires after incognito ended never reads an input written during it (whatever epoch it
//    was consumed in: /new during incognito, topics and missions that /incognito never rotated);
//  - the shred: every conversation that was in an incognito epoch since the last incognito_end (even when /new
//    replaced that epoch since), and every dm/topic/mission conversation the owner wrote in during the window, rotates with reason
//    incognito_end (WP3 seeds from the pre-incognito handoff and shreds the old epoch).
import type { Ms } from '../contracts/common.ts';
import type { JobHandler, JobResult } from '../contracts/scheduler.ts';
import type { RunHook, Services } from '../contracts/services.ts';
import type { ConversationRow } from '../contracts/storage.ts';
import { errorMessage } from '../kernel/errors.ts';
import type { MemoryStore } from './store.ts';

export const incognitoKey = (userId: string) => `incog:${userId}`;

/** How far back the epoch chain is walked to find the incognito_start of the current window. */
const MAX_EPOCH_WALK = 50;
const WINDOW_SURFACES: ReadonlySet<ConversationRow['kind']> = new Set(['dm', 'topic', 'mission']);

export function createIncognito(s: Services, store: MemoryStore) {
  const log = () => s.log.child({ mod: 'memory' });

  const scheduleEnd = (userId: string, at: number): void => {
    s.scheduler.schedule({ kind: 'incognito_end', runAt: at, userId, refId: userId, dedupeKey: incognitoKey(userId), priority: 2 });
  };

  /**
   * The start of the open incognito window of a conversation: the startedAt of the EARLIEST incognito_start epoch
   * since the last incognito_end epoch (walking back from the current epoch), or null. A /incognito re-issued inside
   * an open window adds a later incognito_start; the window still began at the first one (matches agent/epochs.ts
   * incognitoWindow, which shreds the whole window).
   */
  const openWindowStart = (conv: ConversationRow): Ms | null => {
    let start: Ms | null = null;
    for (let e = conv.epoch, i = 0; e >= 1 && i < MAX_EPOCH_WALK; e--, i++) {
      const row = s.repos.conversations.getEpoch(conv.id, e);
      if (!row || row.reason === 'incognito_end') break;
      if (row.reason === 'incognito_start') start = row.startedAt;
    }
    return start;
  };

  /** Moves a conversation's extraction watermark to `at` (inputs created at or before it are never extracted). */
  const sealWindow = (conversationId: string, at: Ms, now: Ms): void => {
    store.repo().setWatermark(conversationId, at, now);
  };

  const handler: JobHandler = async (job, ctx): Promise<JobResult> => {
    const userId = job.userId ?? job.refId;
    const u = userId ? s.repos.users.getById(userId) : undefined;
    if (!u || u.status === 'deleting') return { status: 'done' };
    if (u.incognitoUntil !== null && u.incognitoUntil > ctx.now) return { status: 'reschedule', runAt: u.incognitoUntil };
    // The window ended at incognito_until (expiry), or now (`/incognito off` already cleared it). Incognito holds while
    // incognito_until > now, so an input created at the end instant itself is already outside: the window's last
    // instant is end - 1.
    const end = (u.incognitoUntil !== null ? Math.min(u.incognitoUntil, ctx.now) : ctx.now) - 1;
    const convs = s.repos.conversations.listByUser(u.id, { status: 'active', limit: 200 });
    const starts = new Map<string, Ms | null>();
    for (const conv of convs) starts.set(conv.id, openWindowStart(conv));
    const known = [...starts.values()].filter((v): v is Ms => v !== null);
    const windowStart = known.length ? Math.min(...known) : null;
    let n = 0;
    for (const conv of convs) {
      try {
        if (WINDOW_SURFACES.has(conv.kind)) sealWindow(conv.id, end, ctx.now);
        const inWindow =
          starts.get(conv.id) !== null ||
          (windowStart !== null && WINDOW_SURFACES.has(conv.kind) && s.repos.inputs.ownerAuthoredSince(conv.id, windowStart - 1).some((i) => i.createdAt <= end));
        if (!inWindow) continue;
        s.runner.requestRotation(conv.id, 'incognito_end');
        n++;
      } catch (e) {
        log().warn({ conversationId: conv.id, err: errorMessage(e) }, 'incognito_end: rotation request failed');
        return { status: 'retry', error: errorMessage(e) };
      }
    }
    if (u.incognitoUntil !== null) s.repos.users.update(u.id, { incognitoUntil: null });
    log().info({ userId: u.id, rotated: n }, 'incognito ended');
    return { status: 'done' };
  };

  /**
   * Whenever a run finishes while the owner is incognito: the end job exists (idempotent upsert, safety net), and the
   * conversation's extraction watermark moves past everything this run consumed, so a later extraction never reads it.
   */
  const runHook: RunHook = {
    name: 'memory_incognito',
    onRunFinished(run, conv) {
      if (!run.userId) return;
      const u = s.repos.users.getById(run.userId);
      const now = s.clock.now();
      if (!u?.incognitoUntil || u.incognitoUntil <= now) return;
      scheduleEnd(u.id, u.incognitoUntil);
      if (conv && WINDOW_SURFACES.has(conv.kind)) {
        try {
          sealWindow(conv.id, now, now);
        } catch (e) {
          log().warn({ conversationId: conv.id, err: errorMessage(e) }, 'incognito: watermark update failed');
        }
      }
    },
  };

  return { handler, runHook, scheduleEnd };
}
