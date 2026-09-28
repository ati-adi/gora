// WP7a repos: deep-link tokens (bound, single-use, expiring), choice sets, groups (memory gen, private hint once per
// day), guest invocations (PK conflict = already answered) and billing rows.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createBillingRepo, createChoices, createDeepLinks, createGroupsRepo, createGuestRepo } from '../../../src/surfaces/repo.ts';
import { createFakeCrypto, createFakeKeyStore } from '../../harness/fakes.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';

let t: TmpDb;
let clock: FakeClock;
const crypto = () => createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(7));

beforeEach(() => {
  t = openTmpDb();
  clock = new FakeClock();
});
afterEach(() => t.cleanup());

describe('deep links', () => {
  it('binds to the owner, is single-use and expires', async () => {
    const dl = createDeepLinks(t.db, crypto(), clock);
    const tok = dl.create('guest', 1001, { s: 'split?' }, 24 * 3_600_000);
    expect(tok).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(dl.consume(tok, 'guest', 1002)).toEqual({ error: 'not_owner' });
    expect(dl.consume(tok, 'me', 1001)).toEqual({ error: 'not_found' });
    expect(dl.consume(tok, 'guest', 1001)).toEqual({ ownerTgId: 1001, payload: { s: 'split?' } });
    expect(dl.consume(tok, 'guest', 1001)).toEqual({ error: 'used' });
    const t2 = dl.create('me', 1001, { q: 'x' }, 60_000);
    await clock.advance(60_001);
    expect(dl.consume(t2, 'me', 1001)).toEqual({ error: 'expired' });
    expect(dl.consume('nope!', 'me', 1001)).toEqual({ error: 'not_found' });
  });

  it('payload is stored encrypted', () => {
    const dl = createDeepLinks(t.db, crypto(), clock);
    dl.create('guest', 1, { s: 'SECRET-CANARY' }, 1000);
    const row = t.db.prepare('SELECT payload_enc FROM deeplink_tokens').get<{ payload_enc: Uint8Array }>()!;
    expect(Buffer.from(row.payload_enc).toString('utf8')).not.toContain('SECRET-CANARY');
  });
});

describe('choice sets', () => {
  it('create → get → attach → markUsed once', () => {
    const ch = createChoices(t.db, crypto(), clock);
    const id = ch.create({ userId: null, conversationId: 'c1', chatId: 5, options: ['A', 'B'], ttlMs: 60_000 });
    ch.attachMessage(id, 77);
    const row = ch.get(id)!;
    expect(row.options).toEqual(['A', 'B']);
    expect(row.messageId).toBe(77);
    expect(ch.markUsed(id)).toBe(true);
    expect(ch.markUsed(id)).toBe(false);
    expect(ch.get(id)!.usedAt).not.toBeNull();
  });
});

describe('groups', () => {
  it('memory gen, private hint once per local day, join/leave', () => {
    const g = createGroupsRepo(t.db, crypto(), clock);
    expect(g.upsertJoined({ chatId: -100, type: 'supergroup', status: 'member', addedByTgId: 1, title: 'Friends' })).toEqual({ isNew: true, wasLeft: false });
    expect(g.title(-100)).toBe('Friends');
    expect(g.memoryGen(-100)).toBe(1);
    expect(g.bumpMemoryGen(-100)).toBe(2);
    expect(g.memoryGen(-100)).toBe(2);
    expect(g.claimPrivateHint(-100, '2026-09-28')).toBe(true);
    expect(g.claimPrivateHint(-100, '2026-09-28')).toBe(false);
    expect(g.claimPrivateHint(-100, '2026-09-29')).toBe(true);
    g.markLeft(-100, 'left');
    expect(g.leftBefore(clock.now())).toEqual([-100]);
    expect(g.upsertJoined({ chatId: -100, type: 'supergroup', status: 'member', addedByTgId: 2, title: null })).toEqual({ isNew: false, wasLeft: true });
    expect(g.get(-100)!.leftAt).toBeNull();
  });
});

describe('guest invocations', () => {
  it('a primary-key conflict means already handled; counts per caller and per chat', () => {
    const gi = createGuestRepo(t.db, clock);
    expect(gi.insert({ guestQueryId: 'gq1', callerTgId: 1, chatRefHmac: 'h', status: 'received' })).toBe(true);
    expect(gi.insert({ guestQueryId: 'gq1', callerTgId: 1, chatRefHmac: 'h', status: 'received' })).toBe(false);
    gi.insert({ guestQueryId: 'gq2', callerTgId: 2, chatRefHmac: 'h', status: 'rate_limited' });
    expect(gi.countSince({ callerTgId: 1, since: 0 })).toBe(1);
    expect(gi.countSince({ chatRefHmac: 'h', since: 0 })).toBe(1); // rate_limited rows do not count
    gi.mark('gq1', 'placeholder', 'inl_1');
    expect(gi.get('gq1')).toMatchObject({ status: 'placeholder', inlineMessageId: 'inl_1' });
    gi.mark('gq1', 'edited');
    expect(gi.get('gq1')).toMatchObject({ status: 'edited', inlineMessageId: 'inl_1' });
  });
});

describe('billing', () => {
  it('payments are idempotent by charge id and can be pseudonymized', () => {
    const b = createBillingRepo(t.db, clock);
    const p = { chargeId: 'ch1', userRef: 'U1', invoicePayload: 'sub:plus:v1:U1', currency: 'XTR', totalAmount: 500, isRecurring: true, isFirstRecurring: true, subscriptionExpirationDate: 123 };
    expect(b.insertPayment(p)).toBe(true);
    expect(b.insertPayment(p)).toBe(false);
    expect(b.pseudonymize('U1', 'del:x')).toBe(1);
    expect(b.payment('ch1')!.userRef).toBe('del:x');
    b.markRefunded('ch1');
    const at = b.payment('ch1')!.refundedAt;
    clock.set(clock.now() + 1000);
    b.markRefunded('ch1');
    expect(b.payment('ch1')!.refundedAt).toBe(at);
  });
});
