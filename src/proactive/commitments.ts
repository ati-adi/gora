// proactive/commitments.ts (WP6b) — CommitmentService (F11, §8.3 followup_due). Commitments come from extraction of the
// owner's own DM messages (WP6a memory_extract) and from the owner's outgoing business messages (WP7b triage).
// Each gets a due job: i_owe → at the due time (09:00 local for a date-only due); they_owe → 3 days after it was made
// (or after its due time, whichever is later). The nudge always names its source.
import type { CommitmentService, JobResult, JobRow, Ms, NudgeCandidate, Services, UserRow } from '../contracts/index.ts';
import { newId } from '../kernel/ids.ts';
import { formatDisplay, parseLocal, zonedToInstant } from '../kernel/timeMath.ts';
import type { CommitmentRow, ProactiveRepo } from './repo.ts';
import { clipText, DAY, langOf } from './util.ts';

export const THEY_OWE_STALE_MS = 3 * DAY;
const MAX_TEXT = 300;

/** 'YYYY-MM-DDTHH:mm' or 'YYYY-MM-DD' (→ 09:00) in the owner's zone → instant; null when absent or malformed. */
export function parseDue(dueLocal: string | null | undefined, tz: string): Ms | null {
  if (!dueLocal) return null;
  const v = dueLocal.trim();
  const w = parseLocal(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T09:00` : v.slice(0, 16));
  return w ? zonedToInstant(w, tz).instant : null;
}

export function followupAt(c: Pick<CommitmentRow, 'direction' | 'dueAt' | 'createdAt'>): Ms | null {
  if (c.direction === 'i_owe') return c.dueAt;
  return Math.max(c.createdAt + THEY_OWE_STALE_MS, c.dueAt ?? 0);
}

const T = {
  en: {
    due: (cp: string | null, text: string, due: string) => (cp ? `You told ${cp} you'd ${text} by ${due}.` : `You said you'd ${text} by ${due}.`),
    dueBody: (text: string) => `Due: ${text}`,
    stale: (cp: string | null, text: string, n: number) => `${cp ?? 'Someone'} promised ${text} ${n} days ago.`,
    staleBody: (text: string) => `Still waiting: ${text}`,
    srcDm: 'from your chat with me', srcBiz: 'from a business chat',
  },
  ru: {
    due: (cp: string | null, text: string, due: string) => (cp ? `Вы обещали ${cp}: ${text} — до ${due}.` : `Вы обещали: ${text} — до ${due}.`),
    dueBody: (text: string) => `Срок: ${text}`,
    stale: (cp: string | null, text: string, n: number) => `${cp ?? 'Вам'} обещали: ${text} — ${n} дн. назад.`,
    staleBody: (text: string) => `Всё ещё ждёте: ${text}`,
    srcDm: 'из нашего чата', srcBiz: 'из бизнес-чата',
  },
} as const;

/** The nudge candidate for a commitment (followup_due and the proactive scan share it; same dedupe key → one nudge). */
export function commitmentCandidate(c: CommitmentRow, u: Pick<UserRow, 'tz' | 'languageCode'>, now: Ms): NudgeCandidate {
  const L = T[langOf(u)];
  const src = c.source === 'business' ? L.srcBiz : L.srcDm;
  const text = clipText(c.text, 200);
  const cp = c.counterpart ? clipText(c.counterpart, 60) : null;
  if (c.direction === 'i_owe') {
    const due = c.dueAt !== null ? formatDisplay(c.dueAt, u.tz, langOf(u)) : '—';
    return {
      userId: c.userId, kind: 'commitment_due', dedupeKey: `cm:${c.id}:due`, refId: c.id, why: `${L.due(cp, text, due)} (${src})`,
      body: L.dueBody(text), score: c.dueAt !== null && c.dueAt <= now + DAY ? 0.8 : 0.6, priority: 'normal', countsAgainstBudget: true,
    };
  }
  const days = Math.max(1, Math.floor((now - c.createdAt) / DAY));
  return {
    userId: c.userId, kind: 'they_owe_stale', dedupeKey: `cm:${c.id}:stale`, refId: c.id, why: `${L.stale(cp, text, days)} (${src})`,
    body: L.staleBody(text), score: 0.55, priority: 'low', countsAgainstBudget: true,
  };
}

export interface CommitmentInternals { service: CommitmentService; jobFollowup(job: JobRow): Promise<JobResult>; cancelJobsOf(userId: string): void }

export function createCommitments(s: Services, repo: ProactiveRepo): CommitmentInternals {
  function scheduleFollowup(c: CommitmentRow): void {
    const at = followupAt(c);
    if (at === null) return;
    const dedupeKey = `fu:${c.id}`;
    const jobId = s.scheduler.schedule({ kind: 'followup_due', runAt: Math.max(at, s.clock.now()), userId: c.userId, refId: c.id, dedupeKey });
    repo.setCommitmentJob(c.id, jobId);
  }

  const service: CommitmentService = {
    add(p) {
      const u = s.repos.users.getById(p.userId);
      if (!u) throw new Error('commitments.add: unknown user');
      const text = clipText(p.text, MAX_TEXT);
      if (!text) throw new Error('commitments.add: empty text');
      // Re-extraction of the same source message must not create a second commitment.
      const same = repo.sameSource(p.userId, {
        sourceInputId: p.sourceInputId ?? null, connectionId: p.businessConnectionId ?? null, chatId: p.chatId ?? null, sourceMessageId: p.sourceMessageId ?? null,
      });
      const dup = same.find((r) => r.direction === p.direction && r.text.toLowerCase() === text.toLowerCase());
      if (dup) return dup.id;
      const now = s.clock.now();
      const row: CommitmentRow = {
        id: newId('cm', now), userId: p.userId, source: p.source, businessConnectionId: p.businessConnectionId ?? null, chatId: p.chatId ?? null,
        sourceMessageId: p.sourceMessageId ?? null, sourceInputId: p.sourceInputId ?? null, direction: p.direction, text,
        counterpart: p.counterpart ? clipText(p.counterpart, 80) : null, dueAt: parseDue(p.dueLocal, u.tz), status: 'open', jobId: null, createdAt: now,
      };
      repo.insertCommitment(row);
      scheduleFollowup(row);
      return row.id;
    },
    deleteBySourceMessages(connectionId, chatId, messageIds) {
      const rows = repo.bySourceMessages(connectionId, chatId, messageIds);
      for (const r of rows) s.scheduler.cancel(`fu:${r.id}`);
      return repo.deleteCommitments(rows.map((r) => r.id));
    },
  };

  return {
    service,
    async jobFollowup(job) {
      const c = job.refId ? repo.getCommitment(job.refId) : undefined;
      if (!c || (c.status !== 'open' && c.status !== 'nudged')) return { status: 'done' };
      const u = s.repos.users.getById(c.userId);
      if (!u) return { status: 'done' };
      const r = await s.nudges.propose(commitmentCandidate(c, u, s.clock.now()));
      if (r !== 'dropped') repo.setCommitmentStatus(c.id, 'nudged');
      return { status: 'done' };
    },
    cancelJobsOf(userId) {
      for (const id of repo.commitmentJobIds(userId)) s.scheduler.cancel(id);
    },
  };
}
