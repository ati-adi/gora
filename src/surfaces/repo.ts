// src/surfaces/repo.ts (WP7a) — SQL for the WP7a tables (01 §7.1/§7.2): groups, guest_invocations, deeplink_tokens,
// choice_sets, subscriptions, payments. Plus the small cross-WP services built on them (DeepLinkService, ChoiceService,
// GroupService, GuestService). Encrypted columns use AAD '<table>|<column>|<row key>'.
import type { ChoiceService, Clock, Crypto, Db, DeepLinkService, GroupService, GuestService, Ms, PlanId, UserId } from '../contracts/index.ts';
import { randomToken, shortId } from '../kernel/ids.ts';

export type DeepLinkKind = 'guest' | 'me' | 'export';

export function createDeepLinks(db: Db, crypto: Crypto, clock: Clock): DeepLinkService {
  const ins = () => db.prepare('INSERT INTO deeplink_tokens (token, kind, owner_tg_id, payload_enc, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)');
  return {
    create(kind, ownerTgId, payload, ttlMs) {
      const token = randomToken(16);
      const now = clock.now();
      const enc = payload === undefined ? null : crypto.sealJson('sys', payload, `deeplink_tokens|payload_enc|${token}`);
      ins().run(token, kind, ownerTgId, enc, now, now + ttlMs);
      return token;
    },
    consume(token, kind, byTgId) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return { error: 'not_found' };
      const now = clock.now();
      return db.tx(() => {
        const row = db.prepare('SELECT kind, owner_tg_id, payload_enc, expires_at, used_at FROM deeplink_tokens WHERE token = ?').get<{ kind: string; owner_tg_id: number; payload_enc: Uint8Array | null; expires_at: number; used_at: number | null }>(token);
        if (!row || row.kind !== kind) return { error: 'not_found' as const };
        if (byTgId !== undefined && Number(row.owner_tg_id) !== byTgId) return { error: 'not_owner' as const };
        if (row.used_at !== null) return { error: 'used' as const };
        if (Number(row.expires_at) <= now) return { error: 'expired' as const };
        db.prepare('UPDATE deeplink_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL').run(now, token);
        let payload: unknown = null;
        if (row.payload_enc) {
          try {
            payload = crypto.openJson(row.payload_enc, `deeplink_tokens|payload_enc|${token}`);
          } catch {
            payload = null;
          }
        }
        return { ownerTgId: Number(row.owner_tg_id), payload };
      });
    },
  };
}

export interface ChoiceRow { id: string; userId: UserId | null; conversationId: string; options: string[]; chatId: number; messageId: number | null; expiresAt: Ms; usedAt: Ms | null }

export function createChoices(db: Db, crypto: Crypto, clock: Clock): ChoiceService & {
  get(id: string): ChoiceRow | undefined;
  markUsed(id: string): boolean;
} {
  const dekFor = (userId: UserId | null) => (userId ? `u:${userId}` : 'sys');
  return {
    create(p) {
      const id = `c${shortId(10)}`;
      const now = clock.now();
      const enc = crypto.sealJson(dekFor(p.userId), p.options, `choice_sets|options_enc|${id}`);
      db.prepare('INSERT INTO choice_sets (id, user_id, conversation_id, options_enc, chat_id, message_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)').run(id, p.userId, p.conversationId, enc, p.chatId, now, now + p.ttlMs);
      return id;
    },
    attachMessage(setId, messageId) {
      db.prepare('UPDATE choice_sets SET message_id = ? WHERE id = ?').run(messageId, setId);
    },
    get(id) {
      const r = db.prepare('SELECT id, user_id, conversation_id, options_enc, chat_id, message_id, expires_at, used_at FROM choice_sets WHERE id = ?').get<{ id: string; user_id: string | null; conversation_id: string; options_enc: Uint8Array; chat_id: number; message_id: number | null; expires_at: number; used_at: number | null }>(id);
      if (!r) return undefined;
      let options: string[] = [];
      try {
        options = crypto.openJson<string[]>(r.options_enc, `choice_sets|options_enc|${r.id}`);
      } catch {
        options = [];
      }
      return { id: r.id, userId: r.user_id, conversationId: r.conversation_id, options, chatId: Number(r.chat_id), messageId: r.message_id === null ? null : Number(r.message_id), expiresAt: Number(r.expires_at), usedAt: r.used_at === null ? null : Number(r.used_at) };
    },
    markUsed(id) {
      const res = db.prepare('UPDATE choice_sets SET used_at = ? WHERE id = ? AND used_at IS NULL').run(clock.now(), id);
      return Number(res.changes) === 1;
    },
  };
}

export interface GroupRow { chatId: number; type: string; botStatus: 'member' | 'administrator' | 'left' | 'kicked'; addedByTgId: number | null; introMessageId: number | null; memoryGen: number; leftAt: Ms | null; createdAt: Ms }

export function createGroupsRepo(db: Db, crypto: Crypto, clock: Clock): GroupService & {
  get(chatId: number): GroupRow | undefined;
  title(chatId: number): string | null;
  upsertJoined(p: { chatId: number; type: string; status: 'member' | 'administrator'; addedByTgId: number | null; title: string | null }): { isNew: boolean; wasLeft: boolean };
  markLeft(chatId: number, status: 'left' | 'kicked'): void;
  setIntro(chatId: number, messageId: number): void;
  leftBefore(ms: Ms): number[];
  forgetRow(chatId: number): void;
} {
  const get = (chatId: number): GroupRow | undefined => {
    const r = db.prepare('SELECT chat_id, type, bot_status, added_by_tg_id, intro_message_id, memory_gen, left_at, created_at FROM groups WHERE chat_id = ?').get<{ chat_id: number; type: string; bot_status: GroupRow['botStatus']; added_by_tg_id: number | null; intro_message_id: number | null; memory_gen: number; left_at: number | null; created_at: number }>(chatId);
    if (!r) return undefined;
    return { chatId: Number(r.chat_id), type: r.type, botStatus: r.bot_status, addedByTgId: r.added_by_tg_id === null ? null : Number(r.added_by_tg_id), introMessageId: r.intro_message_id === null ? null : Number(r.intro_message_id), memoryGen: Number(r.memory_gen), leftAt: r.left_at === null ? null : Number(r.left_at), createdAt: Number(r.created_at) };
  };
  return {
    get,
    title(chatId) {
      const r = db.prepare('SELECT title_enc FROM groups WHERE chat_id = ?').get<{ title_enc: Uint8Array | null }>(chatId);
      if (!r?.title_enc) return null;
      try {
        return crypto.openText(r.title_enc, `groups|title_enc|${chatId}`);
      } catch {
        return null;
      }
    },
    upsertJoined(p) {
      const now = clock.now();
      const enc = p.title ? crypto.seal(`g:${p.chatId}`, p.title, `groups|title_enc|${p.chatId}`) : null;
      return db.tx(() => {
        const cur = get(p.chatId);
        if (!cur) {
          db.prepare('INSERT INTO groups (chat_id, title_enc, type, bot_status, added_by_tg_id, intro_message_id, memory_gen, last_private_hint_day, created_at, left_at) VALUES (?, ?, ?, ?, ?, NULL, 1, NULL, ?, NULL)').run(p.chatId, enc, p.type, p.status, p.addedByTgId, now);
          return { isNew: true, wasLeft: false };
        }
        const wasLeft = cur.botStatus === 'left' || cur.botStatus === 'kicked';
        db.prepare('UPDATE groups SET title_enc = COALESCE(?, title_enc), type = ?, bot_status = ?, added_by_tg_id = COALESCE(?, added_by_tg_id), left_at = NULL WHERE chat_id = ?').run(enc, p.type, p.status, p.addedByTgId, p.chatId);
        return { isNew: false, wasLeft };
      });
    },
    markLeft(chatId, status) {
      db.prepare('UPDATE groups SET bot_status = ?, left_at = COALESCE(left_at, ?) WHERE chat_id = ?').run(status, clock.now(), chatId);
    },
    setIntro(chatId, messageId) {
      db.prepare('UPDATE groups SET intro_message_id = ? WHERE chat_id = ?').run(messageId, chatId);
    },
    leftBefore(ms) {
      return db.prepare("SELECT chat_id FROM groups WHERE left_at IS NOT NULL AND left_at <= ? AND bot_status IN ('left','kicked')").all<{ chat_id: number }>(ms).map((r) => Number(r.chat_id));
    },
    forgetRow(chatId) {
      db.prepare('DELETE FROM groups WHERE chat_id = ?').run(chatId);
    },
    memoryGen(chatId) {
      return get(chatId)?.memoryGen ?? 1;
    },
    bumpMemoryGen(chatId) {
      return db.tx(() => {
        const cur = get(chatId);
        if (!cur) {
          db.prepare("INSERT INTO groups (chat_id, title_enc, type, bot_status, added_by_tg_id, intro_message_id, memory_gen, last_private_hint_day, created_at, left_at) VALUES (?, NULL, 'supergroup', 'member', NULL, NULL, 2, NULL, ?, NULL)").run(chatId, clock.now());
          return 2;
        }
        db.prepare('UPDATE groups SET memory_gen = memory_gen + 1 WHERE chat_id = ?').run(chatId);
        return cur.memoryGen + 1;
      });
    },
    claimPrivateHint(chatId, localDay) {
      return db.tx(() => {
        const r = db.prepare('SELECT last_private_hint_day FROM groups WHERE chat_id = ?').get<{ last_private_hint_day: string | null }>(chatId);
        if (!r) {
          db.prepare("INSERT INTO groups (chat_id, title_enc, type, bot_status, added_by_tg_id, intro_message_id, memory_gen, last_private_hint_day, created_at, left_at) VALUES (?, NULL, 'supergroup', 'member', NULL, NULL, 1, ?, ?, NULL)").run(chatId, localDay, clock.now());
          return true;
        }
        if (r.last_private_hint_day === localDay) return false;
        db.prepare('UPDATE groups SET last_private_hint_day = ? WHERE chat_id = ?').run(localDay, chatId);
        return true;
      });
    },
  };
}

export type GuestStatus = 'received' | 'placeholder' | 'answered' | 'edited' | 'failed' | 'rate_limited';

export function createGuestRepo(db: Db, clock: Clock): GuestService & {
  insert(p: { guestQueryId: string; callerTgId: number; chatRefHmac: string; status: 'received' | 'rate_limited' }): boolean;
  get(guestQueryId: string): { callerTgId: number; chatRefHmac: string; status: GuestStatus; inlineMessageId: string | null; createdAt: Ms } | undefined;
  countSince(p: { callerTgId?: number; chatRefHmac?: string; since: Ms }): number;
  olderThan(ms: Ms): string[];
  remove(ids: string[]): void;
} {
  return {
    insert(p) {
      const res = db.prepare('INSERT OR IGNORE INTO guest_invocations (guest_query_id, caller_tg_id, chat_ref_hmac, inline_message_id, status, created_at) VALUES (?, ?, ?, NULL, ?, ?)').run(p.guestQueryId, p.callerTgId, p.chatRefHmac, p.status, clock.now());
      return Number(res.changes) === 1;
    },
    get(id) {
      const r = db.prepare('SELECT caller_tg_id, chat_ref_hmac, status, inline_message_id, created_at FROM guest_invocations WHERE guest_query_id = ?').get<{ caller_tg_id: number; chat_ref_hmac: string; status: GuestStatus; inline_message_id: string | null; created_at: number }>(id);
      return r ? { callerTgId: Number(r.caller_tg_id), chatRefHmac: r.chat_ref_hmac, status: r.status, inlineMessageId: r.inline_message_id, createdAt: Number(r.created_at) } : undefined;
    },
    countSince(p) {
      if (p.callerTgId !== undefined) return Number(db.prepare("SELECT COUNT(*) AS n FROM guest_invocations WHERE caller_tg_id = ? AND created_at >= ? AND status != 'rate_limited'").get<{ n: number }>(p.callerTgId, p.since)?.n ?? 0);
      return Number(db.prepare("SELECT COUNT(*) AS n FROM guest_invocations WHERE chat_ref_hmac = ? AND created_at >= ? AND status != 'rate_limited'").get<{ n: number }>(p.chatRefHmac ?? '', p.since)?.n ?? 0);
    },
    mark(guestQueryId, status, inlineMessageId) {
      db.prepare('UPDATE guest_invocations SET status = ?, inline_message_id = COALESCE(?, inline_message_id) WHERE guest_query_id = ?').run(status, inlineMessageId ?? null, guestQueryId);
    },
    olderThan(ms) {
      return db.prepare('SELECT guest_query_id FROM guest_invocations WHERE created_at <= ?').all<{ guest_query_id: string }>(ms).map((r) => r.guest_query_id);
    },
    remove(ids) {
      const del = db.prepare('DELETE FROM guest_invocations WHERE guest_query_id = ?');
      db.tx(() => {
        for (const id of ids) del.run(id);
      });
    },
  };
}

// ── billing tables (WP7): subscriptions + payments

export interface SubscriptionRow { userId: UserId; plan: PlanId; state: 'active' | 'canceled' | 'failed' | 'expired'; invoicePayload: string; chargeId: string; isRecurring: boolean; periodEnd: Ms; graceUntil: Ms | null; updatedAt: Ms }
export interface PaymentRow { chargeId: string; userRef: string; invoicePayload: string; currency: string; totalAmount: number; isRecurring: boolean; isFirstRecurring: boolean; subscriptionExpirationDate: number | null; refundedAt: Ms | null; createdAt: Ms }

type SubSql = { user_id: string; plan: string; state: SubscriptionRow['state']; invoice_payload: string; telegram_payment_charge_id: string; is_recurring: number; period_end: number; grace_until: number | null; updated_at: number };
const subOf = (r: SubSql): SubscriptionRow => ({ userId: r.user_id, plan: r.plan as PlanId, state: r.state, invoicePayload: r.invoice_payload, chargeId: r.telegram_payment_charge_id, isRecurring: !!r.is_recurring, periodEnd: Number(r.period_end), graceUntil: r.grace_until === null ? null : Number(r.grace_until), updatedAt: Number(r.updated_at) });
type PaySql = { telegram_payment_charge_id: string; user_ref: string; invoice_payload: string; currency: string; total_amount: number; is_recurring: number; is_first_recurring: number; subscription_expiration_date: number | null; refunded_at: number | null; created_at: number };
const payOf = (r: PaySql): PaymentRow => ({ chargeId: r.telegram_payment_charge_id, userRef: r.user_ref, invoicePayload: r.invoice_payload, currency: r.currency, totalAmount: Number(r.total_amount), isRecurring: !!r.is_recurring, isFirstRecurring: !!r.is_first_recurring, subscriptionExpirationDate: r.subscription_expiration_date === null ? null : Number(r.subscription_expiration_date), refundedAt: r.refunded_at === null ? null : Number(r.refunded_at), createdAt: Number(r.created_at) });

export function createBillingRepo(db: Db, clock: Clock) {
  return {
    sub(userId: UserId): SubscriptionRow | undefined {
      const r = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get<SubSql>(userId);
      return r ? subOf(r) : undefined;
    },
    upsertSub(s: Omit<SubscriptionRow, 'updatedAt'>): void {
      db.prepare(
        `INSERT INTO subscriptions (user_id, plan, state, invoice_payload, telegram_payment_charge_id, is_recurring, period_end, grace_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, state = excluded.state, invoice_payload = excluded.invoice_payload,
           telegram_payment_charge_id = excluded.telegram_payment_charge_id, is_recurring = excluded.is_recurring,
           period_end = excluded.period_end, grace_until = excluded.grace_until, updated_at = excluded.updated_at`,
      ).run(s.userId, s.plan, s.state, s.invoicePayload, s.chargeId, s.isRecurring ? 1 : 0, s.periodEnd, s.graceUntil, clock.now());
    },
    setSubState(userId: UserId, state: SubscriptionRow['state'], graceUntil: Ms | null): void {
      db.prepare('UPDATE subscriptions SET state = ?, grace_until = ?, updated_at = ? WHERE user_id = ?').run(state, graceUntil, clock.now(), userId);
    },
    /** Subscriptions that may need a downgrade (not yet expired). */
    live(): SubscriptionRow[] {
      return db.prepare("SELECT * FROM subscriptions WHERE state IN ('active','canceled','failed')").all<SubSql>().map(subOf);
    },
    /** INSERT OR IGNORE keyed by charge id: true when the row is new (idempotent across re-delivery, ⚠U12). */
    insertPayment(p: Omit<PaymentRow, 'createdAt' | 'refundedAt'>): boolean {
      const res = db
        .prepare('INSERT OR IGNORE INTO payments (telegram_payment_charge_id, user_ref, invoice_payload, currency, total_amount, is_recurring, is_first_recurring, subscription_expiration_date, refunded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(p.chargeId, p.userRef, p.invoicePayload, p.currency, p.totalAmount, p.isRecurring ? 1 : 0, p.isFirstRecurring ? 1 : 0, p.subscriptionExpirationDate, clock.now());
      return Number(res.changes) === 1;
    },
    payment(chargeId: string): PaymentRow | undefined {
      const r = db.prepare('SELECT * FROM payments WHERE telegram_payment_charge_id = ?').get<PaySql>(chargeId);
      return r ? payOf(r) : undefined;
    },
    paymentsOf(userRef: string): PaymentRow[] {
      return db.prepare('SELECT * FROM payments WHERE user_ref = ? ORDER BY created_at').all<PaySql>(userRef).map(payOf);
    },
    markRefunded(chargeId: string): void {
      db.prepare('UPDATE payments SET refunded_at = COALESCE(refunded_at, ?) WHERE telegram_payment_charge_id = ?').run(clock.now(), chargeId);
    },
    /** /deletemydata: payments survive as a financial record under a pseudonym (01 §11.9). */
    pseudonymize(userRef: string, pseudonym: string): number {
      return Number(db.prepare('UPDATE payments SET user_ref = ? WHERE user_ref = ?').run(pseudonym, userRef).changes);
    },
    deleteSub(userId: UserId): void {
      db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(userId);
    },
    // ── retention (01 §11.9: guest / deep-link rows after 24 h)
    purgeTokens(before: Ms): number {
      return Number(db.prepare('DELETE FROM deeplink_tokens WHERE expires_at <= ? OR created_at <= ?').run(clock.now(), before).changes);
    },
    purgeChoices(now: Ms): number {
      return Number(db.prepare('DELETE FROM choice_sets WHERE expires_at <= ?').run(now).changes);
    },
    choiceSetsOf(userId: UserId): number {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM choice_sets WHERE user_id = ?').get<{ n: number }>(userId)?.n ?? 0);
    },
  };
}
export type BillingRepo = ReturnType<typeof createBillingRepo>;
