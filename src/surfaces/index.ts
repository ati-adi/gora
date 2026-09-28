// src/surfaces/index.ts (WP7a) — createSurfaces: builds the surfaces module (01 §4.3 "surfaces"; everything under
// src/surfaces/** except business/**) and makes its factory-time registrations: callbacks ob/tz/ch/pl/ct/dl/vo (ob
// only answers old onboarding buttons + the /settings memory toggle: spec 05 A3 removed the onboarding RunHook and
// context part), the group/guest context providers, the subscription_reconcile job (daily cron,
// ⚠U12), and the privacy hook (payments pseudonymized + renewal canceled on deletion; export; 24 h guest/deep-link
// retention; group keys destroyed 7 days after Gora leaves).
import type { Bot } from 'grammy';
import type { ChatRef, JobHandler, Ms, PrivacyHook, Services, SurfacesModule, UserId, UserRow } from '../contracts/index.ts';
import { registerNamed } from '../kernel/registries.ts';
import { createCallbacks } from './callbacks.ts';
import { createCommands } from './commands.ts';
import { createContextProviders } from './context.ts';
import { createDm } from './dm.ts';
import { createGroup } from './group.ts';
import { createGuest } from './guest.ts';
import { registerSurfaceHandlers } from './handlers.ts';
import { createLocation } from './location.ts';
import { createOnboarding, type OnboardingDeps } from './onboarding.ts';
import { createTzGuesser } from './tz.ts';
import { createPayments } from './payments.ts';
import { createBillingRepo, createChoices, createDeepLinks, createGroupsRepo, createGuestRepo } from './repo.ts';
import { createWhy } from './why.ts';
import { errName, type Surf } from './util.ts';

export const RETENTION_GUEST_MS = 24 * 3_600_000;
export const GROUP_SHRED_AFTER_MS = 7 * 86_400_000;
export const RECONCILE_CRON = '10 3 * * *';

/** Next 03:10 UTC strictly after `now`. */
export function nextReconcileAt(now: Ms): Ms {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 10, 0, 0);
  return at > now ? at : at + 86_400_000;
}

export function createSurfaces(s: Services): SurfacesModule {
  const log = s.log.child({ mod: 'surfaces' });
  const surf: Surf = {
    s,
    log,
    deepLinks: createDeepLinks(s.db, s.crypto, s.clock),
    choices: createChoices(s.db, s.crypto, s.clock),
    groups: createGroupsRepo(s.db, s.crypto, s.clock),
    guests: createGuestRepo(s.db, s.clock),
    billing: createBillingRepo(s.db, s.clock),
    bot: null,
  };

  const payments = createPayments(surf);
  const obDeps: OnboardingDeps = { payments, handlePayload: async () => false };
  const ob = createOnboarding(surf, obDeps);
  const location = createLocation(surf, ob);
  const tz = createTzGuesser(surf, (user, zone, source, city) => ob.setTimezone(user, zone, source, city));
  const dm = createDm(surf, { ob, payments, location, tz });
  const guest = createGuest(surf, { dm });
  const group = createGroup(surf, { dm });
  const why = createWhy(surf);
  const commands = createCommands(surf, { ob, payments });
  const callbacks = createCallbacks(surf, { payments });

  obDeps.handlePayload = async (user: UserRow, payload: string, chat: ChatRef, updateId: number | null) => {
    if (payload.startsWith('g_')) {
      await guest.continueGuest(user, payload.slice(2), chat, updateId);
      return true;
    }
    if (payload.startsWith('me_')) {
      await group.continueMe(user, payload.slice(3), chat, updateId);
      return true;
    }
    return false; // grp_, ref_, unknown → welcome back
  };

  // ── callbacks (factory-time registration on the shared registry)
  const reg = s.telegram.callbacks;
  reg.register('ob', ob.onObCallback);
  reg.register('tz', ob.onTzCallback);
  reg.register('ch', callbacks.onChoice);
  reg.register('pl', callbacks.onPlan);
  reg.register('ct', callbacks.onContinue);
  reg.register('dl', commands.onDeleteCallback);
  reg.register('vo', callbacks.onListen);

  // ── context providers (no onboarding RunHook / context part any more: spec 05 A3)
  for (const p of createContextProviders(surf)) registerNamed(s.contextProviders, p);

  // ── subscription_reconcile (daily; ⚠U12)
  const reconcile: JobHandler = async (_job, ctx) => {
    await payments.reconcile(ctx.now);
    return { status: 'done' };
  };
  s.scheduler.register('subscription_reconcile', reconcile);
  s.scheduler.schedule({ kind: 'subscription_reconcile', runAt: nextReconcileAt(s.clock.now()), cron: RECONCILE_CRON, tz: 'UTC', dedupeKey: 'sys:subscription_reconcile' });

  // ── privacy hook
  const pseudonym = (userId: UserId) => `del:${s.crypto.hmac('ledger', `payments:${userId}`).slice(0, 24)}`;
  const hook: PrivacyHook = {
    name: 'surfaces',
    async onDeleteUser(userId, tgUserId) {
      // Cancel every live Stars renewal first (01 §11.9). The subscription row may already be gone and a user may hold
      // several concurrent subscriptions, so the payments rows (never deleted) are the source: the latest unrefunded,
      // unexpired recurring charge of each chain (invoice payload), plus the subscription row's charge.
      const sub = surf.billing.sub(userId);
      const nowSec = s.clock.now() / 1000;
      const latest = new Map<string, string>();
      for (const p of surf.billing.paymentsOf(userId)) {
        if (p.isRecurring && p.refundedAt === null && (p.subscriptionExpirationDate ?? 0) > nowSec) latest.set(p.invoicePayload, p.chargeId);
      }
      const charges = new Set(latest.values());
      if (sub && (sub.state === 'active' || sub.state === 'failed') && sub.isRecurring) charges.add(sub.chargeId);
      for (const chargeId of charges) {
        try {
          await s.telegram.api.editUserStarSubscription(tgUserId, chargeId, true);
        } catch (e) {
          log.warn({ err: errName(e) }, 'surfaces privacy: cancel renewal failed');
        }
      }
      surf.billing.deleteSub(userId);
      surf.billing.pseudonymize(userId, pseudonym(userId));
      for (const k of [`ob:${userId}`, `tzp:${userId}`, `dl:${userId}`, `tzg:${userId}`]) s.repos.kv.set(k, null);
    },
    async exportUser(userId) {
      const sub = surf.billing.sub(userId);
      const u = s.repos.users.getById(userId);
      return {
        plan: u?.plan ?? 'free',
        onboardingStep: u?.onboardingStep ?? null,
        subscription: sub ? { plan: sub.plan, state: sub.state, periodEnd: sub.periodEnd, graceUntil: sub.graceUntil, recurring: sub.isRecurring } : null,
        payments: surf.billing.paymentsOf(userId).map((p) => ({ chargeId: p.chargeId, amount: p.totalAmount, currency: p.currency, recurring: p.isRecurring, refundedAt: p.refundedAt, createdAt: p.createdAt })),
      };
    },
    async retentionSweep(now) {
      const old = surf.guests.olderThan(now - RETENTION_GUEST_MS);
      if (old.length) surf.guests.remove(old);
      surf.billing.purgeTokens(now - RETENTION_GUEST_MS);
      surf.billing.purgeChoices(now);
      for (const chatId of surf.groups.leftBefore(now - GROUP_SHRED_AFTER_MS)) {
        try {
          const conv = s.repos.conversations.byScopeKey(`grp:${chatId}`);
          if (conv && conv.status !== 'purged') await s.privacy.shredConversation(conv.id, 'group_left');
        } catch (e) {
          log.warn({ err: errName(e) }, 'surfaces retention: group conversation shred failed');
        }
        // Group transcripts (every thread), group memory and the title all live under 'grp:<chatId>' DEKs.
        s.crypto.destroyOwner(`grp:${chatId}`);
        surf.groups.forgetRow(chatId);
      }
    },
  };
  s.privacyHooks.push(hook);

  return {
    registerHandlers(bot: Bot) {
      registerSurfaceHandlers(surf, bot, { ob, dm, commands, why, guest, group, callbacks, payments });
    },
    payments,
    notices: ob.notices,
    deepLinks: surf.deepLinks,
    choices: surf.choices,
    groups: surf.groups,
    guests: surf.guests,
  };
}
