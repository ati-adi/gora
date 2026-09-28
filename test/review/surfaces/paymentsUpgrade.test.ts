// Review proof (surfaces / payments): buying a second plan while a Stars subscription is live leaves the first
// subscription renewing. Its renewal then overwrites the plan the user now pays for, the newer subscription's charge id
// is lost (so /plan → Cancel and /deletemydata cancel only one of the two), and a deleted user keeps being charged.
import { afterEach, describe, expect, it } from 'vitest';
import { PLANS } from '../../../src/config.ts';
import { invoicePayload } from '../../../src/surfaces/payments.ts';
import { TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, lastButtons, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

const DAY = 86_400_000;
let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function paidPlusThenPro() {
  const app = await createSurfacesApp();
  t = app;
  await app.send(U.start());
  const user = app.s.repos.users.getByTg(TEST_USER.id)!;
  const s = app.s;
  const exp1 = Math.floor((app.clock.now() + 30 * DAY) / 1000);
  await app.send(U.successfulPayment({ payload: invoicePayload('plus', user.id), amount: PLANS.plus.priceXtr, chargeId: 'ch_plus_1', recurring: 'first', expiresSec: exp1 }));
  // /plan still offers Pro while Plus is active, and sendInvoice only refuses the SAME plan.
  await app.send(U.command('plan'));
  expect(lastButtons(app).some((b) => b.data?.startsWith('pl:buy:pro'))).toBe(true);
  await app.advance(DAY);
  const exp2 = Math.floor((app.clock.now() + 30 * DAY) / 1000);
  await app.send(U.successfulPayment({ payload: invoicePayload('pro', user.id), amount: PLANS.pro.priceXtr, chargeId: 'ch_pro_1', recurring: 'first', expiresSec: exp2 }));
  expect(s.repos.users.getById(user.id)!.plan).toBe('pro');
  // The superseded Plus subscription is canceled at once (F1 fix).
  expect(app.tg.byMethod('editUserStarSubscription').map((p) => p.telegram_payment_charge_id)).toEqual(['ch_plus_1']);
  return { app, s, user, exp1 };
}

describe('Stars: upgrading while a subscription is live', () => {
  it('the old Plus renewal must not downgrade a user who now pays for Pro', async () => {
    const { app, s, user, exp1 } = await paidPlusThenPro();
    // 29 days later Telegram renews the Plus subscription the user never canceled (nothing in Gora canceled it).
    await app.send(U.successfulPayment({ payload: invoicePayload('plus', user.id), amount: PLANS.plus.priceXtr, chargeId: 'ch_plus_2', recurring: 'renewal', expiresSec: exp1 + 30 * 86_400 }));
    expect(s.repos.users.getById(user.id)!.plan).toBe('pro');
    expect(s.payments.status(user.id).state).toBe('active');
  });

  it("the superseded plan's 'canceled' echo does not cancel the current subscription", async () => {
    const { app, s, user } = await paidPlusThenPro();
    await app.send(U.subscription('canceled', { payload: invoicePayload('plus', user.id) }));
    expect(s.payments.status(user.id)).toMatchObject({ plan: 'pro', state: 'active' });
  });

  it('/deletemydata cancels every live renewal, not only the last-recorded charge', async () => {
    const { app, s, user } = await paidPlusThenPro();
    const hook = s.privacyHooks.find((h) => h.name === 'surfaces')!;
    await hook.onDeleteUser!(user.id, user.tgUserId);
    const before = 1; // the upgrade already canceled ch_plus_1
    const canceled = app.tg.byMethod('editUserStarSubscription').slice(before).map((p) => p.telegram_payment_charge_id);
    // Both subscriptions are live Telegram subscriptions (ch_plus_1 and ch_pro_1); deletion cancels every live chain.
    expect([...new Set(canceled)].sort()).toEqual(['ch_plus_1', 'ch_pro_1']);
  });
});
