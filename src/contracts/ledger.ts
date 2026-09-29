// ── contracts/ledger.ts (WP0, frozen) — 01 §4.4 (+ 'guard_block', 03 R5)
import type { Ms, UserId } from './common.ts';

export type LedgerKind = 'tool_call' | 'data_read' | 'approval_requested' | 'approval_resolved' | 'message_sent' | 'email_sent' | 'draft_created' | 'calendar_changed' | 'memory_saved' | 'memory_forgotten' | 'connection' | 'permission_change' | 'grant_change' | 'business_event' | 'nudge_sent' | 'mission' | 'payment' | 'export' | 'deletion' | 'consent' | 'pause' | 'refusal' | 'fallback_served' | 'undo' | 'settings' | 'guard_block'
  // friend-mode additions (spec 05): C4 a proactive message sent (detail: arm, score, reason; never the text); B4 profile rebuilt
  | 'proactive_sent' | 'profile_updated'
  // s07 (spec 07 A4): one entry per browser action (detail: taskId, host, action kind, ref role/name; never field values
  // of password/payment fields, never typed text of those fields)
  | 'browser_action';
export interface LedgerEntry {
  userId: UserId; actor: 'agent' | 'user' | 'sentinel' | 'system' | 'scheduler'; kind: LedgerKind;
  summary: string; /* never message bodies */
  detail?: Record<string, unknown>; runId?: string; toolUseId?: string; pendingActionId?: string; sourceRef?: string;
}
export interface Ledger {
  append(e: LedgerEntry): number;
  list(userId: UserId, q: { cursor?: number; kinds?: LedgerKind[]; fromMs?: Ms; toMs?: Ms; limit: number }): Array<LedgerEntry & { seq: number; ts: Ms }>;
  verify(userId: UserId): { ok: boolean; brokenAtSeq?: number };
}
