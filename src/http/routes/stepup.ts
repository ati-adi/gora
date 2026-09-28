// http/routes/stepup.ts (WP8) — step-up for `always` grants (01 §11.1, ⚠U20):
//   POST /api/stepup/enroll                        high  → {token}: the Mini App stores it with
//        BiometricManager.updateBiometricToken (needs a local biometric check); re-enrolling revokes the previous token.
//        `high` (not `write`): whoever can enroll can mint a device token, so enrolling needs initData ≤ 10 min.
//   POST /api/stepup/verify {token}                write → {grantId}: the token released by BiometricManager.authenticate.
//   POST /api/stepup/phrase {phrase, pendingActionId}   high → {grantId}: ⚠U20 fallback, initData ≤ 5 min (WP4 checks the
//        age) plus the typed phrase 'ALWAYS <FIRST WORD OF TARGET>' of that pending action.
// What this proves (shown in the UI): possession of a device-stored token released by an unmodified Telegram client
// after a local biometric check. It is not biometric attestation.
import { z } from 'zod';
import type { Services } from '../../contracts/index.ts';
import { auth, body, err, fresh, ledger, type Api } from '../util.ts';

const Verify = z.object({ token: z.string().min(16).max(256) });
const Phrase = z.object({ phrase: z.string().min(1).max(200), pendingActionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/** 'ALWAYS <first word of the first target's display form>', the same recipe WP4 documents on PendingActionView. */
export function expectedPhrase(firstTargetDisplay: string): string {
  const word = (firstTargetDisplay ?? '').trim().split(/[\s@.,;:<>()"']+/u).find((w) => w.length > 0) ?? '';
  return `ALWAYS ${word}`.trim().toUpperCase();
}

export function registerStepUp(api: Api, s: Services): void {
  api.post('/stepup/enroll', (c) => {
    const stale = fresh(s, c, 'high');
    if (stale) return stale;
    const { user } = auth(c);
    const { token } = s.stepup.enroll(user.id);
    ledger(s, { userId: user.id, actor: 'user', kind: 'settings', summary: 'Step-up device enrolled (Mini App)' });
    return c.json({ token });
  });

  api.post('/stepup/verify', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Verify);
    if (!b.ok) return b.res;
    const r = s.stepup.verifyBiometric(user.id, b.data.token);
    if (!r) return err(c, 403, 'stepup_failed');
    return c.json({ grantId: r.grantId, method: 'biometric' });
  });

  api.post('/stepup/phrase', async (c) => {
    const stale = fresh(s, c, 'high');
    if (stale) return stale;
    const { user, ageMs } = auth(c);
    const b = await body(c, Phrase);
    if (!b.ok) return b.res;
    const pa = s.approvals.get(b.data.pendingActionId, user.id);
    const first = pa?.targets[0]?.display;
    if (!pa || !first) return err(c, 404, 'not_found');
    const r = s.stepup.verifyPhrase(user.id, b.data.phrase, expectedPhrase(first), ageMs, pa.id); // bound to this action (TRUST-11)
    if (!r) return err(c, 403, 'stepup_failed');
    return c.json({ grantId: r.grantId, method: 'phrase' });
  });
}
