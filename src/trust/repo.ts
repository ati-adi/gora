// trust/repo.ts (WP4) — SQL for pending_actions and sentinel_decisions (01 §7.2 WP4 tables). Sealed columns use the
// owner's DEK 'u:<userId>' with AAD '<table>|<column>|<id>'.
import type { ActionClass, ApprovalDiff, Decision, Ms, Services, Target, UserId } from '../contracts/index.ts';
import { canonicalJson } from '../kernel/canonicalJson.ts';
import { newId, shortId } from '../kernel/ids.ts';

export type PaStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'denied' | 'expired' | 'superseded' | 'voided' | 'failed' | 'unknown';
export interface PaRow {
  id: string; user_id: string; conversation_id: string | null; run_id: string | null; tool_use_id: string; version: number; supersedes_id: string | null;
  tool_name: string; action_class: string; risk: number; targets_enc: Uint8Array; target_hmacs_json: string; input_enc: Uint8Array; input_hmac: string;
  diff_enc: Uint8Array; diff_hmac: string; warnings_json: string; grantable: number; ladder_offer: number; source_refs_json: string; status: PaStatus;
  scope_chosen: string | null; card_chat_id: number | null; card_thread_id: number | null; card_message_id: number | null; expires_at: number;
  decided_at: number | null; decided_by_tg_id: number | null; decided_via: string | null; result_enc: Uint8Array | null; created_at: number;
}
export interface PaResult { summary: string; ok: boolean; ledgerSeq?: number; executedAt?: Ms }

/** Diff fields that must stay identical between the card and the execution (TOCTOU). Provenance is not part of it. */
export function diffHmac(s: Services, d: ApprovalDiff): string {
  const stable = { title: d.title, summary: d.summary, rows: d.rows, body: d.body ?? null, targets: d.targets.map((t) => [t.kind, t.value]) };
  return s.crypto.hmac('diff', canonicalJson(stable));
}
export function inputHmac(s: Services, input: unknown): string {
  return s.crypto.hmac('input', canonicalJson(input ?? null));
}

export function createPaRepo(s: Services) {
  const aad = (id: string, col: string) => `pending_actions|${col}|${id}`;
  const dek = (userId: string) => `u:${userId}`;
  const get = (id: string): PaRow | undefined => s.db.prepare('SELECT * FROM pending_actions WHERE id = ?').get<PaRow>(id);
  return {
    get,
    byToolUse(toolUseId: string): PaRow | undefined {
      return s.db.prepare('SELECT * FROM pending_actions WHERE tool_use_id = ?').get<PaRow>(toolUseId);
    },
    newId(): string {
      for (let i = 0; i < 20; i++) {
        const id = shortId(6);
        if (!get(id)) return id;
      }
      throw new Error('pending action id space exhausted');
    },
    insert(p: {
      id: string; userId: UserId; conversationId: string | null; runId: string | null; toolUseId: string; version: number; supersedesId: string | null;
      toolName: string; actionClass: ActionClass; risk: number; targets: Target[]; input: unknown; diff: ApprovalDiff; warnings: string[];
      grantable: boolean; ladderOffer: boolean; sourceRefs: string[]; expiresAt: Ms; card: { chatId: number; threadId?: number };
    }): void {
      s.db
        .prepare(
          `INSERT INTO pending_actions (id, user_id, conversation_id, run_id, tool_use_id, version, supersedes_id, tool_name, action_class, risk,
            targets_enc, target_hmacs_json, input_enc, input_hmac, diff_enc, diff_hmac, warnings_json, grantable, ladder_offer, source_refs_json,
            status, card_chat_id, card_thread_id, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
        )
        .run(
          p.id, p.userId, p.conversationId, p.runId, p.toolUseId, p.version, p.supersedesId, p.toolName, p.actionClass, p.risk,
          s.crypto.sealJson(dek(p.userId), p.targets, aad(p.id, 'targets_enc')), JSON.stringify(p.targets.map((t) => t.hmac)),
          s.crypto.sealJson(dek(p.userId), p.input ?? null, aad(p.id, 'input_enc')), inputHmac(s, p.input),
          s.crypto.sealJson(dek(p.userId), p.diff, aad(p.id, 'diff_enc')), diffHmac(s, p.diff),
          JSON.stringify(p.warnings), p.grantable ? 1 : 0, p.ladderOffer ? 1 : 0, JSON.stringify(p.sourceRefs),
          p.card.chatId, p.card.threadId ?? null, p.expiresAt, s.clock.now(),
        );
    },
    targets(r: PaRow): Target[] {
      return s.crypto.openJson<Target[]>(r.targets_enc, aad(r.id, 'targets_enc'));
    },
    input(r: PaRow): unknown {
      return s.crypto.openJson<unknown>(r.input_enc, aad(r.id, 'input_enc'));
    },
    diff(r: PaRow): ApprovalDiff {
      return s.crypto.openJson<ApprovalDiff>(r.diff_enc, aad(r.id, 'diff_enc'));
    },
    result(r: PaRow): PaResult | null {
      if (!r.result_enc) return null;
      try {
        return s.crypto.openJson<PaResult>(r.result_enc, aad(r.id, 'result_enc'));
      } catch {
        return null;
      }
    },
    /** CAS on status; returns true when exactly one row changed. */
    cas(id: string, from: PaStatus | PaStatus[], to: PaStatus, extra: { scope?: string; decidedBy?: number; via?: 'callback' | 'miniapp' | 'system'; requireUnexpired?: boolean } = {}): boolean {
      const froms = Array.isArray(from) ? from : [from];
      const now = s.clock.now();
      const sets = ['status = ?'];
      const vals: Array<string | number | null> = [to];
      if (extra.scope !== undefined) {
        sets.push('scope_chosen = ?');
        vals.push(extra.scope);
      }
      if (extra.decidedBy !== undefined || extra.via !== undefined) {
        sets.push('decided_at = ?', 'decided_by_tg_id = ?', 'decided_via = ?');
        vals.push(now, extra.decidedBy ?? null, extra.via ?? null);
      }
      let sql = `UPDATE pending_actions SET ${sets.join(', ')} WHERE id = ? AND status IN (${froms.map(() => '?').join(',')})`;
      vals.push(id, ...froms);
      if (extra.requireUnexpired) {
        sql += ' AND expires_at > ?';
        vals.push(now);
      }
      return Number(s.db.prepare(sql).run(...vals).changes) === 1;
    },
    setResult(r: PaRow, res: PaResult): void {
      s.db.prepare('UPDATE pending_actions SET result_enc = ? WHERE id = ?').run(s.crypto.sealJson(dek(r.user_id), res, aad(r.id, 'result_enc')), r.id);
    },
    setCardMessage(id: string, messageId: number): void {
      s.db.prepare('UPDATE pending_actions SET card_message_id = ? WHERE id = ?').run(messageId, id);
    },
    listByUser(userId: UserId, statuses: PaStatus[] | null, limit = 50): PaRow[] {
      if (!statuses) return s.db.prepare('SELECT * FROM pending_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all<PaRow>(userId, limit);
      return s.db
        .prepare(`SELECT * FROM pending_actions WHERE user_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`)
        .all<PaRow>(userId, ...statuses, limit);
    },
    dueForExpiry(now: Ms, limit = 200): PaRow[] {
      return s.db.prepare("SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at LIMIT ?").all<PaRow>(now, limit);
    },
    /** Rows left in 'approved' / 'executing' since before `decidedBefore` (crash or restart mid-execution). */
    stuck(decidedBefore: Ms, limit = 50): PaRow[] {
      return s.db
        .prepare("SELECT * FROM pending_actions WHERE status IN ('approved','executing') AND COALESCE(decided_at, created_at) <= ? ORDER BY decided_at LIMIT ?")
        .all<PaRow>(decidedBefore, limit);
    },
    pendingWithSourceRefs(): PaRow[] {
      return s.db.prepare("SELECT * FROM pending_actions WHERE status = 'pending' AND source_refs_json <> '[]'").all<PaRow>();
    },
    /** Executed / denied history of one (tool, target) for the trust ladder, newest first, within `sinceMs`. */
    history(userId: UserId, toolName: string, hmac: string, sinceMs: Ms): Array<{ status: PaStatus; created_at: number }> {
      return s.db
        .prepare(
          `SELECT status, created_at FROM pending_actions WHERE user_id = ? AND tool_name = ? AND created_at >= ? AND status IN ('executed','denied')
             AND EXISTS (SELECT 1 FROM json_each(target_hmacs_json) WHERE value = ?) ORDER BY created_at DESC`,
        )
        .all<{ status: PaStatus; created_at: number }>(userId, toolName, sinceMs, hmac);
    },
  };
}
export type PaRepo = ReturnType<typeof createPaRepo>;

export function recordDecision(
  s: Services,
  p: { userId: UserId | null; runId: string | null; toolUseId: string | null; pendingActionId?: string | null; toolName: string; actionClass: string; risk: number; d: Decision; tainted: boolean; phase: 'propose' | 'execute' },
): void {
  const grantId = p.d.kind === 'allow' ? (p.d.grantId ?? null) : null;
  s.db
    .prepare(
      `INSERT INTO sentinel_decisions (id, user_id, run_id, tool_use_id, pending_action_id, tool_name, action_class, risk, decision, rule_id, reason, tainted, grant_id, phase, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(newId('sd', s.clock.now()), p.userId, p.runId, p.toolUseId, p.pendingActionId ?? null, p.toolName, p.actionClass, p.risk, p.d.kind, p.d.ruleId, p.d.reason, p.tainted ? 1 : 0, grantId, p.phase, s.clock.now());
}

export function decisionsFor(s: Services, runId: string) {
  return s.db
    .prepare('SELECT tool_use_id, tool_name, decision, rule_id, reason, phase, tainted, created_at FROM sentinel_decisions WHERE run_id = ? ORDER BY created_at, rowid')
    .all<{ tool_use_id: string | null; tool_name: string; decision: 'allow' | 'deny' | 'ask'; rule_id: string; reason: string; phase: 'propose' | 'execute'; tainted: number; created_at: number }>(runId)
    .map((r) => ({ toolUseId: r.tool_use_id, toolName: r.tool_name, decision: r.decision, ruleId: r.rule_id, reason: r.reason, phase: r.phase, tainted: r.tainted === 1, createdAt: r.created_at }));
}
