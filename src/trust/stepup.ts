// trust/stepup.ts (WP4) — 01 §11.1 step-up for 'always' grants.
// Biometric path: the Mini App stores a server token with BiometricManager.updateBiometricToken at enrollment and
// releases it after a local biometric check; the server compares HMACs. This proves possession of a device-stored token
// released by an unmodified Telegram client after a local check — NOT biometric attestation.
// Fallback (⚠U20): initData no older than 5 min plus the typed phrase 'ALWAYS <FIRST WORD OF TARGET>'.
import { timingSafeEqual } from 'node:crypto';
import type { Services, StepUpService } from '../contracts/index.ts';
import { newId, randomToken } from '../kernel/ids.ts';

export const STEPUP_GRANT_TTL_MS = 5 * 60_000;
export const PHRASE_MAX_INIT_AGE_MS = 5 * 60_000;

/** 'ALWAYS <FIRST WORD OF targets[0].display>' (upper case). */
export function expectedPhrase(firstTargetDisplay: string): string {
  const word = (firstTargetDisplay ?? '').trim().split(/[\s@.,;:<>()"']+/u).find((w) => w.length > 0) ?? '';
  return `ALWAYS ${word}`.trim().toUpperCase();
}

export function normalizePhrase(p: string): string {
  return (p ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase();
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export type StepUpImpl = StepUpService;

export function createStepUp(s: Services): StepUpImpl {
  const tokenHmac = (token: string) => s.crypto.hmac('content', `stepup:${token}`);
  /**
   * A phrase grant is bound to the phrase it was typed for (⚠U20 is a per-target intent check): its id carries a keyed
   * tag of that phrase, so no extra column is needed and a client cannot re-bind it. consume() must be given the
   * phrase the target action expects; a biometric grant stays unbound.
   */
  // With a pendingActionId (TRUST-11) the tag also covers the action: two targets whose first word matches
  // (anna@x.com / anna@evil.com → 'ALWAYS ANNA') no longer share a grant.
  const bindTag = (base: string, phrase: string, actionId?: string) =>
    s.crypto.hmac('content', actionId ? `stepup-bind:${base}:${normalizePhrase(phrase)}:pa:${actionId}` : `stepup-bind:${base}:${normalizePhrase(phrase)}`).slice(0, 24);
  const grant = (userId: string, method: 'biometric' | 'phrase', boundPhrase?: string, actionId?: string): string => {
    const now = s.clock.now();
    const base = newId('sg', now);
    const id = method === 'phrase' ? `${base}-${bindTag(base, boundPhrase ?? '', actionId)}` : base;
    s.db.prepare('INSERT INTO stepup_grants (id, user_id, method, expires_at, used_at) VALUES (?,?,?,?,NULL)').run(id, userId, method, now + STEPUP_GRANT_TTL_MS);
    return id;
  };
  return {
    enroll(userId) {
      const token = randomToken(32);
      const now = s.clock.now();
      s.db.tx(() => {
        // One enrolled device token at a time: re-enrolling revokes the previous one.
        s.db.prepare('UPDATE stepup_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
        s.db.prepare('INSERT INTO stepup_devices (id, user_id, token_hmac, created_at) VALUES (?,?,?,?)').run(newId('sd', now), userId, tokenHmac(token), now);
      });
      return { token };
    },
    verifyBiometric(userId, token) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
      const h = tokenHmac(token);
      const rows = s.db.prepare('SELECT id, token_hmac FROM stepup_devices WHERE user_id = ? AND revoked_at IS NULL').all<{ id: string; token_hmac: string }>(userId);
      const hit = rows.find((r) => eq(r.token_hmac, h));
      if (!hit) return null;
      s.db.prepare('UPDATE stepup_devices SET last_used_at = ? WHERE id = ?').run(s.clock.now(), hit.id);
      return { grantId: grant(userId, 'biometric') };
    },
    verifyPhrase(userId, typed, expected, initDataAgeMs, pendingActionId) {
      if (!Number.isFinite(initDataAgeMs) || initDataAgeMs < 0 || initDataAgeMs > PHRASE_MAX_INIT_AGE_MS) return null;
      const want = normalizePhrase(expected);
      if (!/^ALWAYS \S+/.test(want)) return null;
      if (!eq(normalizePhrase(typed), want)) return null;
      return { grantId: grant(userId, 'phrase', want, pendingActionId || undefined) };
    },
    /**
     * `expectedPhrase` / `pendingActionId`: the phrase and id of the action the grant is spent on; required for (and
     * checked against) phrase grants. A grant minted with an action id matches only that action; one minted without
     * (a direct service caller) matches any action with the same phrase.
     */
    consume(userId, grantId, expectedPhrase, pendingActionId) {
      const row = s.db.prepare('SELECT method FROM stepup_grants WHERE id = ? AND user_id = ?').get<{ method: 'biometric' | 'phrase' }>(grantId, userId);
      if (!row) return false;
      if (row.method === 'phrase') {
        const cut = grantId.lastIndexOf('-');
        if (cut <= 0 || typeof expectedPhrase !== 'string' || !expectedPhrase) return false;
        const base = grantId.slice(0, cut);
        const tag = grantId.slice(cut + 1);
        const ok = eq(tag, bindTag(base, expectedPhrase)) || (!!pendingActionId && eq(tag, bindTag(base, expectedPhrase, pendingActionId)));
        if (!ok) return false;
      }
      return Number(s.db.prepare('UPDATE stepup_grants SET used_at = ? WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?').run(s.clock.now(), grantId, userId, s.clock.now()).changes) === 1;
    },
  };
}
