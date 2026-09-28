// trust/sentinel.ts (WP4) — the Sentinel service: pure evaluation (rules.ts) over a snapshot built from the DB.
import type { ProposedAction, RunRow, Sentinel, SentinelSnapshot, Services, TaintSource, UserId } from '../contracts/index.ts';
import { memoryEnabled } from '../contracts/index.ts';
import type { GrantsImpl } from './grants.ts';
import { decisionsFor } from './repo.ts';
import { evaluateRules } from './rules.ts';
import { runTaint } from './taint.ts';
import type { TrustedTargetsImpl } from './provenance.ts';

export interface SnapshotHints { chatRef?: string | null; extraTaint?: Iterable<TaintSource> }

export function createSentinel(s: Services, grants: GrantsImpl, tt: TrustedTargetsImpl) {
  const safe = <T,>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };

  const snapshotWith = (userId: UserId | null, run: RunRow | null, a: ProposedAction, hints: SnapshotHints = {}): SentinelSnapshot => {
    const now = s.clock.now();
    const user = userId ? s.repos.users.getById(userId) : undefined;
    const taint = runTaint(s, run, null, hints.extraTaint ?? []);
    const noLevels = { gmail: 'none' as const, gcal: 'none' as const };
    const status = user ? safe(() => s.integrations.status(user.id), null) : null;
    let business: SentinelSnapshot['business'] = null;
    if (user && a.cls.integration === 'business') {
      const ref = hints.chatRef ?? (a.cls.businessRef ? `${a.cls.businessRef.connectionId}:${a.cls.businessRef.chatId}` : null);
      const ctx = ref ? safe(() => s.business.context(user.id, ref), null) : null;
      business = ctx ? { consented: ctx.consented, enabled: ctx.enabled, canReply: ctx.canReply, windowOpen: ctx.windowOpen } : null;
    }
    const trusted = new Set<string>();
    if (user) for (const t of a.targets) if (safe(() => !!tt.sourceOf(user.id, t.hmac), false)) trusted.add(t.hmac);
    return {
      // spec 05 C1: 'blocked' (the owner blocked the bot's DM) only stops Gora-first messages; it never pauses the owner
      userStatus: !user || user.status === 'active' || user.status === 'blocked' ? 'active' : 'paused',
      // spec 05 B1: memory is on unless the owner turned it off (null = never asked = on), incognito, or deleting.
      memoryConsent: user ? memoryEnabled({ ...user, incognitoUntil: null }, now) : false,
      incognito: !!(user?.incognitoUntil && user.incognitoUntil > now),
      tzConfirmed: user ? user.tzSource !== 'default' : false,
      permissions: user ? safe(() => s.repos.users.permissions(user.id), noLevels) : noLevels,
      connected: { gmail: !!status?.gmail?.connected, gcal: !!status?.gcal?.connected },
      grants: user ? grants.active(user.id, a.toolName) : [],
      trustedTargetHmacs: trusted,
      taint,
      quotaOk: (k) => (user ? safe(() => s.quotas.check(user.id, k).ok, true) : true),
      business,
      now,
    };
  };

  const surfaceAllowed = (a: ProposedAction): boolean => {
    const spec = safe(() => s.registry.get(a.toolName), undefined);
    return !!spec && spec.surfaces.includes(a.surface);
  };

  const sentinel: Sentinel = {
    evaluate(a, snap) {
      return evaluateRules(a, snap, { surfaceAllowed: surfaceAllowed(a) });
    },
    snapshot(userId, run, a) {
      return snapshotWith(userId, run, a);
    },
    decisionsFor(runId) {
      return decisionsFor(s, runId);
    },
  };
  return { sentinel, snapshotWith };
}
export type SentinelImpl = ReturnType<typeof createSentinel>;
