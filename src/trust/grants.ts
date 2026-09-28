// trust/grants.ts (WP4) — 01 §11.1 grants and the trust ladder.
// '24h' comes from the card button (only when S16 marked the action grantable and the ladder is met); 'always' comes only
// from the Mini App after a step-up (POST /api/grants). Grants never apply in tainted runs (S14, enforced by rules.ts).
import type { GrantService, GrantView, Ms, Services, Target, UserId } from '../contracts/index.ts';
import { newId } from '../kernel/ids.ts';
import type { PaRepo } from './repo.ts';
import { expectedPhrase, type StepUpImpl } from './stepup.ts';

export const LADDER_MIN_APPROVALS = 2;
export const LADDER_WINDOW_MS = 30 * 24 * 3_600_000;
export const GRANT_24H_MS = 24 * 3_600_000;
const LADDER_PROVENANCE: ReadonlySet<Target['provenance']> = new Set(['user', 'memory', 'approved']);

interface GrantRow { id: string; tool_name: string; target_hmac: string; scope: '24h' | 'always'; expires_at: number | null }

export function createGrants(s: Services, pa: PaRepo, stepup: () => StepUpImpl) {
  const aad = (id: string) => `grants|target_enc|${id}`;
  const toView = (r: GrantRow): GrantView => ({ id: r.id, toolName: r.tool_name, targetHmac: r.target_hmac, scope: r.scope, expiresAt: r.expires_at });

  const active = (userId: UserId, toolName?: string): GrantView[] => {
    const now = s.clock.now();
    const rows = toolName
      ? s.db
          .prepare('SELECT id, tool_name, target_hmac, scope, expires_at FROM grants WHERE user_id = ? AND tool_name = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
          .all<GrantRow>(userId, toolName, now)
      : s.db
          .prepare('SELECT id, tool_name, target_hmac, scope, expires_at FROM grants WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC')
          .all<GrantRow>(userId, now);
    return rows.map(toView);
  };

  /** ≥ 2 executed approvals for the same (tool, target) within 30 days, with no denial in between (newer than them). */
  const ladderMet = (userId: UserId, toolName: string, targets: readonly Target[]): boolean => {
    if (targets.length === 0) return false;
    if (!targets.every((t) => LADDER_PROVENANCE.has(t.provenance))) return false;
    const since = s.clock.now() - LADDER_WINDOW_MS;
    return targets.every((t) => {
      let executed = 0;
      for (const h of pa.history(userId, toolName, t.hmac, since)) {
        if (h.status === 'denied') break; // newest first: a denial resets the ladder
        executed++;
      }
      return executed >= LADDER_MIN_APPROVALS;
    });
  };

  const insert = (userId: UserId, toolName: string, t: Target, scope: '24h' | 'always', fromActionId: string | null, stepupGrantId: string | null): string => {
    const now = s.clock.now();
    const id = newId('gr', now);
    s.db
      .prepare('INSERT INTO grants (id, user_id, tool_name, target_hmac, target_enc, scope, expires_at, uses, created_from_action_id, stepup_grant_id, created_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)')
      .run(id, userId, toolName, t.hmac, s.crypto.sealJson(`u:${userId}`, { kind: t.kind, value: t.value }, aad(id)), scope, scope === '24h' ? now + GRANT_24H_MS : null, fromActionId, stepupGrantId, now);
    return id;
  };

  const ledger = (userId: UserId, summary: string, detail: Record<string, unknown>, pendingActionId?: string) => {
    try {
      s.ledger.append({ userId, actor: 'user', kind: 'grant_change', summary, detail, ...(pendingActionId ? { pendingActionId } : {}) });
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'grants: ledger append failed');
    }
  };

  const service: GrantService = {
    list(userId) {
      return active(userId);
    },
    revoke(userId, grantId) {
      const n = Number(s.db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(s.clock.now(), grantId, userId).changes);
      if (n > 0) ledger(userId, 'Grant revoked', { grantId });
      return n > 0;
    },
    async createAlways(userId, pendingActionId, stepupGrantId) {
      const row = pa.get(pendingActionId);
      if (!row || row.user_id !== userId) return { error: 'not_found' as const };
      let targets: Target[];
      try {
        targets = pa.targets(row);
      } catch {
        return { error: 'not_found' as const };
      }
      // S16 eligibility re-checked: send_external, grantable (provenance), and the ladder is met.
      if (row.action_class !== 'send_external' || row.grantable !== 1 || !ladderMet(userId, row.tool_name, targets)) return { error: 'not_eligible' as const };
      // A phrase step-up only counts for the action whose phrase was typed ('ALWAYS <first word of its first target>').
      if (!stepup().consume(userId, stepupGrantId, targets[0] ? expectedPhrase(targets[0].value) : '', row.id)) return { error: 'stepup_invalid' as const };
      let first = '';
      s.db.tx(() => {
        for (const t of targets) {
          const id = insert(userId, row.tool_name, t, 'always', row.id, stepupGrantId);
          if (!first) first = id;
        }
      });
      ledger(userId, `Always-allow grant created for ${row.tool_name}`, { tool: row.tool_name, targets: targets.length, scope: 'always' }, row.id);
      return { id: first };
    },
  };

  return {
    service,
    active,
    ladderMet,
    /** '24h' grants from a card tap; one per target. Returns the first id. */
    create24h(userId: UserId, toolName: string, targets: readonly Target[], fromActionId: string): string | null {
      if (targets.length === 0) return null;
      let first: string | null = null;
      s.db.tx(() => {
        for (const t of targets) {
          const id = insert(userId, toolName, t, '24h', fromActionId, null);
          first ??= id;
        }
      });
      ledger(userId, `24 h grant created for ${toolName}`, { tool: toolName, targets: targets.length, scope: '24h' }, fromActionId);
      return first;
    },
    countUse(grantId: string): void {
      s.db.prepare('UPDATE grants SET uses = uses + 1 WHERE id = ?').run(grantId);
    },
    now(): Ms {
      return s.clock.now();
    },
  };
}
export type GrantsImpl = ReturnType<typeof createGrants>;
