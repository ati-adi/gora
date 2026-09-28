// src/surfaces/payments.ts (WP7a) — Stars plans (01 F16, §13): invoice links, pre-checkout (no LLM, < 1 s),
// successful_payment / Update.subscription (idempotent by charge id, ⚠U12), cancel, refund, the daily
// subscription_reconcile downgrade, and the exhausted-quota template notice (no LLM).
import type { Message, PreCheckoutQuery } from 'grammy/types';
import type { ChatRef, Ms, PaymentsService, PlanId, QuotaKind, UserId, UserRow } from '../contracts/index.ts';
import { formatDisplay } from '../kernel/timeMath.ts';
import { st } from './strings.ts';
import { cbBtn, enqueueRich, errName, langOf, sendRich, urlBtn, type Keyboard, type Surf } from './util.ts';

export const SUBSCRIPTION_PERIOD_SEC = 2_592_000;
const DAY = 86_400_000;
/** failed renewal → grace (01 §13); an active recurring sub whose renewal has not arrived gets the same grace (⚠U12). */
export const GRACE_MS = 3 * DAY;

export type PaidPlan = Exclude<PlanId, 'free'>;
export function invoicePayload(plan: PaidPlan, userId: UserId): string {
  return `sub:${plan}:v1:${userId}`;
}
export function parseInvoicePayload(p: string): { plan: PaidPlan; userId: UserId } | null {
  const m = /^sub:(plus|pro):v1:([0-9A-Za-z_]{1,64})$/.exec(p);
  return m ? { plan: m[1] as PaidPlan, userId: m[2]! } : null;
}

export interface PaymentsModule extends PaymentsService {
  quotaExceeded(userId: UserId, k: QuotaKind, chat: ChatRef): Promise<void>;
  planCard(user: UserRow, chat: ChatRef, idem: string): Promise<void>;
  sendInvoice(user: UserRow, plan: PaidPlan, chat: ChatRef, idem: string): Promise<void>;
  includedText(lang: string): string;
}

export function createPayments(surf: Surf): PaymentsModule {
  const { s } = surf;
  const answered = new Map<string, Ms>(); // pre_checkout ids already answered (the ingress fast path may answer first)
  const planName = (p: PlanId, lang: string) => st(p === 'plus' ? 'plan_plus' : p === 'pro' ? 'plan_pro' : 'plan_free', lang);
  const dateText = (at: Ms, user: UserRow | undefined) => {
    const tz = user?.tz ?? 'UTC';
    return s.telegram.render.tgTime(Math.floor(at / 1000), 'wDT', formatDisplay(at, tz, langOf(user)));
  };
  const dm = (u: UserRow): ChatRef => ({ chatId: u.dmChatId ?? u.tgUserId });

  const ledger = (userId: UserId, summary: string, detail: Record<string, unknown>) => {
    try {
      s.ledger.append({ userId, actor: 'system', kind: 'payment', summary, detail });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'payments: ledger append failed');
    }
  };

  const includedText = (lang: string): string => {
    const p = s.config.plans;
    const lines = [
      `**${st('whats_included', lang)}**`,
      st('plan_free_line', lang, { turns: p.free.turnsPerDay, searches: p.free.webSearchesPerDay, missions: p.free.activeMissions, watchers: p.free.watchers }),
      ...(['plus', 'pro'] as const).map((k) => st('plan_offer_line', lang, { plan: planName(k, lang), price: p[k].priceXtr, turns: p[k].turnsPerDay, searches: p[k].webSearchesPerDay, missions: p[k].activeMissions, watchers: p[k].watchers })),
      '',
      st('plan_trust_note', lang),
    ];
    return lines.join('\n');
  };

  const svc: PaymentsModule = {
    async invoiceLink(userId, plan) {
      const u = s.repos.users.getById(userId);
      const lang = langOf(u);
      const lim = s.config.plans[plan];
      const name = planName(plan, lang);
      const title = st('invoice_title', lang, { plan: name }).slice(0, 32);
      const description = st('invoice_desc', lang, { turns: lim.turnsPerDay, searches: lim.webSearchesPerDay, missions: lim.activeMissions, watchers: lim.watchers }).slice(0, 255);
      return s.telegram.api.createInvoiceLink(title, description, invoicePayload(plan, userId), '', 'XTR', [{ label: st('invoice_label', lang, { plan: name }), amount: lim.priceXtr }], {
        subscription_period: SUBSCRIPTION_PERIOD_SEC,
      });
    },

    async precheck(q: PreCheckoutQuery) {
      const now = s.clock.now();
      for (const [id, at] of answered) if (now - at > 10 * 60_000) answered.delete(id);
      if (answered.has(q.id)) return;
      answered.set(q.id, now);
      const parsed = parseInvoicePayload(q.invoice_payload);
      const user = s.repos.users.getByTg(q.from.id);
      const lim = parsed ? s.config.plans[parsed.plan] : undefined;
      const ok = !!parsed && !!lim && lim.priceXtr > 0 && !!user && user.id === parsed.userId && user.status !== 'deleting' && q.currency === 'XTR' && q.total_amount === lim.priceXtr;
      try {
        if (ok) await s.telegram.api.answerPreCheckoutQuery(q.id, true);
        else await s.telegram.api.answerPreCheckoutQuery(q.id, false, { error_message: st('precheck_invalid', q.from.language_code) });
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'payments: answerPreCheckoutQuery failed');
      }
    },

    async onSuccessfulPayment(msg: Message) {
      const sp = msg.successful_payment;
      if (!sp || !msg.from) return;
      const user = s.repos.users.getByTg(msg.from.id);
      const parsed = parseInvoicePayload(sp.invoice_payload);
      if (!user || !parsed) {
        surf.log.warn({ hasUser: !!user, parsed: !!parsed }, 'payments: successful_payment without a matching user/payload');
        if (user) surf.billing.insertPayment({ chargeId: sp.telegram_payment_charge_id, userRef: user.id, invoicePayload: sp.invoice_payload, currency: sp.currency, totalAmount: sp.total_amount, isRecurring: !!sp.is_recurring, isFirstRecurring: !!sp.is_first_recurring, subscriptionExpirationDate: sp.subscription_expiration_date ?? null });
        return;
      }
      const now = s.clock.now();
      const periodEnd = sp.subscription_expiration_date ? sp.subscription_expiration_date * 1000 : now + SUBSCRIPTION_PERIOD_SEC * 1000;
      const chargeId = sp.telegram_payment_charge_id;
      const isRenewal = !!sp.is_recurring && !sp.is_first_recurring;
      // Telegram lets a user hold several concurrent Stars subscriptions. Gora keeps exactly one live: a new purchase
      // supersedes (and cancels) the previous one, and a late renewal of a superseded plan never overwrites the plan the
      // user now pays for (it is recorded, and its renewal is canceled).
      const outcome = s.db.tx((): { isNew: boolean; stale: boolean; supersede: string | null } => {
        const inserted = surf.billing.insertPayment({ chargeId, userRef: user.id, invoicePayload: sp.invoice_payload, currency: sp.currency, totalAmount: sp.total_amount, isRecurring: !!sp.is_recurring, isFirstRecurring: !!sp.is_first_recurring, subscriptionExpirationDate: sp.subscription_expiration_date ?? null });
        if (!inserted) return { isNew: false, stale: false, supersede: null }; // re-delivery of a known charge: no-op
        const cur = surf.billing.sub(user.id);
        const curLive = !!cur && cur.state !== 'expired';
        if (isRenewal && cur && curLive && cur.plan !== parsed.plan) return { isNew: true, stale: true, supersede: null };
        const supersede = !isRenewal && cur && curLive && cur.isRecurring && cur.chargeId !== chargeId && (cur.state === 'active' || cur.state === 'failed') ? cur.chargeId : null;
        // Never shorten the current plan's period (an out-of-order older charge must not roll period_end back).
        const end = cur && curLive && cur.plan === parsed.plan ? Math.max(cur.periodEnd, periodEnd) : periodEnd;
        surf.billing.upsertSub({ userId: user.id, plan: parsed.plan, state: 'active', invoicePayload: sp.invoice_payload, chargeId, isRecurring: !!sp.is_recurring, periodEnd: end, graceUntil: null });
        s.repos.users.update(user.id, { plan: parsed.plan });
        return { isNew: true, stale: false, supersede };
      });
      if (!outcome.isNew) return;
      const cancelRenewal = async (id: string, why: string) => {
        try {
          await s.telegram.api.editUserStarSubscription(user.tgUserId, id, true);
          ledger(user.id, `Subscription renewal canceled (${why})`, { state: 'canceled', reason: why, chargeRef: s.crypto.hmac('ledger', id).slice(0, 16) });
        } catch (e) {
          surf.log.warn({ err: errName(e), why }, 'payments: cancel of a superseded subscription failed');
        }
      };
      if (outcome.stale) {
        // A renewal of a subscription the user already replaced: keep the current plan, stop that chain renewing.
        ledger(user.id, `Payment: renewal of superseded ${parsed.plan} (${sp.total_amount} XTR)`, { plan: parsed.plan, amount: sp.total_amount, currency: sp.currency, recurring: true, superseded: true, chargeRef: s.crypto.hmac('ledger', chargeId).slice(0, 16) });
        await cancelRenewal(chargeId, 'superseded');
        return;
      }
      ledger(user.id, `Payment: Gora ${parsed.plan} (${sp.total_amount} XTR)`, { plan: parsed.plan, amount: sp.total_amount, currency: sp.currency, recurring: !!sp.is_recurring, chargeRef: s.crypto.hmac('ledger', chargeId).slice(0, 16) });
      if (outcome.supersede) await cancelRenewal(outcome.supersede, 'replaced');
      const lang = langOf(user);
      const sub = surf.billing.sub(user.id);
      const key = isRenewal ? 'sub_renewed' : 'pay_thanks';
      enqueueRich(surf, { ...dm(user), userId: user.id }, st(key, lang, { plan: planName(parsed.plan, lang), date: dateText(sub?.periodEnd ?? periodEnd, user) }), { idem: `pay:${chargeId}` });
    },

    async onSubscription(u) {
      const user = s.repos.users.getByTg(u.user.id);
      const parsed = parseInvoicePayload(u.invoice_payload);
      if (!user || !parsed) return;
      const now = s.clock.now();
      const lang = langOf(user);
      const cur = surf.billing.sub(user.id);
      if (!cur) {
        surf.log.warn({ state: u.state }, 'payments: subscription update without a subscription row');
        return;
      }
      // An update for a superseded chain (e.g. the 'canceled' echo of the Plus a Pro purchase replaced) never touches
      // the current subscription.
      if (parsed.plan !== cur.plan) return;
      const name = planName(cur.plan, lang);
      if (u.state === 'canceled') {
        if (cur.state === 'canceled') return;
        surf.billing.setSubState(user.id, 'canceled', null);
        ledger(user.id, `Subscription renewal canceled (${cur.plan})`, { plan: cur.plan, state: 'canceled' });
        enqueueRich(surf, { ...dm(user), userId: user.id }, st('sub_canceled', lang, { plan: name, date: dateText(cur.periodEnd, user) }), { idem: `sub:${user.id}:canceled:${cur.periodEnd}` });
      } else if (u.state === 'failed') {
        if (cur.state === 'failed') return;
        const grace = Math.max(now, cur.periodEnd) + GRACE_MS;
        surf.billing.setSubState(user.id, 'failed', grace);
        ledger(user.id, `Subscription renewal failed (${cur.plan})`, { plan: cur.plan, state: 'failed' });
        enqueueRich(surf, { ...dm(user), userId: user.id }, st('sub_failed', lang, { plan: name, date: dateText(grace, user) }), { idem: `sub:${user.id}:failed:${cur.periodEnd}` });
      } else {
        // active: renewed (period_end is extended by the successful_payment that carries the new expiration date).
        const wasExpired = cur.state === 'expired';
        surf.billing.setSubState(user.id, 'active', null);
        if (wasExpired || user.plan !== cur.plan) s.repos.users.update(user.id, { plan: cur.plan });
        if (cur.state !== 'active') ledger(user.id, `Subscription active (${cur.plan})`, { plan: cur.plan, state: 'active' });
      }
    },

    async cancel(userId) {
      const user = s.repos.users.getById(userId);
      const cur = surf.billing.sub(userId);
      if (!user || !cur || cur.state === 'expired' || cur.state === 'canceled') return;
      await s.telegram.api.editUserStarSubscription(user.tgUserId, cur.chargeId, true);
      surf.billing.setSubState(userId, 'canceled', null);
      ledger(userId, `Subscription renewal canceled by user (${cur.plan})`, { plan: cur.plan, state: 'canceled' });
    },

    async reconcile(now) {
      for (const sub of surf.billing.live()) {
        const deadline = sub.state === 'failed' ? (sub.graceUntil ?? sub.periodEnd + GRACE_MS) : sub.state === 'canceled' ? sub.periodEnd : sub.periodEnd + (sub.isRecurring ? GRACE_MS : 0);
        if (now < deadline) continue;
        const user = s.repos.users.getById(sub.userId);
        s.db.tx(() => {
          surf.billing.setSubState(sub.userId, 'expired', null);
          if (user && user.plan !== 'free') s.repos.users.update(sub.userId, { plan: 'free' });
        });
        ledger(sub.userId, `Plan ended (${sub.plan}) → free`, { plan: sub.plan, state: 'expired' });
        if (user && user.status === 'active' && !user.botBlocked) {
          enqueueRich(surf, { ...dm(user), userId: user.id }, st('sub_downgraded', langOf(user), { plan: planName(sub.plan, langOf(user)) }), { idem: `sub:${user.id}:expired:${sub.periodEnd}` });
        }
      }
    },

    status(userId) {
      const u = s.repos.users.getById(userId);
      const sub = surf.billing.sub(userId);
      return { plan: u?.plan ?? 'free', state: sub?.state ?? null, periodEnd: sub?.periodEnd ?? null, graceUntil: sub?.graceUntil ?? null };
    },

    async refund(tgUserId, chargeId) {
      const pay = surf.billing.payment(chargeId);
      if (!pay) throw new Error('refund: unknown charge');
      if (pay.refundedAt !== null) return; // idempotent: never call Telegram twice
      await s.telegram.api.refundStarPayment(tgUserId, chargeId);
      surf.billing.markRefunded(chargeId);
      const user = s.repos.users.getByTg(tgUserId);
      if (!user) return;
      const sub = surf.billing.sub(user.id);
      const parsed = parseInvoicePayload(pay.invoicePayload);
      if (sub && sub.chargeId === chargeId && sub.state !== 'expired') {
        s.db.tx(() => {
          surf.billing.setSubState(user.id, 'expired', null);
          s.repos.users.update(user.id, { plan: 'free' });
        });
      }
      ledger(user.id, `Refund: ${pay.totalAmount} XTR`, { amount: pay.totalAmount, plan: parsed?.plan ?? null, chargeRef: s.crypto.hmac('ledger', chargeId).slice(0, 16) });
      const lang = langOf(user);
      enqueueRich(surf, { ...dm(user), userId: user.id }, st('refunded', lang, { amount: pay.totalAmount, plan: planName(parsed?.plan ?? 'plus', lang) }), { idem: `refund:${chargeId}` });
    },

    async quotaExceeded(userId, k, chat) {
      const user = s.repos.users.getById(userId);
      if (!user) return;
      const lang = langOf(user);
      const q = s.quotas.check(userId, k, 0);
      const what = st(`quota_${k}` as 'quota_turn', lang);
      const when = s.telegram.render.tgTime(Math.floor(q.resetsAt / 1000), 'r', formatDisplay(q.resetsAt, user.tz, lang));
      const text = s.strings.t('quota_exceeded', lang, { what, used: q.used, limit: q.limit, resets: st('quota_resets', lang, { when, tz: user.tz }) });
      const kb: Keyboard = [[cbBtn(surf, s.strings.t('plans_button', lang), 'pl', ['open'], user.tgUserId, 'primary'), cbBtn(surf, st('whats_included', lang), 'pl', ['inc'], user.tgUserId)]];
      const day = new Date(q.resetsAt).toISOString().slice(0, 10);
      enqueueRich(surf, { chatId: chat.chatId, ...(chat.threadId ? { threadId: chat.threadId } : {}), userId }, text, { idem: `quota:${userId}:${k}:${day}:${chat.threadId ?? 0}`, keyboard: kb });
    },

    async planCard(user, chat, idem) {
      const lang = langOf(user);
      const st0 = svc.status(user.id);
      const view = s.quotas.view(user.id);
      const lim = s.config.plans[user.plan];
      const lines = [`⭐ **${st('plan_title', lang, { plan: planName(user.plan, lang) })}**`];
      if (st0.periodEnd && st0.state === 'active') lines.push(st('plan_until', lang, { date: dateText(st0.periodEnd, user) }));
      if (st0.periodEnd && st0.state === 'canceled') lines.push(st('plan_canceled_until', lang, { date: dateText(st0.periodEnd, user) }));
      if (st0.state === 'failed' && st0.graceUntil) lines.push(st('plan_failed_grace', lang, { date: dateText(st0.graceUntil, user) }));
      lines.push(st('plan_usage', lang, { turns: view.turn.used, turnsLimit: lim.turnsPerDay, searches: view.web_search.used, searchLimit: lim.webSearchesPerDay, files: view.file.used, fileLimit: lim.filesPerDay }));
      lines.push('', includedText(lang));
      const kb: Keyboard = [];
      for (const p of ['plus', 'pro'] as const) {
        if (p === user.plan && st0.state === 'active') continue;
        kb.push([cbBtn(surf, st('plan_offer', lang, { plan: planName(p, lang), price: s.config.plans[p].priceXtr }), 'pl', ['buy', p], user.tgUserId, p === 'plus' ? 'primary' : undefined)]);
      }
      if (st0.state === 'active' && user.plan !== 'free') kb.push([cbBtn(surf, st('plan_cancel_button', lang), 'pl', ['cancel'], user.tgUserId, 'danger')]);
      await sendRich(surf, { ...chat, userId: user.id }, lines.join('\n'), { idem, keyboard: kb });
    },

    async sendInvoice(user, plan, chat, idem) {
      const lang = langOf(user);
      const st0 = svc.status(user.id);
      if (user.plan === plan && st0.state === 'active') {
        await sendRich(surf, { ...chat, userId: user.id }, st('plan_already', lang, { plan: planName(plan, lang) }), { idem });
        return;
      }
      let url: string;
      try {
        url = await svc.invoiceLink(user.id, plan);
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'payments: createInvoiceLink failed');
        await sendRich(surf, { ...chat, userId: user.id }, st('something_wrong', lang), { idem });
        return;
      }
      const price = s.config.plans[plan].priceXtr;
      await sendRich(surf, { ...chat, userId: user.id }, st('plan_pay_text', lang, { plan: planName(plan, lang), price }), { idem, keyboard: [[urlBtn(st('plan_pay_button', lang, { price }), url)]] });
    },

    includedText,
  };
  return svc;
}
