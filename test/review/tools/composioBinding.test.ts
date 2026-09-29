// REVIEW (tools): the OAuth callback binds whatever `connected_account_id` arrives in the (unauthenticated) redirect query
// to the user who owns `state` (service.ts:78-106 -> ComposioProvider.completeConnection, composio.ts:72-78). The
// provider only checks the account is ACTIVE; it never checks that the Composio account belongs to that user_id
// (completeConnection is not even given the userId). A Gora user who learns another user's ca_… id (it is logged in
// every composio warn line: path `/api/v3.1/connected_accounts/<id>`) completes their own fresh state with it and
// gets the victim's Gmail/Calendar bound to their account.
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { ComposioProvider } from '../../../src/integrations/composio.ts';
import { testHmac } from '../../harness/s07-cal.ts';

// s07 (plan 08 §4.2): the Composio user_id is an HMAC of Gora's user id, and only the exact status ACTIVE completes.
const cid = (userId: string) => `g_${testHmac.hmac('composio_user', userId).slice(0, 32)}`;

describe('ComposioProvider.completeConnection', () => {
  it('refuses a connected account that belongs to a different user', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/connected_accounts/ca_victim')) {
        return new Response(JSON.stringify({ id: 'ca_victim', status: 'ACTIVE', user_id: cid('u_victim'), toolkit: { slug: 'gmail' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const p = new ComposioProvider({ apiKey: 'ak_k', fetchImpl, clock: new FakeClock(), log: nullLogger, crypto: testHmac });
    // The attacker's own valid state, but the victim's account id in the query string.
    const r = await p.completeConnection({ state: 'attacker-state', connected_account_id: 'ca_victim', status: 'success' }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(r.ok, 'account of u_victim was accepted for another user').toBe(false);
  });

  it('with the state owner passed (as service.ts does): refuses another user or toolkit, accepts the right account', async () => {
    const accounts: Record<string, unknown> = {
      ca_victim: { id: 'ca_victim', status: 'ACTIVE', user_id: cid('u_victim'), toolkit: { slug: 'gmail' } },
      ca_mine_cal: { id: 'ca_mine_cal', status: 'ACTIVE', user_id: cid('u_me'), toolkit: { slug: 'googlecalendar' } },
      ca_mine: { id: 'ca_mine', status: 'ACTIVE', user_id: cid('u_me'), toolkit: { slug: 'gmail' } },
      ca_nouser: { id: 'ca_nouser', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      ca_clear: { id: 'ca_clear', status: 'ACTIVE', user_id: 'u_me', toolkit: { slug: 'gmail' } }, // the internal id in clear is not ours
      ca_inactive: { id: 'ca_inactive', status: 'INACTIVE', user_id: cid('u_me'), toolkit: { slug: 'gmail' } },
    };
    const fetchImpl = (async (url: string) => {
      const id = decodeURIComponent(String(url).split('/').pop() ?? '');
      return accounts[id] ? new Response(JSON.stringify(accounts[id]), { status: 200 }) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const p = new ComposioProvider({ apiKey: 'ak_k', fetchImpl, clock: new FakeClock(), log: nullLogger, crypto: testHmac });
    const expect_ = { userId: 'u_me', kind: 'gmail' as const };
    const attempt = (id: string) => p.completeConnection({ state: 's', connected_account_id: id }, expect_).then(() => true, () => false);
    expect(await attempt('ca_victim')).toBe(false);
    expect(await attempt('ca_mine_cal')).toBe(false);
    expect(await attempt('ca_nouser')).toBe(false);
    expect(await attempt('ca_clear')).toBe(false);
    expect(await attempt('ca_inactive')).toBe(false); // /active/i used to match INACTIVE
    expect(await attempt('ca_mine')).toBe(true);
  });
});
