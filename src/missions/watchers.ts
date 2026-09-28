// missions/watchers.ts (WP6b) — WatcherService (01 F10 "Watchers", §11.5): page watchers fetch through SafeFetch, inbox
// watchers search through MailApi. Every check is deterministic: the content hash is compared first; a condition is
// evaluated only when the hash changed, and a semantic condition calls the LLM (side.semanticCheck, priority
// 'background', gated by llmBudget) only then. A hit wakes the mission waiting on `watcher:<id>` or sends a
// budget-exempt `watcher_hit` nudge. After 5 consecutive failures the watcher pauses and the owner is notified.
import type { JobResult, JobRow, Ms, Services, UserId, UserRow, WatchCondition, WatcherService, WatcherView } from '../contracts/index.ts';
import { shortId } from '../kernel/ids.ts';
import { cbButton, clipText, dmChatOf, langOf, planOf } from '../proactive/util.ts';
import type { MissionInternals } from './internal.ts';
import type { MissionRepo, WatcherRow } from './repo.ts';
import {
  changedWindow, checkWatchUrl, currentlyMet, evaluateChange, inboxIdsOf, inboxSnapshot, pageText, SEMANTIC_VALUE_MAX_CHARS, sha256Hex, snapshotValue,
  type Evaluation,
} from './watcherConditions.ts';
import { TransientLlmError, AbortedError } from '../kernel/errors.ts';

export const MAX_FAILS = 5;
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
const SEMANTIC_WINDOW = 6_000;
const LEVELS = { none: 0, read: 1, draft: 2, act: 3 } as const;

const TX = {
  en: {
    paused: (id: string, t: string) => `⚠️ Watcher ${id} (${t}) is paused after ${MAX_FAILS} failed checks in a row.`,
    resume: '▶️ Resume', cancel: '✖ Cancel', why: (id: string, sum: string) => `Watcher ${id} — ${sum}.`, body: (t: string) => `Watcher hit: ${t}`,
  },
  ru: {
    paused: (id: string, t: string) => `⚠️ Наблюдатель ${id} (${t}) на паузе: ${MAX_FAILS} неудачных проверок подряд.`,
    resume: '▶️ Продолжить', cancel: '✖ Удалить', why: (id: string, sum: string) => `Наблюдатель ${id} — ${sum}.`, body: (t: string) => `Сработал наблюдатель: ${t}`,
  },
} as const;

export class WatcherError extends Error {
  readonly code: 'invalid_url' | 'quota' | 'interval' | 'not_connected' | 'not_found' | 'mission';
  constructor(code: WatcherError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'WatcherError';
  }
}

export interface WatcherCore {
  service: WatcherService;
  internals: Pick<MissionInternals, 'createWatcherWithId' | 'watcherMinInterval'>;
  job(job: JobRow): Promise<JobResult>;
  /** Mission finished/cancelled: its watchers are done. */
  finishForMission(missionId: string): void;
}

type Fetched = { ok: true; text: string; hashInput: string; newItems?: number } | { ok: false; reason: string };

export function createWatcherCore(s: Services, repo: MissionRepo): WatcherCore {
  const now = () => s.clock.now();
  const dedupe = (id: string) => `wch:${id}`;
  const minInterval = (u: UserRow) => planOf(s, u).watcherMinIntervalMin;

  function schedule(w: Pick<WatcherRow, 'id' | 'userId'>, at: Ms): void {
    const jobId = s.scheduler.schedule({ kind: 'watcher_check', runAt: at, userId: w.userId, refId: w.id, dedupeKey: dedupe(w.id), maxAttempts: 3 });
    repo.setWatcherJob(w.id, jobId, at);
  }

  function view(w: WatcherRow): WatcherView {
    return {
      id: w.id, missionId: w.missionId, kind: w.kind, target: w.target, condition: w.condition, intervalMin: w.intervalMin,
      status: w.status, nextCheckAt: w.nextCheckAt, lastCheckedAt: w.lastCheckedAt, failCount: w.failCount,
    };
  }

  async function fetchState(w: WatcherRow): Promise<Fetched> {
    if (w.kind === 'page') {
      const chk = checkWatchUrl(w.target, { publicUrl: s.config.publicUrl, blockedDomains: s.config.blockedDomains });
      if (!chk.ok) return { ok: false, reason: chk.reason };
      try {
        const r = await s.caps.safeFetch.get(chk.url.toString(), { maxBytes: PAGE_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' });
        if (r.status >= 400) return { ok: false, reason: `http ${r.status}` };
        const text = pageText(r.body, r.contentType);
        return { ok: true, text, hashInput: text };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.name : 'fetch_error' };
      }
    }
    const st = s.integrations.status(w.userId).gmail;
    if (!st.connected || LEVELS[st.level] < LEVELS.read) return { ok: false, reason: 'gmail_not_connected' };
    const mail = s.integrations.mail(w.userId);
    if (!mail) return { ok: false, reason: 'gmail_not_connected' };
    try {
      const threads = await mail.search({ query: w.target, maxResults: 20, newerThanDays: 30 });
      const snap = inboxSnapshot(threads);
      const before = new Set(inboxIdsOf(w.lastValue));
      return { ok: true, text: snap.text, hashInput: snap.hashInput, newItems: w.lastValue === null ? 0 : snap.ids.filter((id) => !before.has(id)).length };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.name : 'mail_error' };
    }
  }

  async function notifyPaused(w: WatcherRow): Promise<void> {
    const u = s.repos.users.getById(w.userId);
    if (!u) return;
    const L = TX[langOf(u)];
    s.telegram.outbox.enqueue({
      idempotencyKey: `wpause:${w.id}:${w.lastCheckedAt ?? 0}`, userId: u.id, chatId: dmChatOf(u), ...(w.threadId !== null ? { threadId: w.threadId } : {}),
      method: 'sendRichMessage', markdown: s.telegram.render.escape(L.paused(w.id, clipText(w.target, 80))), priority: 5,
      payload: { reply_markup: { inline_keyboard: [[cbButton(s, L.resume, 'wt', [w.id, 'resume'], u.tgUserId), cbButton(s, L.cancel, 'wt', [w.id, 'cancel'], u.tgUserId)]] } },
    });
  }

  async function onHit(w: WatcherRow, summary: string): Promise<void> {
    s.ledger.append({ userId: w.userId, actor: 'system', kind: 'mission', summary: `Watcher ${w.id} condition met`, detail: { watcherId: w.id, missionId: w.missionId } });
    if (w.missionId) {
      const n = await s.runner.wake(`watcher:${w.id}`, { reason: 'watcher', watcherId: w.id, summary });
      if (n > 0) return;
    }
    const u = s.repos.users.getById(w.userId);
    const L = TX[langOf(u)];
    await s.nudges.propose({
      userId: w.userId, kind: 'watcher_hit', dedupeKey: `wh:${w.id}:${sha256Hex(summary).slice(0, 12)}:${w.lastCheckedAt ?? 0}`, refId: w.id,
      why: L.why(w.id, clipText(summary, 200)), body: L.body(clipText(w.target, 120)), score: 1, priority: 'normal', countsAgainstBudget: false,
    });
  }

  /** A failed check: fail_count + 1; after MAX_FAILS in a row the watcher pauses and the owner gets [Resume] [Cancel]. */
  async function fail(w: WatcherRow, t: Ms, next: Ms, reason: string): Promise<void> {
    const fails = repo.recordFailure(w.id, t, next);
    s.log.info({ watcherId: w.id, reason, fails }, 'watcher check failed');
    if (fails >= MAX_FAILS) {
      repo.setWatcherStatus(w.id, 'paused');
      s.scheduler.cancel(dedupe(w.id));
      await notifyPaused({ ...w, lastCheckedAt: t });
    }
  }

  /** The owner can receive nothing (paused Gora or blocked the bot): skip the check, no fetch and no LLM call. */
  function ownerInactive(userId: UserId): boolean {
    const u = s.repos.users.getById(userId);
    return !u || u.status !== 'active' || u.botBlocked;
  }

  async function check(id: string): Promise<void> {
    const w = repo.getWatcher(id);
    if (!w || w.status !== 'active') return;
    const t = now();
    const next = t + w.intervalMin * 60_000;
    if (ownerInactive(w.userId)) {
      // The job keeps its cadence and picks up again by itself after /resume or an unblock (nothing is fetched meanwhile).
      repo.setNextCheck(w.id, next);
      return;
    }
    const f = await fetchState(w);
    if (!f.ok) {
      await fail(w, t, next, f.reason);
      return;
    }
    const hash = sha256Hex(f.hashInput);
    if (hash === w.lastHash) {
      repo.recordCheck(w, { at: t, next });
      return;
    }
    // Conditions see the FULL fetched text; only the stored snapshot is bounded (condition-aware, see snapshotValue).
    const value = snapshotValue(w.condition, f.text, w.kind);
    let ev: Evaluation = evaluateChange(w.condition, w.lastValue, f.text, { kind: w.kind, ...(f.newItems !== undefined ? { newItems: f.newItems } : {}) });
    if (ev.kind === 'needs_semantic') {
      // Hash changed and a baseline exists: the only place a watcher may call the LLM (03 R6 'background').
      if (!s.llmBudget.allow('background')) {
        repo.recordCheck(w, { at: t, next }); // keep the old hash: the change is re-evaluated on the next check
        return;
      }
      const after = f.text.length > SEMANTIC_VALUE_MAX_CHARS ? f.text.slice(0, SEMANTIC_VALUE_MAX_CHARS) : f.text;
      const win = changedWindow(w.lastValue ?? '', after, SEMANTIC_WINDOW);
      let r: { met: boolean; summary: string } | null;
      try {
        r = await s.side.semanticCheck(ev.description, win.before, win.after, { userId: w.userId, priority: 'background' });
      } catch (e) {
        if (e instanceof TransientLlmError || e instanceof AbortedError) {
          // Rate limit / overload / shutdown: not the watcher's fault. Keep the old hash (re-evaluated next time), no failure.
          s.log.info({ watcherId: w.id, err: e.name }, 'watcher semantic check deferred (transient)');
          repo.setNextCheck(w.id, next);
          return;
        }
        await fail(w, t, next, e instanceof Error ? e.name : 'semantic_error');
        return;
      }
      if (r === null) {
        // The side call failed (schema/parse, 4xx, refusal): a failed check, so a persistent failure pauses the watcher
        // instead of spending one LLM call per interval forever. The old hash is kept: the change is re-evaluated.
        await fail(w, t, next, 'semantic_failed');
        return;
      }
      ev = r.met ? { kind: 'hit', summary: clipText(r.summary || ev.description, 200) } : { kind: 'no_hit' };
    }
    repo.recordCheck(w, { at: t, next, hash, value });
    if (ev.kind === 'hit') {
      try {
        await onHit({ ...w, lastCheckedAt: t }, ev.summary);
      } catch (e) {
        s.log.warn({ watcherId: w.id, err: e instanceof Error ? e.name : 'error' }, 'watcher hit delivery failed');
      }
    }
  }

  async function createWatcherWithId(id: string, p: Parameters<MissionInternals['createWatcherWithId']>[1]) {
    const existing = repo.getWatcher(id);
    if (existing) {
      if (existing.userId !== p.userId) throw new WatcherError('not_found', 'watcher id collision');
      return { id, created: false, note: null };
    }
    const u = s.repos.users.getById(p.userId);
    if (!u) throw new WatcherError('not_found', 'unknown user');
    const target = p.target.trim();
    if (p.kind === 'page') {
      const chk = checkWatchUrl(target, { publicUrl: s.config.publicUrl, blockedDomains: s.config.blockedDomains });
      if (!chk.ok) throw new WatcherError('invalid_url', chk.reason);
    } else {
      const st = s.integrations.status(u.id).gmail;
      if (!st.connected || LEVELS[st.level] < LEVELS.read) throw new WatcherError('not_connected', 'Gmail is not connected with read access');
    }
    const min = minInterval(u);
    if (!Number.isFinite(p.intervalMin) || p.intervalMin < min) throw new WatcherError('interval', `the minimum interval on this plan is ${min} minutes`);
    const q = s.quotas.check(u.id, 'watcher');
    if (!q.ok) throw new WatcherError('quota', `watcher limit reached (${q.used}/${q.limit})`);
    let threadId = p.threadId ?? null;
    if (p.missionId) {
      const m = repo.getMission(p.missionId);
      if (!m || m.userId !== u.id) throw new WatcherError('mission', 'unknown mission');
      threadId = m.threadId;
    }
    const t = now();
    repo.insertWatcher({ id, userId: u.id, missionId: p.missionId ?? null, kind: p.kind, target, condition: p.condition, intervalMin: Math.floor(p.intervalMin), nextCheckAt: t, threadId, createdAt: t });
    s.ledger.append({ userId: u.id, actor: 'agent', kind: 'mission', summary: `Watcher ${id} created (${p.kind})`, detail: { watcherId: id, kind: p.kind, intervalMin: p.intervalMin, missionId: p.missionId ?? null } });
    // First check now: it records the baseline (a baseline never counts as a hit).
    let note: string | null = null;
    await check(id);
    const w = repo.getWatcher(id);
    if (w && w.lastValue !== null) {
      const met = currentlyMet(p.condition as WatchCondition, w.lastValue);
      if (met === true) note = 'The condition already holds right now; the watcher reports only new transitions.';
    } else if (w && w.failCount > 0) note = 'The first check failed; the watcher will retry on schedule.';
    if (w && w.status === 'active') schedule(w, w.nextCheckAt);
    return { id, created: true, note };
  }

  const service: WatcherService = {
    async create(p) {
      let id = `W${shortId(6)}`;
      while (repo.getWatcher(id)) id = `W${shortId(6)}`;
      await createWatcherWithId(id, p);
      return { id };
    },
    manage(id, userId: UserId, action) {
      const w = repo.getWatcher(id);
      if (!w || w.userId !== userId) throw new WatcherError('not_found', 'watcher not found');
      if (w.status === 'cancelled' || w.status === 'done') return;
      if (action === 'cancel') {
        repo.setWatcherStatus(id, 'cancelled');
        s.scheduler.cancel(dedupe(id));
      } else if (action === 'pause') {
        repo.setWatcherStatus(id, 'paused');
        s.scheduler.cancel(dedupe(id));
      } else if (w.status === 'paused') {
        repo.setWatcherStatus(id, 'active');
        repo.resetFailures(id);
        schedule(w, now());
      } else {
        // Resume of an 'active' watcher re-arms its job (upsert by dedupe key revives a dead/cancelled job).
        repo.resetFailures(id);
        schedule(w, now());
      }
      s.ledger.append({ userId, actor: 'user', kind: 'mission', summary: `Watcher ${id} ${action}`, detail: { watcherId: id, action } });
    },
    check,
    list(userId) {
      return repo.listWatchers(userId).map(view);
    },
  };

  return {
    service,
    internals: {
      createWatcherWithId,
      watcherMinInterval(userId) {
        const u = s.repos.users.getById(userId);
        return u ? minInterval(u) : s.config.plans.free.watcherMinIntervalMin;
      },
    },
    async job(job) {
      const id = job.refId ?? '';
      try {
        await check(id);
      } catch (e) {
        // Never let a watcher's job die (a dead job leaves an 'active' watcher that is never checked again).
        s.log.warn({ watcherId: id, err: e instanceof Error ? e.name : 'error' }, 'watcher check threw');
        const w = repo.getWatcher(id);
        if (w && w.status === 'active') await fail(w, now(), now() + w.intervalMin * 60_000, e instanceof Error ? e.name : 'error').catch(() => undefined);
      }
      const w = repo.getWatcher(id);
      if (!w || w.status !== 'active') return { status: 'done' };
      return { status: 'reschedule', runAt: Math.max(w.nextCheckAt, now() + 60_000) };
    },
    finishForMission(missionId) {
      for (const w of repo.watchersOfMission(missionId)) {
        if (w.status === 'active' || w.status === 'paused') {
          repo.setWatcherStatus(w.id, 'done');
          s.scheduler.cancel(dedupe(w.id));
        }
      }
    },
  };
}
