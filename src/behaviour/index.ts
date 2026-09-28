// behaviour/index.ts (friend set B, spec 05 §C) — createBehaviourModule: SignalsService (C1–C3) and ProactivePolicy (C4)
// over user_signals, user_rhythm, proactive_arms and proactive_log. Factory-time registrations only (04 §3 timing rule):
// the proactive_tick job + its sys cron (every 30 min UTC), the 'proactive' outbox sent hook, the `behaviour` context
// provider (the style line of <user_model>) and the privacy hook (export, delete caches, 90-day retention).
import type { BehaviourModule, Services } from '../contracts/index.ts';
import { LIMITS } from '../config.ts';
import { registerNamed } from '../kernel/registries.ts';
import { createProactiveRepo } from '../proactive/repo.ts';
import { createBehaviourContext } from './context.ts';
import { createPolicy, nextTickAt, TICK_CRON } from './policy.ts';
import { createBehaviourRepo } from './repo.ts';
import { createSignals } from './signals.ts';
import { tokens } from '../memory/text.ts';

const DAY = 86_400_000;

/** Two texts about the same thing: ≥ 2 shared content words, or 1 when either has at most 2. */
export function sharesTopic(a: string, b: string, lang: string): boolean {
  const A = new Set(tokens(a, lang));
  const B = new Set(tokens(b, lang));
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n >= 2 || (n >= 1 && Math.min(A.size, B.size) <= 2);
}

export function createBehaviourModule(s: Services): BehaviourModule {
  const repo = createBehaviourRepo(() => s.db, () => s.crypto);
  const sig = createSignals(s, repo);
  const pol = createPolicy(s, repo, sig, createProactiveRepo(() => s.db, () => s.crypto));

  s.scheduler.register('proactive_tick', (job, ctx) => pol.job(job, ctx));
  s.scheduler.schedule({ kind: 'proactive_tick', runAt: nextTickAt(s.clock.now()), cron: TICK_CRON, tz: 'UTC', dedupeKey: 'sys:proactive_tick' });
  s.telegram.outbox.onSent('proactive', (refId, sent) => pol.onSent(refId, sent));
  registerNamed(s.contextProviders, createBehaviourContext(s));

  registerNamed(s.privacyHooks, {
    name: 'behaviour',
    async onDeleteUser(userId) {
      // rows go with USER_DATA_TABLES (users FK cascade); the in-memory plans / caches and a pending send go here
      s.scheduler.cancel(`pt:${userId}`);
      pol.forgetUser(userId);
      sig.resetCaches();
    },
    async exportUser(userId) {
      const r = repo.getRhythm(userId);
      return {
        signals: repo.signalCounts(userId),
        rhythm: r ? { hourOfWeek: Array.from(r.hist, (v) => Math.round(v * 1000) / 1000), binning: r.style?.utc ? 'utc' : 'local', updatedAt: r.updatedAt } : null,
        style: s.signals.styleHints(userId),
        proactiveArms: [...repo.arms(userId).values()],
        proactiveMessages: repo.logsForExport(userId, 500).map((l) => ({
          id: l.id, contentType: l.contentType, gapBucket: l.gapBucket, score: l.score, sent: l.sent, reason: l.reason, text: l.text,
          createdAt: l.createdAt, sentAt: l.sentAt, repliedAt: l.repliedAt, reward: l.reward,
        })),
      };
    },
    onForget(userId, f) {
      // earlier Gora-first texts written from a now-forgotten fact: emptied (export, the friend check's "recent"
      // messages), and the DM transcript that carries them as <gora_event> rotates without them. A composed text
      // rewords the fact, so besides the fingerprints any text sharing its topic words goes (cheap to lose).
      const lang = s.repos.users.getById(userId)?.languageCode ?? 'en';
      const dropped = repo.scrubTexts(userId, (xs) => f.keep(xs).filter((x) => !f.texts.some((t) => sharesTopic(x, t, lang))));
      if (!dropped.length) return;
      const u = s.repos.users.getById(userId);
      if (!u) return;
      const conv = s.repos.conversations.byScopeKey(s.conversations.scopeKeyOf({ kind: 'dm', tgUserId: u.tgUserId }));
      if (conv) s.runner.requestRotation(conv.id, 'forget', { excludeTexts: dropped });
    },
    async retentionSweep(now) {
      repo.deleteSignalsBefore(now - LIMITS.signalsRetentionDays * DAY);
      repo.deleteLogsBefore(now - LIMITS.signalsRetentionDays * DAY);
    },
  });

  return { signals: sig.service, policy: pol.policy };
}
