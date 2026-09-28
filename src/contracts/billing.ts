// ── contracts/billing.ts (WP0, frozen) — 01 §4.4
import type { Message, PreCheckoutQuery } from 'grammy/types';
import type { Ms, PlanId, UserId } from './common.ts';

export type QuotaKind = 'turn' | 'web_search' | 'stt_seconds' | 'file' | 'guest_answer' | 'mission' | 'watcher' | 'cost_micros';
export interface PlanLimits {
  priceXtr: number; turnsPerDay: number; webSearchesPerDay: number; sttSecondsPerDay: number; filesPerDay: number; guestAnswersPerDay: number;
  activeMissions: number; watchers: number; watcherMinIntervalMin: number; missionBudgetMicros: number; dailyCostCapMicros: number; nudgeBudgetMax: number;
}
export interface QuotaService {
  check(userId: UserId, k: QuotaKind, amount?: number): { ok: boolean; used: number; limit: number; resetsAt: Ms };
  consume(userId: UserId, k: QuotaKind, amount?: number): void;
  view(userId: UserId): Record<QuotaKind, { used: number; limit: number }>;
  rate(key: string, limit: number, windowMs: number): boolean;
  // ── WP0 additions
  /** WP3 recordUsage (§5.4): adds to usage_daily input/output/cache-read tokens and cost_micros (the cost cap reads it). */
  recordUsage(userId: UserId, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicros: number }): void;
  /** §5.8/§11.8: counts a refusal; more than 5 today starts a 1 h cooldown (returned). */
  recordRefusal(userId: UserId): { today: number; cooldownUntil: Ms | null };
  cooldownUntil(userId: UserId): Ms | null;
  /**
   * `check(u, 'mission'|'watcher')` counts rows in WP6 tables, which WP1 may not query: WP6 registers the counters
   * at factory time (a documented registration exception). Without a counter the check counts 0.
   */
  registerCounter(k: 'mission' | 'watcher', fn: (userId: UserId) => number): void;
}
export interface PaymentsService {
  invoiceLink(userId: UserId, plan: Exclude<PlanId, 'free'>): Promise<string>;
  precheck(q: PreCheckoutQuery): Promise<void>;
  onSuccessfulPayment(msg: Message): Promise<void>;
  onSubscription(u: { user: { id: number }; invoice_payload: string; state: 'canceled' | 'active' | 'failed' }): Promise<void>;
  cancel(userId: UserId): Promise<void>;
  reconcile(now: Ms): Promise<void>;
  /** WP0 addition (Mini App Plan). */
  status(userId: UserId): { plan: PlanId; state: 'active' | 'canceled' | 'failed' | 'expired' | null; periodEnd: Ms | null; graceUntil: Ms | null };
  /**
   * WP0 addition (scripts/admin.ts `refund <tgUserId> <chargeId>`, WP1 → WP7): refundStarPayment, sets
   * payments.refunded_at, downgrades/cancels the plan when the charge is the active subscription, ledger 'payment'.
   * Idempotent: an already refunded charge resolves without calling Telegram again.
   */
  refund(tgUserId: number, chargeId: string): Promise<void>;
}
