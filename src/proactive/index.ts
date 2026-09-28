// proactive/index.ts (WP6b) — createProactiveModule: nudges (NudgeGate, `ng:`), the morning brief, commitments and
// the signal scan. Factory-time registrations only (04 §3 timing rule): job handlers, the sys:proactive_scan cron job,
// the `ng` callback, the 'nudge' outbox sent hook and the privacy hook.
import type { ProactiveModule, Services } from '../contracts/index.ts';
import { createBrief } from './brief.ts';
import { createCommitments } from './commitments.ts';
import { createNudges } from './nudges.ts';
import { createProactiveRepo } from './repo.ts';
import { createSignals, nextScanAt, SCAN_CRON } from './signals.ts';
import { DAY } from './util.ts';

export const NUDGE_RETENTION_MS = 30 * DAY;

export function createProactiveModule(s: Services): ProactiveModule {
  const repo = createProactiveRepo(() => s.db, () => s.crypto);
  const nudges = createNudges(s, repo);
  const commitments = createCommitments(s, repo);
  const signals = createSignals(s, repo);
  const brief = createBrief(s, repo, signals, nudges);

  s.scheduler.register('nudge_deferred', (job) => nudges.jobDeferred(job));
  s.scheduler.register('nudge_ignore', (job) => nudges.jobIgnore(job));
  s.scheduler.register('followup_due', (job) => commitments.jobFollowup(job));
  s.scheduler.register('proactive_scan', (_job, ctx) => signals.job(ctx.now));
  s.scheduler.register('brief', (job, ctx) => brief.job(job, ctx.now));
  s.scheduler.schedule({ kind: 'proactive_scan', runAt: nextScanAt(s.clock.now()), cron: SCAN_CRON, tz: 'UTC', dedupeKey: 'sys:proactive_scan' });

  s.telegram.callbacks.register('ng', (c) => nudges.onCallback(c));
  s.telegram.outbox.onSent('nudge', (refId, sent) => nudges.onSent(refId, sent));

  s.privacyHooks.push({
    name: 'proactive',
    async onDeleteUser(userId) {
      // Rows go with the users FK cascade / WP1's deletion plan; jobs are cancelled here too (belt and braces).
      commitments.cancelJobsOf(userId);
      s.scheduler.cancel(`brief:${userId}`);
      s.repos.kv.set(brief.kvKey(userId), null);
    },
    async exportUser(userId) {
      return {
        nudges: repo.listNudgesForExport(userId, 500).map((n) => ({ id: n.id, kind: n.kind, why: n.why, body: n.body, status: n.status, sentAt: n.sentAt, outcome: n.outcome, createdAt: n.createdAt })),
        nudgePrefs: nudges.service.prefs(userId),
        commitments: repo.listCommitmentsForExport(userId).map((c) => ({ id: c.id, source: c.source, direction: c.direction, text: c.text, counterpart: c.counterpart, dueAt: c.dueAt, status: c.status, createdAt: c.createdAt })),
      };
    },
    async retentionSweep(now) {
      repo.deleteStaleNudges(now - NUDGE_RETENTION_MS);
    },
  });

  return { nudges: nudges.service, brief: brief.service, commitments: commitments.service };
}
