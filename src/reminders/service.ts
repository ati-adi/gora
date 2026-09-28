// reminders/service.ts (WP6a) — ReminderService (01 F6, §8.1, §8.3): validated creation in the owner's zone (past times
// rejected, DST gap shifted forward and reported, overlap → earlier instant), croner recurrences, scoped management.
import type { Ms, Scope, UserId } from '../contracts/common.ts';
import { scopeKey } from '../contracts/common.ts';
import type { JobKind } from '../contracts/scheduler.ts';
import type { ReminderService, ReminderView } from '../contracts/proactive.ts';
import type { Services } from '../contracts/services.ts';
import { formatDisplay, isValidTz, parseLocal, wallTimeOf, zonedToInstant, type ZonedAdjust } from '../kernel/timeMath.ts';
import { createJobsRepo, type JobsRepo } from '../scheduler/repo.ts';
import { assertCron, cronNext, cronRuns } from '../scheduler/scheduler.ts';
import { createReminderRepo, type ReminderRepo, type ReminderRow } from './repo.ts';

export const MAX_TEXT = 300;
export const MAX_ACTIVE_PER_SCOPE = 100;
export const MAX_CREATES_PER_10MIN = 20;
export const MAX_SNOOZE_MIN = 10_080;
/** Cron recurrences may not fire more often than this (a reminder every minute is spam, not a reminder). */
export const MIN_CRON_INTERVAL_MS = 15 * 60_000;
/**
 * How many consecutive occurrences the minimum interval is checked over. A burst pattern ("* 14 * * *") created during
 * its own last minute has its first two occurrences a day apart; its next day's burst is well inside this sample.
 */
export const CRON_INTERVAL_SAMPLE = 400;

/** A user-facing validation failure (the tool turns it into an is_error result with this code). */
export class ReminderError extends Error {
  readonly code: 'past' | 'bad_time' | 'bad_cron' | 'bad_tz' | 'too_many' | 'rate_limited' | 'not_found' | 'bad_input' | 'bad_state';
  constructor(code: ReminderError['code'], message: string) {
    super(message);
    this.name = 'ReminderError';
    this.code = code;
  }
}

export const jobKindFor = (k: ReminderRow['kind']): JobKind => (k === 'checkin' ? 'checkin_fire' : 'reminder_fire');
export const jobKey = (id: string) => `rem:${id}`;
export const snoozeKey = (id: string) => `rem:${id}:snz`;

/** The reminder's schedule snapshot, used by Undo of reminder_manage. */
export interface ReminderSnapshot { status: ReminderRow['status']; scheduleKind: ReminderRow['scheduleKind']; fireAt: Ms | null; cron: string | null; tz: string }

export interface ReminderServiceImpl extends ReminderService {
  repo(): ReminderRepo;
  get(id: string, scope: Scope): ReminderRow | undefined;
  view(r: ReminderRow): ReminderView;
  nextFire(r: ReminderRow): Ms | null;
  /** Undo for reminder_create (cancel) and reminder_manage (restore the snapshot). */
  restore(id: string, scope: Scope, snap: ReminderSnapshot): ReminderView;
  snapshot(r: ReminderRow): ReminderSnapshot;
  /** rm: callback: "Tomorrow" = the same local time tomorrow as the reminder's own time of day. */
  snoozeUntil(id: string, scope: Scope, at: Ms): ReminderView;
  markDone(id: string, scope: Scope): ReminderView;
  langOf(scope: string): string;
}

/** Possible DST shifts (Lord Howe 30 min, the usual 60 min, Antarctica/Troll 120 min). */
const DST_SHIFTS_MIN = [30, 60, 120];

/**
 * Resolves an `at_local` wall time; throws ReminderError on a malformed or past time. In a DST overlap the earlier
 * instant is taken, unless it has already passed while the later one (the same wall time after the fall-back) is ahead.
 */
export function resolveAtLocal(atLocal: string, tz: string, now: Ms): { instant: Ms; adjusted: ZonedAdjust } {
  const w = parseLocal(atLocal);
  if (!w) throw new ReminderError('bad_time', `at_local must be YYYY-MM-DDTHH:mm (got "${atLocal.slice(0, 40)}")`);
  const r = zonedToInstant(w, tz);
  if (r.instant <= now && r.adjusted === 'overlap_earlier') {
    for (const d of DST_SHIFTS_MIN) {
      const t = r.instant + d * 60_000;
      const x = wallTimeOf(t, tz);
      if (x.year === w.year && x.month === w.month && x.day === w.day && x.hour === w.hour && x.minute === w.minute) {
        if (t > now) return { instant: t, adjusted: 'none' };
        break;
      }
    }
  }
  if (r.instant <= now) throw new ReminderError('past', `${atLocal} (${tz}) is in the past`);
  return r;
}

/** Validates a cron expression in `tz` and returns its first run after `now`. */
export function resolveCron(cron: string, tz: string, now: Ms): Ms {
  const expr = cron.trim();
  if (expr.split(/\s+/).length !== 5) throw new ReminderError('bad_cron', 'cron must have exactly 5 fields (minute hour day month weekday)');
  try {
    assertCron(expr, tz);
  } catch (e) {
    throw new ReminderError('bad_cron', e instanceof Error ? e.message : 'invalid cron expression');
  }
  const runs = cronRuns(expr, tz, now, CRON_INTERVAL_SAMPLE);
  const first = runs[0];
  if (first === undefined) throw new ReminderError('bad_cron', 'this cron expression never fires');
  // every consecutive pair of the sample, not only the first two (a burst may start right after the first occurrence)
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]! - runs[i - 1]! < MIN_CRON_INTERVAL_MS) throw new ReminderError('bad_cron', 'recurrences must be at least 15 minutes apart');
  }
  return first;
}

export function createReminderService(s: Services): ReminderServiceImpl {
  let repoCache: ReminderRepo | null = null;
  const repo = (): ReminderRepo => (repoCache ??= createReminderRepo(s.db, s.crypto));
  let jobsCache: JobsRepo | null = null;
  const jobs = (): JobsRepo => (jobsCache ??= createJobsRepo(s.db));

  const langOf = (scope: string): string => {
    if (!scope.startsWith('user:')) return 'en';
    return s.repos.users.getById(scope.slice(5))?.languageCode ?? 'en';
  };

  const nextFire = (r: ReminderRow): Ms | null => {
    if (r.status === 'cancelled' || r.status === 'done') return null;
    if (r.scheduleKind === 'once') return r.fireAt;
    try {
      const j = jobs().byDedupe(jobKey(r.id));
      if (j && (j.status === 'scheduled' || j.status === 'leased')) return j.runAt;
      return r.cron && r.status !== 'paused' ? cronNext(r.cron, r.tz, s.clock.now()) : null;
    } catch {
      return null;
    }
  };

  const view = (r: ReminderRow): ReminderView => {
    const lang = langOf(r.scope);
    const at = nextFire(r);
    const when = at === null ? '' : formatDisplay(at, r.tz, lang);
    const display = r.scheduleKind === 'cron' ? `${when}${when ? ' · ' : ''}cron "${r.cron}"` : when;
    return { id: r.id, kind: r.kind, text: r.text, display, status: r.status, cron: r.cron };
  };

  const get = (id: string, scope: Scope): ReminderRow | undefined => {
    const r = repo().getReminder(id.trim().toUpperCase());
    return r && r.scope === scopeKey(scope) ? r : undefined;
  };
  const must = (id: string, scope: Scope): ReminderRow => {
    const r = get(id, scope);
    if (!r) throw new ReminderError('not_found', `No reminder ${id} here`);
    return r;
  };

  const arm = (r: ReminderRow, runAt: Ms): void => {
    const jobId = s.scheduler.schedule({
      kind: jobKindFor(r.kind), runAt, userId: r.userId ?? undefined, refId: r.id, dedupeKey: jobKey(r.id), priority: 1, maxAttempts: 8,
      ...(r.scheduleKind === 'cron' && r.cron ? { cron: r.cron, tz: r.tz } : {}),
    });
    repo().updateReminder(r.id, { jobId }, s.clock.now());
  };
  const disarm = (id: string): void => {
    s.scheduler.cancel(jobKey(id));
    s.scheduler.cancel(snoozeKey(id));
  };
  const reload = (id: string): ReminderRow => repo().getReminder(id)!;

  const svc: ReminderServiceImpl = {
    repo,
    get,
    view,
    nextFire,
    langOf,

    create(p) {
      const now = s.clock.now();
      const text = p.text.trim();
      if (!text) throw new ReminderError('bad_input', 'text is empty');
      if (text.length > MAX_TEXT) throw new ReminderError('bad_input', `text is longer than ${MAX_TEXT} characters`);
      if (!isValidTz(p.tz)) throw new ReminderError('bad_tz', `unknown time zone "${p.tz}"`);
      if (!!p.atLocal === !!p.cron) throw new ReminderError('bad_input', 'give exactly one of at_local or cron');
      const sk = scopeKey(p.scope);
      if (p.sourceToolUseId) {
        const prior = repo().bySourceToolUse(sk, p.sourceToolUseId);
        if (prior) {
          const at = nextFire(prior) ?? prior.fireAt ?? now;
          return { id: prior.id, display: formatDisplay(at, prior.tz, langOf(sk)), unixSec: Math.floor(at / 1000), adjusted: 'none' };
        }
      }
      if (repo().countActive(sk) >= MAX_ACTIVE_PER_SCOPE) throw new ReminderError('too_many', `at most ${MAX_ACTIVE_PER_SCOPE} active reminders; cancel some first`);
      if (repo().countCreatedSince(sk, now - 10 * 60_000) >= MAX_CREATES_PER_10MIN) throw new ReminderError('rate_limited', 'too many reminders created in the last 10 minutes');
      let at: Ms;
      let adjusted: ZonedAdjust = 'none';
      if (p.atLocal) {
        const r = resolveAtLocal(p.atLocal, p.tz, now);
        at = r.instant;
        adjusted = r.adjusted;
      } else at = resolveCron(p.cron!, p.tz, now);
      const id = repo().insertReminder({
        userId: p.userId, scope: sk, kind: p.kind, text, targetChatId: p.chatId, targetThreadId: p.threadId ?? null,
        scheduleKind: p.atLocal ? 'once' : 'cron', fireAt: p.atLocal ? at : null, cron: p.cron ? p.cron.trim() : null, tz: p.tz,
        status: 'scheduled', sourceToolUseId: p.sourceToolUseId ?? null, now,
      });
      arm(reload(id), at);
      return { id, display: formatDisplay(at, p.tz, langOf(sk)), unixSec: Math.floor(at / 1000), adjusted };
    },

    list(scope, includeDone) {
      const rows = repo().listReminders(scopeKey(scope), includeDone);
      const withNext = rows.map((r) => ({ r, at: nextFire(r) }));
      withNext.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || b.r.createdAt - a.r.createdAt);
      return withNext.map(({ r }) => view(r));
    },

    manage(id, scope, action, arg) {
      const r = must(id, scope);
      const now = s.clock.now();
      const R = repo();
      switch (action) {
        case 'cancel': {
          if (r.status === 'cancelled') return view(r);
          disarm(r.id);
          R.updateReminder(r.id, { status: 'cancelled' }, now);
          return view(reload(r.id));
        }
        case 'snooze': {
          if (r.status === 'cancelled') throw new ReminderError('bad_state', `${r.id} is cancelled`);
          const min = Math.round(arg?.snoozeMin ?? 10);
          if (!(min >= 1 && min <= MAX_SNOOZE_MIN)) throw new ReminderError('bad_input', `snooze_min must be 1..${MAX_SNOOZE_MIN}`);
          return svc.snoozeUntil(r.id, scope, now + min * 60_000);
        }
        case 'reschedule': {
          if (!!arg?.atLocal === !!arg?.cron) throw new ReminderError('bad_input', 'reschedule needs exactly one of at_local or cron');
          if (arg?.atLocal) {
            const at = resolveAtLocal(arg.atLocal, r.tz, now).instant;
            s.scheduler.cancel(snoozeKey(r.id));
            R.updateReminder(r.id, { scheduleKind: 'once', fireAt: at, cron: null, status: 'scheduled' }, now);
            arm(reload(r.id), at);
          } else {
            const at = resolveCron(arg!.cron!, r.tz, now);
            s.scheduler.cancel(snoozeKey(r.id));
            R.updateReminder(r.id, { scheduleKind: 'cron', fireAt: null, cron: arg!.cron!.trim(), status: 'scheduled' }, now);
            arm(reload(r.id), at);
          }
          return view(reload(r.id));
        }
        case 'pause': {
          if (r.status === 'cancelled' || r.status === 'done') throw new ReminderError('bad_state', `${r.id} is ${r.status}`);
          if (r.status === 'paused') return view(r);
          disarm(r.id);
          R.updateReminder(r.id, { status: 'paused' }, now);
          return view(reload(r.id));
        }
        case 'resume': {
          if (r.status !== 'paused') return view(r);
          if (r.scheduleKind === 'cron') {
            const at = resolveCron(r.cron!, r.tz, now);
            R.updateReminder(r.id, { status: 'scheduled' }, now);
            arm(reload(r.id), at);
          } else {
            const at = Math.max(r.fireAt ?? now, now);
            R.updateReminder(r.id, { status: 'scheduled', fireAt: at }, now);
            arm(reload(r.id), at);
          }
          return view(reload(r.id));
        }
      }
    },

    snoozeUntil(id, scope, at) {
      const r = must(id, scope);
      const now = s.clock.now();
      if (r.status === 'cancelled') throw new ReminderError('bad_state', `${r.id} is cancelled`);
      const when = Math.max(at, now + 60_000);
      if (r.scheduleKind === 'once') {
        repo().updateReminder(r.id, { status: 'snoozed', fireAt: when }, now);
        arm(reload(r.id), when);
      } else {
        // A recurring reminder keeps its series; the snooze is a one-off extra firing.
        s.scheduler.schedule({ kind: jobKindFor(r.kind), runAt: when, userId: r.userId ?? undefined, refId: r.id, dedupeKey: snoozeKey(r.id), priority: 1, maxAttempts: 8, payload: { snooze: true } });
      }
      return { ...view(reload(r.id)), display: formatDisplay(when, r.tz, langOf(r.scope)) };
    },

    markDone(id, scope) {
      const r = must(id, scope);
      const now = s.clock.now();
      if (r.scheduleKind === 'once') {
        if (r.status !== 'done' && r.status !== 'cancelled') {
          disarm(r.id);
          repo().updateReminder(r.id, { status: 'done' }, now);
        }
      } else s.scheduler.cancel(snoozeKey(r.id)); // this occurrence is done; the series continues
      return view(reload(r.id));
    },

    snapshot(r) {
      return { status: r.status, scheduleKind: r.scheduleKind, fireAt: r.fireAt, cron: r.cron, tz: r.tz };
    },

    restore(id, scope, snap) {
      const r = must(id, scope);
      const now = s.clock.now();
      disarm(r.id);
      repo().updateReminder(r.id, { status: snap.status, scheduleKind: snap.scheduleKind, fireAt: snap.fireAt, cron: snap.cron, tz: snap.tz }, now);
      const back = reload(r.id);
      if (back.status === 'scheduled' || back.status === 'snoozed') {
        let at: Ms | null = null;
        if (back.scheduleKind === 'once') at = Math.max(back.fireAt ?? now, now);
        else if (back.cron) at = cronNext(back.cron, back.tz, now);
        if (at !== null) arm(back, at);
      }
      return view(reload(r.id));
    },

    rescheduleForTz(userId: UserId, tz: string) {
      if (!isValidTz(tz)) throw new ReminderError('bad_tz', `unknown time zone "${tz}"`);
      const now = s.clock.now();
      let n = 0;
      for (const r of repo().activeForUser(userId)) {
        if (r.tz === tz) continue;
        repo().updateReminder(r.id, { tz }, now);
        // One-off reminders keep their absolute instant (§8.1); recurrences are recomputed in the new zone.
        if (r.scheduleKind !== 'cron' || !r.cron) continue;
        if (r.status !== 'paused') {
          const at = cronNext(r.cron, tz, now);
          if (at !== null) arm(reload(r.id), at);
        }
        n++;
      }
      return n;
    },
  };
  return svc;
}
