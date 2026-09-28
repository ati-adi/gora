// WP1 — 01 §15.2: conversation.create creates epoch 1 and its DEK; append runs the validator in one transaction;
// startEpoch closes the previous epoch; casActiveRun. Plus the users/inputs/runs/kv repos and the WP0 additions.
import { afterEach, describe, expect, it } from 'vitest';
import { DekDestroyedError } from '../../../src/kernel/errors.ts';
import { chat, dbEnv, mkConv, mkUser, type DbEnv } from './env.ts';

let e: DbEnv;
afterEach(() => e?.dispose());

describe('ConversationsRepo', () => {
  it('create() makes epoch 1 and its DEK e:<id>:1, owned by the user', () => {
    e = dbEnv();
    const u = mkUser(e);
    const c = mkConv(e, u.id);
    expect(c.epoch).toBe(1);
    expect(c.status).toBe('active');
    const ep = e.repos.conversations.currentEpoch(c.id);
    expect(ep).toMatchObject({ epoch: 1, dekId: `e:${c.id}:1`, reason: 'initial', nextSeq: 1, closedAt: null, shreddedAt: null });
    expect(e.ks.get(`e:${c.id}:1`)).toBeInstanceOf(Uint8Array);
    // destroyOwner(userId) reaches the epoch DEK
    expect(e.crypto.destroyOwner(u.id)).toBeGreaterThanOrEqual(1);
    expect(e.crypto.isDestroyed(`e:${c.id}:1`)).toBe(true);
  });

  it('group and guest conversations get the grp:/guest owners', () => {
    e = dbEnv();
    const g = mkConv(e, null, { kind: 'group', tgChatId: -1001 });
    const q = mkConv(e, null, { kind: 'guest' });
    expect(e.crypto.destroyOwner('grp:-1001')).toBe(1);
    expect(e.crypto.isDestroyed(`e:${g.id}:1`)).toBe(true);
    expect(e.crypto.destroyOwner('guest')).toBe(1);
    expect(e.crypto.isDestroyed(`e:${q.id}:1`)).toBe(true);
  });

  it('startEpoch closes the previous epoch, creates a fresh DEK and moves the conversation', async () => {
    e = dbEnv();
    const u = mkUser(e);
    const c = mkConv(e, u.id);
    chat(e, c.id, 1, 'q', 'a');
    await e.clock.advance(1000);
    const ep2 = e.repos.conversations.startEpoch(c.id, 'forget', 'handoff', ['web']);
    expect(ep2).toMatchObject({ epoch: 2, reason: 'forget', seedKind: 'handoff', taint: ['web'], nextSeq: 1 });
    expect(e.repos.conversations.get(c.id)!.epoch).toBe(2);
    expect(e.repos.conversations.getEpoch(c.id, 1)!.closedAt).toBe(e.clock.now());
    expect(e.ks.get(`e:${c.id}:2`)).toBeInstanceOf(Uint8Array);
    expect(e.repos.conversations.closedEpochsOlderThan(e.clock.now())).toEqual([{ conversationId: c.id, epoch: 1 }]);
    expect(e.repos.conversations.closedEpochsOlderThan(e.clock.now() - 1)).toEqual([]);
  });

  it('casActiveRun is a compare-and-set', () => {
    e = dbEnv();
    const c = mkConv(e, mkUser(e).id);
    expect(e.repos.conversations.casActiveRun(c.id, null, 'r1')).toBe(true);
    expect(e.repos.conversations.casActiveRun(c.id, null, 'r2')).toBe(false);
    expect(e.repos.conversations.casActiveRun(c.id, 'r2', null)).toBe(false);
    expect(e.repos.conversations.get(c.id)!.activeRunId).toBe('r1');
    expect(e.repos.conversations.casActiveRun(c.id, 'r1', null)).toBe(true);
    expect(e.repos.conversations.get(c.id)!.activeRunId).toBeNull();
  });

  it('updateEpoch seals the handoff summary under the epoch DEK; listByUser orders by activity', async () => {
    e = dbEnv();
    const u = mkUser(e);
    const a = mkConv(e, u.id);
    await e.clock.advance(10);
    const b = mkConv(e, u.id, { kind: 'topic' });
    e.repos.conversations.updateEpoch(a.id, 1, { handoffSummary: 'summary text', inputTokensLast: 42 });
    expect(e.repos.conversations.currentEpoch(a.id)).toMatchObject({ handoffSummary: 'summary text', inputTokensLast: 42 });
    const raw = e.db.prepare('SELECT handoff_summary_enc FROM epochs WHERE conversation_id = ?').get<{ handoff_summary_enc: Uint8Array }>(a.id)!;
    expect(Buffer.from(raw.handoff_summary_enc).includes(Buffer.from('summary text'))).toBe(false);
    expect(e.repos.conversations.listByUser(u.id).map((c) => c.id)).toEqual([b.id, a.id]);
    expect(e.repos.conversations.byScopeKey(a.scopeKey)!.id).toBe(a.id);
  });
});

describe('MessagesRepo', () => {
  it('append runs the injected validator inside the same transaction and assigns seqs', () => {
    e = dbEnv();
    const c = mkConv(e, mkUser(e).id);
    const seen: number[] = [];
    e.repos.messages.setValidator((existing, added) => {
      seen.push(existing.length);
      if (added.some((r) => r.role === 'assistant' && existing.length === 0 && added[0]!.role === 'assistant')) throw new Error('G1: must start with user');
    });
    expect(chat(e, c.id, 1, 'hi', 'hello')).toEqual([1, 2]);
    expect(seen).toEqual([0]);
    expect(() =>
      e.repos.messages.append(c.id, 1, [{ role: 'assistant', kind: 'assistant', content: { role: 'assistant', content: 'x' } }]),
    ).not.toThrow();
    // A throwing validator rolls everything back (no rows, next_seq untouched).
    e.repos.messages.setValidator(() => {
      throw new Error('grammar violation');
    });
    const before = e.repos.conversations.currentEpoch(c.id).nextSeq;
    expect(() => chat(e, c.id, 1, 'q', 'a')).toThrow(/grammar violation/);
    expect(e.repos.conversations.currentEpoch(c.id).nextSeq).toBe(before);
    expect(e.repos.messages.load(c.id, 1)).toHaveLength(3);
  });

  it('content is sealed (no plaintext at rest), rows are append-only, load/last decrypt', () => {
    e = dbEnv();
    const c = mkConv(e, mkUser(e).id);
    chat(e, c.id, 1, 'my secret question', 'answer');
    const rows = e.db.prepare('SELECT content_enc FROM messages').all<{ content_enc: Uint8Array }>();
    for (const r of rows) expect(Buffer.from(r.content_enc).includes(Buffer.from('secret'))).toBe(false);
    expect(() => e.db.prepare('UPDATE messages SET kind = kind').run()).toThrow(/append-only/);
    expect(() => e.db.prepare('DELETE FROM messages').run()).toThrow(/append-only/);
    expect(e.repos.messages.last(c.id, 1)!.content).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] });
    expect(e.repos.messages.load(c.id, 1).map((m) => m.seq)).toEqual([1, 2]);
  });

  it('blobs are sealed; refBlobs is idempotent; a shredded blob reads as undefined', () => {
    e = dbEnv();
    const u = mkUser(e);
    const c = mkConv(e, u.id);
    const id = e.repos.messages.putBlob({ ownerUserId: u.id, dek: `e:${c.id}:1`, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    expect(id).toMatch(/^b_/);
    e.repos.messages.refBlobs(c.id, 1, [id, id]);
    e.repos.messages.refBlobs(c.id, 1, [id]);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM blob_refs').get<{ n: number }>()!.n).toBe(1);
    expect(e.repos.messages.getBlob(id)).toEqual({ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    e.crypto.destroyDek(`e:${c.id}:1`);
    expect(e.repos.messages.getBlob(id)).toBeUndefined();
    expect(() => e.repos.messages.load(c.id, 1)).not.toThrow(); // no messages
  });
});

describe('UsersRepo', () => {
  it('upsertFromTelegram is idempotent and seals the first name; settings/homeCity round-trip', () => {
    e = dbEnv();
    const a = e.repos.users.upsertFromTelegram({ id: 42, first_name: 'Ann', username: 'ann' }, { dmChatId: 42 });
    const b = e.repos.users.upsertFromTelegram({ id: 42, first_name: 'Anna' });
    expect(b.id).toBe(a.id);
    expect(e.repos.users.getByTg(42)!.firstName).toBe('Anna');
    const raw = e.db.prepare('SELECT first_name_enc FROM users').get<{ first_name_enc: Uint8Array }>()!;
    expect(Buffer.from(raw.first_name_enc).includes(Buffer.from('Anna'))).toBe(false);
    expect(e.repos.users.settings(a.id).homeCity).toBeNull();
    e.repos.users.updateSettings(a.id, { homeCity: { name: 'Almaty', lat: 43.2, lon: 76.9 }, nudgeBudget: 2 });
    expect(e.repos.users.settings(a.id)).toMatchObject({ homeCity: { name: 'Almaty', lat: 43.2, lon: 76.9 }, nudgeBudget: 2 });
    e.repos.users.updateSettings(a.id, { homeCity: null });
    expect(e.repos.users.settings(a.id).homeCity).toBeNull();
  });

  it('consents, permissions, list/iterate by keyset', () => {
    e = dbEnv();
    const ids = [1, 2, 3, 4, 5].map((n) => mkUser(e, { tgId: 900 + n }).id);
    e.repos.users.grantConsent({ userId: ids[0]!, kind: 'memory', textVersion: 'v1', via: 'callback' });
    expect(e.repos.users.hasConsent(ids[0]!, 'memory')).toBe(true);
    e.repos.users.revokeConsent(ids[0]!, 'memory');
    expect(e.repos.users.hasConsent(ids[0]!, 'memory')).toBe(false);
    expect(e.repos.users.permissions(ids[0]!)).toEqual({ gmail: 'none', gcal: 'none' });
    e.repos.users.setPermission(ids[0]!, 'gcal', 'draft', 'miniapp');
    expect(e.repos.users.permissions(ids[0]!).gcal).toBe('draft');
    e.repos.users.update(ids[1]!, { status: 'paused' });
    expect(e.repos.users.list({ limit: 2 }).map((u) => u.id)).toEqual([...ids].sort().slice(0, 2));
    expect([...e.repos.users.iterate({ batchSize: 2 })].map((u) => u.id)).toEqual([...ids].sort());
    expect([...e.repos.users.iterate({ status: 'paused' })].map((u) => u.id)).toEqual([ids[1]]);
  });
});

describe('InputsRepo', () => {
  it('add is idempotent per (conv, tgUpdateId, untrusted); pending inputs survive an epoch shred (owner DEK)', () => {
    e = dbEnv();
    const u = mkUser(e);
    const c = mkConv(e, u.id);
    const base = { conversationId: c.id, kind: 'text' as const, author: 'owner' as const, untrusted: false, content: [{ type: 'text' as const, text: 'hi' }], tgUpdateId: 7, tgChatId: 1, tgMessageId: 10, fromTgUserId: 1, replyToCardId: null };
    const a = e.repos.inputs.add(base);
    expect(e.repos.inputs.add(base)).toBe(a);
    const b = e.repos.inputs.add({ ...base, untrusted: true });
    expect(b).not.toBe(a);
    expect(e.repos.inputs.pending(c.id).map((i) => i.id)).toEqual([a, b]);
    e.crypto.destroyDek(`e:${c.id}:1`);
    expect(e.repos.inputs.get(a)!.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(e.repos.inputs.replaceUnconsumed(a, [{ type: 'text', text: 'edited' }])).toBe(true);
    e.repos.inputs.markConsumed([a], 'run1', 1);
    expect(e.repos.inputs.replaceUnconsumed(a, [{ type: 'text', text: 'x' }])).toBe(false);
    expect(e.repos.inputs.consumedBy('run1').map((i) => i.id)).toEqual([a]);
    expect(e.repos.inputs.byTgMessage(c.id, 1, 10)!.id).toBe(a);
    expect(e.repos.inputs.deleteConsumedInEpoch(c.id, 1)).toBe(1);
    e.repos.inputs.addEvent(c.id, 'event text');
    expect(e.repos.inputs.takeEvents(c.id, 'run2')).toEqual(['event text']);
    expect(e.repos.inputs.takeEvents(c.id, 'run3')).toEqual([]);
  });
});

describe('RunsRepo', () => {
  it('create/claim/park/byWaitToken/recoverable/visibleText', () => {
    e = dbEnv();
    const u = mkUser(e);
    const c = mkConv(e, u.id);
    const r = e.repos.runs.create({ conversationId: c.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1 }, maxTokens: 1000, priority: 'background' });
    expect(r).toMatchObject({ state: 'queued', priority: 'background', replyRef: { chatId: 1 } });
    expect(e.repos.runs.claim(r.id, 60_000)!.state).toBe('running');
    expect(e.repos.runs.claim(r.id, 60_000)).toBeUndefined();
    e.repos.runs.update(r.id, { visibleText: 'shown so far', stopCategory: 'user_stop' });
    expect(e.repos.runs.get(r.id)).toMatchObject({ visibleText: 'shown so far', stopCategory: 'user_stop' });
    e.repos.runs.park(r.id, ['approval:p1'], null);
    expect(e.repos.runs.byWaitToken('approval:p1').map((x) => x.id)).toEqual([r.id]);
    e.repos.runs.clearWaits(r.id);
    expect(e.repos.runs.byWaitToken('approval:p1')).toEqual([]);
    e.repos.runs.update(r.id, { state: 'queued' });
    expect(e.repos.runs.recoverable(e.clock.now()).map((x) => x.id)).toContain(r.id);
    e.repos.runs.recordMemoryUses(r.id, ['m1', 'm2']);
    expect(e.repos.runs.memoryUses(r.id).map((m) => m.factId)).toEqual(['m1', 'm2']);
    expect(e.repos.runs.conversationsUsingFact('m2')).toEqual([{ runId: r.id, conversationId: c.id, epoch: 1 }]);
    // visible text is sealed under the epoch DEK: shredding the epoch makes it unreadable, never a crash
    e.crypto.destroyDek(`e:${c.id}:1`);
    expect(e.repos.runs.get(r.id)!.visibleText).toBeNull();
    expect(() => e.crypto.seal(`e:${c.id}:1`, 'x', 'a')).toThrow(DekDestroyedError);
  });

  it('kv round-trips JSON', () => {
    e = dbEnv();
    e.repos.kv.set('bot_flags', { a: 1 });
    expect(e.repos.kv.get('bot_flags')).toEqual({ a: 1 });
    expect(e.repos.kv.get('nope')).toBeUndefined();
  });
});
