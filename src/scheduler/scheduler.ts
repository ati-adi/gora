// scheduler/scheduler.ts (WP6a) — 01 §8.2: a single leased claim loop over `jobs`, recurrences via croner in the job's
// zone, retries with capped exponential backoff, dead-lettering with a ledger entry, and the 03 R6 LLM budget gate.
import { Cron } from 'croner';
import type { Ms, Random } from '../contracts/common.ts';
import type { JobHandler, JobKind, JobResult, NewJob, Scheduler } from '../contracts/scheduler.ts';
import { JOB_LLM_PRIORITY } from '../contracts/scheduler.ts';
import type { Services } from '../contracts/services.ts';
import { uiLang } from '../contracts/i18n.ts';
import { errorMessage } from '../kernel/errors.ts';
import { isValidTz } from '../kernel/timeMath.ts';
import { systemRandom } from '../kernel/random.ts';
import { createJobsRepo, type JobsRepo, type StoredJob } from './repo.ts';

export const LEASE_MS = 300_000;
/**
 * A handler still running this long (in leases) gets its abort signal; one still running after ABANDON_LEASES is
 * abandoned: its lease is no longer renewed, so the job is released and re-claimed (a crashed/hung handler must not
 * hold its job forever), and whatever it returns later is ignored.
 */
export const SOFT_TIMEOUT_LEASES = 3;
export const ABANDON_LEASES = 12;
export const CLAIM_BATCH = 20;
export const MAX_IDLE_MS = 1_000;
export const BUDGET_DEFER_MS = 10 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 3_600_000;
/** Jobs whose permanent failure the owner hears about (01 §8.2 "notified if the job was user-facing"). */
const USER_FACING: ReadonlySet<JobKind> = new Set<JobKind>(['reminder_fire', 'checkin_fire', 'brief', 'watcher_check', 'followup_due', 'first_look']);

/** Validates a 5-field cron expression (throws a readable RangeError). */
export function assertCron(expr: string, tz: string): void {
  if (!isValidTz(tz)) throw new RangeError(`invalid time zone: ${tz}`);
  try {
    new Cron(expr, { timezone: tz, mode: '5-part', paused: true });
  } catch (e) {
    throw new RangeError(`invalid cron expression "${expr}": ${errorMessage(e)}`);
  }
}

/** The first occurrence strictly after `from` in `tz` (croner `{timezone}`), or null when the pattern never fires again. */
export function cronNext(expr: string, tz: string, from: Ms): Ms | null {
  const d = new Cron(expr, { timezone: tz, mode: '5-part', paused: true }).nextRun(new Date(from));
  return d ? d.getTime() : null;
}

/** Up to `n` occurrences strictly after `from` in `tz`, in order (fewer when the pattern stops firing). */
export function cronRuns(expr: string, tz: string, from: Ms, n: number): Ms[] {
  return new Cron(expr, { timezone: tz, mode: '5-part', paused: true }).nextRuns(n, new Date(from)).map((d) => d.getTime());
}

/** min(30 s · 2^attempts, 1 h) with ±10 % jitter. `rnd` defaults to the midpoint (no jitter); the scheduler passes s.random. */
export function retryDelay(attempts: number, rnd: () => number = () => 0.5): Ms {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts), RETRY_CAP_MS);
  return Math.round(base * (0.9 + 0.2 * rnd()));
}

export interface SchedulerOptions { leaseMs?: number; batch?: number; random?: () => number }

export function createSchedulerImpl(s: Services, o: SchedulerOptions = {}): Scheduler {
  const leaseMs = o.leaseMs ?? LEASE_MS;
  const batch = o.batch ?? CLAIM_BATCH;
  // spec 05 §E: randomness only through the injectable Random (s.random, set by app.ts before the scheduler is built)
  // (hand-built unit-test Services may lack `random`: fall back to the crypto Random, never to Math.random)
  let fallback: Random | null = null;
  const rnd = o.random ?? (() => (s.random ?? (fallback ??= systemRandom())).next());
  const handlers = new Map<JobKind, JobHandler>();
  const inflight = new Set<Promise<void>>();
  /** Jobs whose handler runs in this process right now (id → run token): their leases are renewed on every tick. */
  const live = new Map<string, { token: symbol; startedAt: Ms }>();
  /** Leased jobs that schedule() re-armed while their handler ran here: finishing them re-schedules instead of completing. */
  const rearmed = new Set<string>();
  let repoCache: JobsRepo | null = null;
  const repo = (): JobsRepo => (repoCache ??= createJobsRepo(s.db));
  const log = () => s.log.child({ mod: 'scheduler' });
  let running = false;
  let loopAc: AbortController | null = null;
  let loopDone: Promise<void> | null = null;
  let lastTickAt: Ms | null = null;

  const allowedKinds = (now: Ms): JobKind[] => {
    const kinds = [...handlers.keys()];
    const denied: JobKind[] = [];
    const cache = new Map<string, boolean>();
    const ok = kinds.filter((k) => {
      const p = JOB_LLM_PRIORITY[k];
      if (p === null || p === undefined) return true;
      let allow = cache.get(p);
      if (allow === undefined) {
        try {
          allow = s.llmBudget ? s.llmBudget.allow(p) : true;
        } catch (e) {
          log().warn({ err: errorMessage(e) }, 'llmBudget.allow failed; allowing');
          allow = true;
        }
        cache.set(p, allow);
      }
      if (!allow) denied.push(k);
      return allow;
    });
    if (denied.length) {
      const n = repo().deferKinds(denied, now, now + Math.round(BUDGET_DEFER_MS * (0.9 + 0.2 * rnd())));
      if (n) log().info({ kinds: denied, deferred: n }, 'LLM budget: background/proactive jobs deferred');
    }
    return ok;
  };

  const notifyDead = (job: StoredJob): void => {
    if (!job.userId) return;
    try {
      s.ledger.append({ userId: job.userId, actor: 'scheduler', kind: 'tool_call', summary: `Scheduled ${job.kind} failed after ${job.attempts} attempts`, detail: { jobId: job.id, jobKind: job.kind, refId: job.refId } });
    } catch (e) {
      log().warn({ jobId: job.id, err: errorMessage(e) }, 'dead job: ledger append failed');
    }
    if (!USER_FACING.has(job.kind)) return;
    try {
      const u = s.repos.users.getById(job.userId);
      if (!u?.dmChatId || u.status === 'deleting') return;
      const text = uiLang(u.languageCode) === 'ru'
        ? `⚠️ Не удалось выполнить запланированное действие (${job.kind === 'reminder_fire' ? 'напоминание' : job.kind}). Проверьте /tasks.`
        : `⚠️ I couldn't complete a scheduled ${job.kind === 'reminder_fire' ? 'reminder' : job.kind.replace('_', ' ')} after several tries. Check /tasks.`;
      s.telegram.outbox.enqueue({ idempotencyKey: `jobdead:${job.id}:${job.attempts}`, userId: job.userId, chatId: u.dmChatId, method: 'sendRichMessage', payload: {}, markdown: text, priority: 5 });
    } catch (e) {
      log().warn({ jobId: job.id, err: errorMessage(e) }, 'dead job: notify failed');
    }
  };

  /** 01 §8.2 "a cron job whose missed runs exceed 2 intervals is coalesced into one run". */
  const nextCronRunAt = (job: StoredJob, now: Ms): Ms | null => {
    const tz = job.tz ?? 'UTC';
    let next = cronNext(job.cron!, tz, job.runAt);
    if (next === null || next > now) return next;
    let missed = 0;
    let t: Ms | null = next;
    while (t !== null && t <= now && missed <= 2) {
      missed++;
      t = cronNext(job.cron!, tz, t);
    }
    if (missed > 2) next = cronNext(job.cron!, tz, now);
    return next;
  };

  const apply = (job: StoredJob, r: JobResult): void => {
    const now = s.clock.now();
    const R = repo();
    if (rearmed.delete(job.id)) {
      // re-armed during the run: the new schedule (already written) wins over this run's result
      R.finish(job.id, { status: 'scheduled', attempts: 0, lastError: null }, now);
      return;
    }
    switch (r.status) {
      case 'done': {
        if (job.cron) {
          let next: Ms | null = null;
          try {
            next = nextCronRunAt(job, now);
          } catch (e) {
            log().error({ jobId: job.id, kind: job.kind, err: errorMessage(e) }, 'cron evaluation failed');
          }
          if (next === null) R.finish(job.id, { status: 'done' }, now);
          else R.finish(job.id, { status: 'scheduled', runAt: next, attempts: 0, lastError: null }, now);
        } else R.finish(job.id, { status: 'done', lastError: null }, now);
        return;
      }
      case 'reschedule':
        R.finish(job.id, { status: 'scheduled', runAt: r.runAt, attempts: 0 }, now);
        return;
      case 'retry':
      case 'dead': {
        const exhausted = r.status === 'dead' || job.attempts >= job.maxAttempts;
        if (!exhausted) {
          R.finish(job.id, { status: 'scheduled', runAt: now + retryDelay(job.attempts, rnd), lastError: r.error }, now);
          return;
        }
        log().warn({ jobId: job.id, kind: job.kind, attempts: job.attempts }, 'job dead');
        notifyDead(job);
        if (job.cron) {
          // a recurring job loses only this occurrence; the series continues at its next run
          let next: Ms | null = null;
          try {
            next = cronNext(job.cron, job.tz ?? 'UTC', now);
          } catch {
            next = null;
          }
          if (next !== null) {
            R.finish(job.id, { status: 'scheduled', runAt: next, attempts: 0, lastError: r.error }, now);
            return;
          }
        }
        R.finish(job.id, { status: 'dead', lastError: r.error }, now);
        return;
      }
    }
  };

  const runOne = async (job: StoredJob, parent: AbortSignal | null): Promise<void> => {
    const h = handlers.get(job.kind);
    const token = Symbol(job.id);
    live.set(job.id, { token, startedAt: s.clock.now() });
    const ac = new AbortController();
    const onParent = () => ac.abort(parent?.reason ?? 'shutdown');
    parent?.addEventListener('abort', onParent, { once: true });
    const timer = s.clock.setTimeout(() => ac.abort('timeout'), Math.max(1_000, leaseMs * SOFT_TIMEOUT_LEASES - 10_000));
    let r: JobResult;
    try {
      if (!h) r = { status: 'retry', error: 'no handler' };
      else r = await h(job, { now: s.clock.now(), signal: ac.signal });
      if (!r || typeof r !== 'object' || !('status' in r)) r = { status: 'retry', error: 'handler returned no result' };
    } catch (e) {
      r = { status: 'retry', error: errorMessage(e) };
      log().warn({ jobId: job.id, kind: job.kind, attempts: job.attempts, err: e instanceof Error ? e.name : 'error' }, 'job handler threw');
    } finally {
      s.clock.clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    }
    if (live.get(job.id)?.token !== token) {
      // abandoned (the job was released and possibly re-claimed since): this late result must not overwrite that run
      log().warn({ jobId: job.id, kind: job.kind }, 'abandoned job handler returned; result ignored');
      return;
    }
    live.delete(job.id);
    try {
      apply(job, r);
    } catch (e) {
      log().error({ jobId: job.id, kind: job.kind, err: errorMessage(e) }, 'job result could not be stored');
    }
  };

  /** Renews the leases of the handlers running here; abandons the ones running for longer than ABANDON_LEASES leases. */
  const heartbeat = (now: Ms): void => {
    if (!live.size) return;
    const keep: string[] = [];
    for (const [id, l] of live) {
      if (now - l.startedAt < leaseMs * ABANDON_LEASES) keep.push(id);
      else {
        live.delete(id);
        rearmed.delete(id);
        log().error({ jobId: id, runningMs: now - l.startedAt }, 'job handler hung; abandoned (the job is released when its lease expires)');
      }
    }
    repo().extendLeases(keep, now + leaseMs, now + leaseMs / 2, now);
  };

  const claimAndLaunch = (): { count: number; done: Promise<void> } => {
    const now = s.clock.now();
    const R = repo();
    heartbeat(now);
    R.releaseExpired(now);
    const kinds = allowedKinds(now);
    const jobs = R.claim(kinds, now, leaseMs, batch);
    const ps: Array<Promise<void>> = [];
    for (const job of jobs) {
      if (job.attempts > job.maxAttempts) {
        // its leases kept expiring (crashed or hung handlers): dead-lettered instead of being launched yet again
        try {
          apply(job, { status: 'dead', error: 'lease expired too often' });
        } catch (e) {
          log().error({ jobId: job.id, kind: job.kind, err: errorMessage(e) }, 'job result could not be stored');
        }
        continue;
      }
      const p: Promise<void> = runOne(job, loopAc?.signal ?? null).finally(() => inflight.delete(p));
      inflight.add(p);
      ps.push(p);
    }
    return { count: jobs.length, done: Promise.all(ps).then(() => undefined) };
  };

  const loop = async (signal: AbortSignal): Promise<void> => {
    while (running && !signal.aborted) {
      let full = false;
      try {
        full = claimAndLaunch().count >= batch;
      } catch (e) {
        log().error({ err: errorMessage(e) }, 'scheduler tick failed');
      }
      lastTickAt = s.clock.now();
      let wait = MAX_IDLE_MS;
      if (full) wait = 10;
      else {
        try {
          const next = repo().nextWake([...handlers.keys()]);
          if (next !== null) wait = Math.min(MAX_IDLE_MS, Math.max(10, next - s.clock.now()));
        } catch {
          /* keep the default */
        }
      }
      try {
        await s.clock.sleep(wait, signal);
      } catch {
        return;
      }
    }
  };

  return {
    schedule(j: NewJob): string {
      const now = s.clock.now();
      let runAt = j.runAt;
      let tz = j.tz;
      if (j.cron) {
        tz = tz ?? 'UTC';
        assertCron(j.cron, tz);
        if (!Number.isFinite(runAt) || runAt <= 0) {
          const n = cronNext(j.cron, tz, now);
          if (n === null) throw new RangeError(`cron expression "${j.cron}" never fires`);
          runAt = n;
        }
      }
      if (!Number.isFinite(runAt)) throw new RangeError('schedule(): runAt must be a finite instant');
      const r = repo().upsert({ ...j, runAt: Math.round(runAt), ...(tz !== undefined ? { tz } : {}), now });
      // only a handler running in THIS process re-arms on return; a lease left by a crashed process just expires
      if (r.leased && live.has(r.id)) rearmed.add(r.id);
      return r.id;
    },
    cancel(idOrKey: string): void {
      for (const id of repo().cancel(idOrKey, s.clock.now())) rearmed.delete(id);
    },
    register(kind: JobKind, h: JobHandler): void {
      if (handlers.has(kind)) s.log.warn({ kind }, 'job handler registered twice; the later registration replaces the earlier one');
      handlers.set(kind, h);
    },
    start(): void {
      if (running) return;
      running = true;
      loopAc = new AbortController();
      loopDone = loop(loopAc.signal);
    },
    async stop(): Promise<void> {
      running = false;
      loopAc?.abort('shutdown');
      await loopDone;
      loopDone = null;
      await Promise.allSettled([...inflight]);
      loopAc = null;
    },
    async tick(): Promise<number> {
      const r = claimAndLaunch();
      await r.done;
      await Promise.allSettled([...inflight]);
      lastTickAt = s.clock.now();
      return r.count;
    },
    list(q) {
      return repo()
        .list(q)
        .map((j) => ({ id: j.id, kind: j.kind, runAt: j.runAt, refId: j.refId, cron: j.cron, tz: j.tz }));
    },
    health() {
      return { lastTickAt };
    },
  };
}
