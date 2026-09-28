// 01 §15.2 WP7 payments: pre-checkout with no LLM call; successful_payment → plan; subscription canceled / failed /
// active; the reconcile downgrade (⚠U12: renewals are handled idempotently by charge id). Plus /plan, invoice links,
// cancel, refund idempotency and the quota template (no LLM).
import { afterEach, describe, expect, it } from 'vitest';
import { PLANS } from '../../src/config.ts';
import { GRACE_MS, invoicePayload } from '../../src/surfaces/payments.ts';
import { SURF } from '../../src/surfaces/strings.ts';
import type { FakeQuotas } from '../harness/fakes.ts';
import { OTHER_USER, TEST_USER, U } from '../harness/updates.ts';
import { createSurfacesApp, lastButtons, sentTexts, type SurfacesTestApp } from '../unit/surfaces/env.ts';

const DAY = 86_400_000;
let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup() {
  const app = await createSurfacesApp();
  t = app;
  await app.send(U.start());
  const user = app.s.repos.users.getByTg(TEST_USER.id)!;
  return { app, user, s: app.s };
}

describe('Stars payments', () => {
  it('pre-checkout: answered inline, no LLM; payload, user, plan and price are checked', async () => {
    const { app, user } = await setup();
    const payload = invoicePayload('plus', user.id);
    await app.send(U.preCheckoutQuery({ payload, amount: PLANS.plus.priceXtr, id: 'pcq_ok' }));
    await app.send(U.preCheckoutQuery({ payload, amount: 1, id: 'pcq_price' }));
    await app.send(U.preCheckoutQuery({ payload, amount: PLANS.plus.priceXtr, id: 'pcq_user', user: OTHER_USER }));
    await app.send(U.preCheckoutQuery({ payload: 'garbage', amount: PLANS.plus.priceXtr, id: 'pcq_bad' }));
    await app.send(U.preCheckoutQuery({ payload, amount: PLANS.plus.priceXtr, id: 'pcq_ok' })); // re-delivery: answered once
    const answers = app.tg.byMethod('answerPreCheckoutQuery');
    expect(answers.map((a) => [a.pre_checkout_query_id, a.ok])).toEqual([['pcq_ok', true], ['pcq_price', false], ['pcq_user', false], ['pcq_bad', false]]);
    expect(answers[1]!.error_message).toBe(SURF.precheck_invalid.en);
    expect(app.llm.requests.length + app.llm.createRequests.length + app.llm.parseRequests.length).toBe(0);
  });

  it('successful_payment grants the plan once; subscription canceled/failed/active; reconcile downgrades after grace', async () => {
    const { app, user, s } = await setup();
    const payload = invoicePayload('plus', user.id);
    const exp = Math.floor((app.clock.now() + 30 * DAY) / 1000);
    const pay = U.successfulPayment({ payload, amount: PLANS.plus.priceXtr, chargeId: 'ch_1', recurring: 'first', expiresSec: exp });
    await app.send(pay);
    await app.send({ ...pay, update_id: pay.update_id + 100000 }); // the same charge again (⚠U12)
    expect(s.repos.users.getById(user.id)!.plan).toBe('plus');
    expect(s.payments.status(user.id)).toMatchObject({ plan: 'plus', state: 'active', periodEnd: exp * 1000 });
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM payments').get<{ n: number }>()!.n)).toBe(1);
    expect(sentTexts(app).filter((x) => x.includes('Thank you'))).toHaveLength(1);

    await app.send(U.subscription('canceled', { payload }));
    expect(s.payments.status(user.id).state).toBe('canceled');
    expect(s.repos.users.getById(user.id)!.plan).toBe('plus'); // still active until period_end
    await app.send(U.subscription('active', { payload }));
    expect(s.payments.status(user.id).state).toBe('active');
    await app.send(U.subscription('failed', { payload }));
    const st = s.payments.status(user.id);
    expect(st.state).toBe('failed');
    expect(st.graceUntil).toBe(exp * 1000 + GRACE_MS);

    // a renewal payment arrives later: period extended, state active again
    const exp2 = exp + 30 * 86_400;
    await app.send(U.successfulPayment({ payload, amount: PLANS.plus.priceXtr, chargeId: 'ch_2', recurring: 'renewal', expiresSec: exp2 }));
    expect(s.payments.status(user.id)).toMatchObject({ state: 'active', periodEnd: exp2 * 1000, graceUntil: null });
    expect(sentTexts(app).some((x) => x.includes('renewed'))).toBe(true);

    // reconcile: nothing before period_end + grace; downgrade after
    await s.payments.reconcile(exp2 * 1000 + GRACE_MS - 1);
    expect(s.repos.users.getById(user.id)!.plan).toBe('plus');
    await s.payments.reconcile(exp2 * 1000 + GRACE_MS + 1);
    await app.settle();
    expect(s.repos.users.getById(user.id)!.plan).toBe('free');
    expect(s.payments.status(user.id).state).toBe('expired');
    expect(sentTexts(app).some((x) => x.includes('you’re on Free now'))).toBe(true);
  });

  it('the daily subscription_reconcile job is registered as a system cron', async () => {
    const { s } = await setup();
    const sched = s.scheduler as unknown as { jobs: Map<string, { kind: string; cron?: string | null; dedupeKey?: string }> };
    const job = [...sched.jobs.values()].find((j) => j.kind === 'subscription_reconcile');
    expect(job?.dedupeKey).toBe('sys:subscription_reconcile');
    expect(job?.cron).toBe('10 3 * * *');
  });

  it('/plan offers invoices; cancel uses editUserStarSubscription; refund is idempotent', async () => {
    const { app, user, s } = await setup();
    await app.send(U.command('plan'));
    const card = app.lastCard();
    expect(card.markdown).toContain('Your plan: Free');
    expect(card.markdown).toContain(SURF.plan_trust_note.en);
    await app.tap(lastButtons(app).find((b) => b.data?.startsWith('pl:buy:plus'))!.data!);
    const link = app.tg.byMethod('createInvoiceLink').at(-1)!;
    expect(link).toMatchObject({ currency: 'XTR', payload: invoicePayload('plus', user.id), subscription_period: 2_592_000 });
    expect(link.prices).toEqual([{ label: 'Gora Plus · 30 days', amount: PLANS.plus.priceXtr }]);
    expect(lastButtons(app)[0]!.url).toBeDefined();

    const exp = Math.floor((app.clock.now() + 30 * DAY) / 1000);
    await app.send(U.successfulPayment({ payload: invoicePayload('plus', user.id), amount: PLANS.plus.priceXtr, chargeId: 'ch_9', recurring: 'first', expiresSec: exp }));
    await app.send(U.command('plan'));
    await app.tap(lastButtons(app).find((b) => b.data?.startsWith('pl:cancel'))!.data!);
    expect(app.tg.byMethod('editUserStarSubscription').at(-1)).toMatchObject({ user_id: TEST_USER.id, telegram_payment_charge_id: 'ch_9', is_canceled: true });
    expect(s.payments.status(user.id).state).toBe('canceled');

    await s.payments.refund(TEST_USER.id, 'ch_9');
    await s.payments.refund(TEST_USER.id, 'ch_9');
    expect(app.tg.byMethod('refundStarPayment')).toHaveLength(1);
    expect(s.repos.users.getById(user.id)!.plan).toBe('free');
  });

  it('an exhausted quota gets the template notice (exact counts, reset time, ⭐ Plans) with no LLM', async () => {
    const { app, user, s } = await setup();
    const q = s.quotas as FakeQuotas;
    q.limits.turn = 40;
    q.consume(user.id, 'turn', 40);
    await s.notices.quotaExceeded(user.id, 'turn', { chatId: TEST_USER.id });
    await app.settle();
    const md = app.lastCard().markdown;
    expect(md).toContain('free messages (40/40)');
    expect(md).toContain('<tg-time');
    expect(lastButtons(app).map((b) => b.data?.split(/[:|]/).slice(0, 2).join(':'))).toEqual(['pl:open', 'pl:inc']);
    expect(app.llm.requests).toHaveLength(0);
  });
});
