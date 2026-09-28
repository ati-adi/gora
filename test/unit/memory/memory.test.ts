// 01 §15.2 WP6: consent and incognito gates; fingerprints block relearning; generation rotation (old DEK destroyed,
// remaining facts readable); scoring; scope isolation (+ forget pipeline steps, confirm, Groq retrieval budget).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { storeOf } from '../../../src/memory/impl.ts';
import { bm25, GROQ_PINNED_TOKENS, GROQ_RETRIEVED_TOKENS, type MemoryStore } from '../../../src/memory/store.ts';
import { fingerprintGrams, normalize, probeGrams, tokens } from '../../../src/memory/text.ts';
import { estimateTokens } from '../../../src/kernel/tokens.ts';
import { makeEnv, type TestEnv } from './env.ts';

let env: TestEnv;
let sch: Scheduler;
let mem: MemoryService;
let st: MemoryStore;

const setup = (o: { provider?: 'groq' | 'anthropic' } = {}) => {
  env = makeEnv(o);
  sch = createScheduler(env.s);
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  mem = createMemoryService(env.s);
  st = storeOf(env.s)!;
};
beforeEach(() => setup());
afterEach(async () => {
  await sch.stop();
  env.close();
});

const fact = (text: string, extra: Partial<Parameters<MemoryService['save']>[1]> = {}) => ({
  text, kind: 'preference' as const, sensitivity: 'normal' as const, explicit: true, authorUserId: null, source: { kind: 'tool_explicit' as const }, ...extra,
});
const saveOk = async (scope: Scope, text: string, extra: Partial<Parameters<MemoryService['save']>[1]> = {}) => {
  const r = await mem.save(scope, fact(text, extra));
  if (!('id' in r)) throw new Error(`denied: ${r.denied}`);
  return r.id;
};

describe('text helpers', () => {
  it('normalizes, shingles and tokenizes (Cyrillic too)', () => {
    expect(normalize('  Café, NOW!  ')).toBe('cafe now');
    expect(fingerprintGrams('one two three four five six')).toEqual(['one two three four five six', 'one two three four five', 'two three four five six']);
    expect(fingerprintGrams('I am vegetarian')).toEqual(['i am vegetarian']);
    expect(probeGrams('a b')).toEqual(['a b', 'a', 'b']);
    expect(tokens('Я вегетарианка и люблю чай', 'ru')).toEqual(['вегета', 'люблю', 'чаи']); // diacritics folded on both sides (й → и)
    expect(tokens('The cats like fish', 'en')).toEqual(['cats', 'like', 'fish']);
  });
});

describe('memory gate (spec 05 B1: on unless turned off or incognito)', () => {
  it('saves for a never-asked user; denies when turned off, during incognito, and in groups unless explicit', async () => {
    const fresh = env.user({ consent: null });
    expect(await mem.save({ kind: 'user', userId: fresh.id }, fact('likes tea'))).toMatchObject({ status: 'active' });
    const no = env.user({ consent: false });
    expect(await mem.save({ kind: 'user', userId: no.id }, fact('likes tea'))).toEqual({ denied: 'consent' });
    const u = env.user();
    env.repos.users.update(u.id, { incognitoUntil: env.clock.now() + 3_600_000 });
    expect(await mem.save({ kind: 'user', userId: u.id }, fact('likes tea'))).toEqual({ denied: 'incognito' });
    env.repos.users.update(u.id, { incognitoUntil: env.clock.now() - 1 });
    expect(await mem.save({ kind: 'user', userId: u.id }, fact('likes tea'))).toMatchObject({ status: 'active' });
    env.repos.users.update(u.id, { status: 'deleting' });
    expect(await mem.save({ kind: 'user', userId: u.id }, fact('likes coffee'))).toEqual({ denied: 'consent' });
    const g: Scope = { kind: 'group', chatId: -100 };
    expect(await mem.save(g, fact('we meet on Fridays', { authorUserId: u.id }))).toEqual({ denied: 'consent' });
    expect(await mem.save(g, fact('we meet on Fridays', { authorUserId: u.id, explicit: false, source: { kind: 'group_explicit' } }))).toEqual({ denied: 'consent' });
    expect(await mem.save(g, fact('we meet on Fridays', { authorUserId: u.id, source: { kind: 'group_explicit' } }))).toMatchObject({ status: 'active' });
  });

  it('no ✓/✗ card for sensitive facts; a tainted proposal still waits for ✓ (confirm activates; reject drops for good)', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const r = await mem.save(sc, fact('has asthma', { sensitivity: 'sensitive', explicit: false, source: { kind: 'user_message' } }));
    expect(r).toMatchObject({ status: 'active' });
    expect(env.outbox.queued).toEqual([]);
    // a proposal from a run that read third-party content (memory_save forcePending) keeps its card
    const p = st.save(sc, fact('wire money to X', { explicit: false, source: { kind: 'user_message' } }), { forcePending: true });
    const id = (p as { id: string }).id;
    expect(p).toMatchObject({ status: 'pending_confirm' });
    const card = env.outbox.queued.at(-1)!;
    expect(card.markdown).toContain('wire money to X');
    const kb = (card.payload['reply_markup'] as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]!;
    expect(kb.map((b) => b.callback_data)).toEqual([`mm:cf:${id}:y|${u.tgUserId}`, `mm:cf:${id}:n|${u.tgUserId}`]);
    expect(await mem.retrieve(sc, 'wire money', 'run_x')).toEqual([]); // pending facts are never used
    await env.tap('mm', ['cf', id, 'y'], u.tgUserId, { chatId: u.dmChatId!, messageId: 7 });
    expect((await mem.list(sc, { limit: 10 })).items.find((f) => f.id === id)).toMatchObject({ status: 'active' });
    const r2 = st.save(sc, fact('takes insulin', { sensitivity: 'sensitive', source: { kind: 'user_message' } }), { forcePending: true });
    await mem.confirm(u.id, [(r2 as { id: string }).id], false);
    expect(st.repo().get((r2 as { id: string }).id)).toMatchObject({ status: 'forgotten', textEnc: null });
    expect(await mem.save(sc, fact('takes insulin'))).toEqual({ denied: 'fingerprint' });
  });

  it('dedupes identical facts and supersedes on overflow only when unpinned', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const a = await saveOk(sc, 'Likes green tea');
    expect(await saveOk(sc, 'likes  green tea!')).toBe(a);
    expect(st.repo().countActive(`user:${u.id}`)).toBe(1);
  });

  it('caps active facts at 2000: the oldest unpinned, least-used fact is superseded', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const first = await saveOk(sc, 'the very first fact');
    await mem.edit(u.id, first, { pinned: true });
    const second = await saveOk(sc, 'the second fact');
    const now = env.clock.now();
    env.db.tx(() => {
      for (let i = 0; i < 1998; i++) {
        st.repo().insert({
          id: `mz${String(i).padStart(5, '0')}`, userId: u.id, scope: `user:${u.id}`, kind: 'fact', textEnc: new Uint8Array([0]), subjectEnc: null, quoteEnc: null, dekGen: 1,
          sensitivity: 'normal', confidence: 1, pinned: false, status: 'active', sourceKind: 'tool_explicit', sourceConversationId: null, sourceInputId: null,
          sourceTgMessageId: null, createdBy: 'model_tool', supersedesId: null, now: now + 1 + i,
        });
      }
    });
    st.invalidate(sc);
    expect(st.repo().countActive(`user:${u.id}`)).toBe(2000);
    await saveOk(sc, 'one more fact');
    expect(st.repo().countActive(`user:${u.id}`)).toBe(2000);
    expect(st.repo().get(second)!.status).toBe('superseded');
    expect(st.repo().get(first)!.status).toBe('active');
  });

  it('a fact counts as used once per run however many context rows the run builds', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const id = await saveOk(sc, 'Name is Aigerim', { kind: 'profile' });
    await mem.retrieve(sc, 'hello', 'run_a');
    await mem.retrieve(sc, 'hello again', 'run_a');
    expect(st.repo().get(id)!.useCount).toBe(1);
    await mem.retrieve(sc, 'hi', 'run_b');
    expect(st.repo().get(id)!.useCount).toBe(2);
  });
});

describe('forget: fingerprints, rotation, rotation requests, ledger', () => {
  it('runs every §9 step and blocks relearning', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const conv = env.dmConv(u);
    const inputId = env.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'I am vegetarian' }], tgUpdateId: null, tgChatId: u.tgUserId, tgMessageId: 5, fromTgUserId: u.tgUserId, replyToCardId: null });
    const gone = await saveOk(sc, 'Is strictly vegetarian and never eats fish or meat', { source: { kind: 'user_message', conversationId: conv.id, inputId } });
    const keep = await saveOk(sc, 'Works as a data engineer', { kind: 'profile' });
    const other = env.dmConv(u, 99);
    const run = env.repos.runs.create({ conversationId: other.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1 }, maxTokens: 1000 });
    expect((await mem.retrieve(sc, 'vegetarian fish', run.id)).map((h) => h.id)).toContain(gone);
    expect(env.keyStore.isDestroyed(`m:${u.id}:1`)).toBe(false);

    const other2 = env.user();
    expect((await mem.forget(sc, { ids: [gone] }, { tgUserId: other2.tgUserId })).forgotten).toEqual([]); // not the owner
    const res = await mem.forget(sc, { ids: [gone] }, { tgUserId: u.tgUserId });
    expect(res.forgotten).toEqual([{ id: gone, preview: expect.stringContaining('vegetarian') }]);
    // 1: text nulled
    expect(st.repo().get(gone)).toMatchObject({ status: 'forgotten', textEnc: null, subjectEnc: null, quoteEnc: null });
    // 2: fingerprints (full text + 5-word shingles)
    const fps = st.repo().fingerprints(`user:${u.id}`);
    for (const g of fingerprintGrams('Is strictly vegetarian and never eats fish or meat')) expect(fps.has(env.crypto.hmac('fp', g))).toBe(true);
    // 3: generation rotated, old DEK destroyed, the remaining fact still readable under the new one
    expect(env.repos.users.getById(u.id)!.memoryGen).toBe(2);
    expect(env.keyStore.isDestroyed(`m:${u.id}:1`)).toBe(true);
    expect(st.repo().get(keep)!.dekGen).toBe(2);
    expect((await mem.list(sc, { limit: 10 })).items.map((f) => f.text)).toEqual(['Works as a data engineer']);
    // 4: the source input is deleted
    expect(env.repos.inputs.get(inputId)).toBeUndefined();
    // 5: the source conversation and every conversation that used it rotate, with the texts excluded
    expect(env.runner.rotations.map((r) => [r.conversationId, r.reason]).sort()).toEqual([[conv.id, 'forget'], [other.id, 'forget']].sort());
    expect(env.runner.rotations[0]!.excludeTexts).toEqual(['Is strictly vegetarian and never eats fish or meat']);
    // 6: ledger with the id only
    const led = env.ledger.entries.filter((e) => e.kind === 'memory_forgotten');
    expect(led).toHaveLength(1);
    expect(JSON.stringify(led[0])).not.toContain('vegetarian');
    // relearning is blocked: exact, re-cased, and via a shared 5-word shingle
    expect(await mem.save(sc, fact('Is strictly vegetarian and never eats fish or meat'))).toEqual({ denied: 'fingerprint' });
    expect(await mem.save(sc, fact('Now: is STRICTLY vegetarian and never eats fish, sadly'))).toEqual({ denied: 'fingerprint' });
    expect(await mem.save(sc, fact('Eats fish on Fridays'))).toMatchObject({ status: 'active' });
    expect(mem.filterFingerprinted(sc, ['The owner is strictly vegetarian and never eats fish.', 'Likes jazz.'])).toEqual(['Likes jazz.']);
    // a second forget rotates again and destroys generation 2
    await mem.forget(sc, { query: 'data engineer' }, { tgUserId: u.tgUserId });
    expect(env.keyStore.isDestroyed(`m:${u.id}:2`)).toBe(true);
    expect(env.repos.users.getById(u.id)!.memoryGen).toBe(3);
    expect((await mem.list(sc, { limit: 10 })).items.map((f) => f.text)).toEqual(['Eats fish on Fridays']);
  });

  it('group forget: only the author or an admin; group generation rotates', async () => {
    const author = env.user();
    const member = env.user();
    const admin = env.user();
    const g: Scope = { kind: 'group', chatId: -555 };
    const id = await saveOk(g, 'The trip budget is 500 dollars', { authorUserId: author.id, source: { kind: 'group_explicit' } });
    expect((await mem.forget(g, { ids: [id] }, { tgUserId: member.tgUserId })).forgotten).toEqual([]);
    env.chatMembers.set(`-555:${admin.tgUserId}`, 'administrator');
    expect((await mem.forget(g, { ids: [id] }, { tgUserId: admin.tgUserId })).forgotten).toHaveLength(1);
    expect(env.groups.memoryGen(-555)).toBe(2);
    expect(env.keyStore.isDestroyed('mg:-555:1')).toBe(true);
  });

  it('forgetConversation forgets every fact from that chat and shreds it', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const conv = env.dmConv(u);
    await saveOk(sc, 'Fact from the chat', { source: { kind: 'user_message', conversationId: conv.id } });
    await saveOk(sc, 'Unrelated fact');
    const shredded: string[] = [];
    (env.s as { privacy: unknown }).privacy = { shredConversation: async (id: string) => void shredded.push(id) };
    await mem.forgetConversation(u.id, conv.id);
    expect((await mem.list(sc, { limit: 10 })).items.map((f) => f.text)).toEqual(['Unrelated fact']);
    expect(shredded).toEqual([conv.id]);
  });
});

describe('retrieval and scoring', () => {
  it('BM25-lite (the lexical leg of the spec 05 B3 hybrid ranking, memory/retrieval.ts)', () => {
    const facts = [{ toks: ['tea', 'green'] }, { toks: ['coffee'] }, { toks: ['tea', 'tea', 'black', 'strong', 'morning'] }];
    const df = new Map([['tea', 2], ['green', 1], ['coffee', 1], ['black', 1], ['strong', 1], ['morning', 1]]);
    const s = bm25(['green', 'tea'], facts, df, 8 / 3);
    expect(s[0]).toBeGreaterThan(s[2]!);
    expect(s[1]).toBe(0);
  });

  it('picks all pinned + profile (≤12) + top 8 matches, capped at 20, and records uses', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const pinned = await saveOk(sc, 'Name is Aigerim');
    await mem.edit(u.id, pinned, { pinned: true });
    const prof: string[] = [];
    for (let i = 0; i < 14; i++) prof.push(await saveOk(sc, `profile item number ${i} alpha${i}`, { kind: 'profile' }));
    const tea: string[] = [];
    for (let i = 0; i < 10; i++) tea.push(await saveOk(sc, `likes tea variety ${i} flavour${i}`));
    await env.clock.advance(400 * 86_400_000); // old facts: recency ≈ 0, so only query matches rank among the others
    const run = env.repos.runs.create({ conversationId: 'c1', userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1 }, maxTokens: 1 });
    const hits = await mem.retrieve(sc, 'which tea do I like', run.id);
    expect(hits).toHaveLength(20);
    expect(hits[0]!.id).toBe(pinned);
    // 1 pinned + 12 profile (of 14) + top 8 others = 21 → capped at 20
    expect(hits.filter((h) => h.kind === 'profile')).toHaveLength(12);
    expect(hits.filter((h) => h.text.startsWith('likes tea'))).toHaveLength(7);
    expect(env.repos.runs.memoryUses(run.id).map((m) => m.factId)).toEqual(hits.map((h) => h.id));
    expect(st.repo().get(pinned)!.useCount).toBe(1);
    expect(await mem.retrieve(sc, 'zebra', 'r2')).toHaveLength(13); // unrelated query: pinned + 12 profile, no others
  });

  it('Groq: the digest fits pinned/profile ≤ 250 tok + retrieved ≤ 300 tok, and others must match the query', async () => {
    await sch.stop();
    env.close();
    setup({ provider: 'groq' });
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    for (let i = 0; i < 12; i++) await saveOk(sc, `profile detail ${i}: ${'lorem ipsum dolor sit amet '.repeat(3)}`, { kind: 'profile' });
    for (let i = 0; i < 12; i++) await saveOk(sc, `enjoys hiking trail ${i} ${'in the mountains near the city '.repeat(3)}`);
    await saveOk(sc, 'recent unrelated thing');
    const hits = await mem.retrieve(sc, 'hiking plans', 'r1');
    const line = (h: (typeof hits)[number]) => estimateTokens(`- [${h.id}] (${h.kind}) ${h.text} — ${h.sourceLabel}`) + 2;
    const a = hits.filter((h) => h.kind === 'profile').reduce((n, h) => n + line(h), 0);
    const b = hits.filter((h) => h.kind !== 'profile').reduce((n, h) => n + line(h), 0);
    expect(a).toBeLessThanOrEqual(GROQ_PINNED_TOKENS);
    expect(b).toBeLessThanOrEqual(GROQ_RETRIEVED_TOKENS);
    expect(hits.filter((h) => h.kind !== 'profile').every((h) => h.text.includes('hiking'))).toBe(true);
    expect(hits.some((h) => h.text.includes('hiking'))).toBe(true);
  });
});

describe('scope isolation', () => {
  it('user, other user and group facts never cross', async () => {
    const a = env.user();
    const b = env.user();
    const g: Scope = { kind: 'group', chatId: -1 };
    const fa = await saveOk({ kind: 'user', userId: a.id }, 'Secret canary alpha');
    await saveOk(g, 'Group canary beta', { authorUserId: a.id, source: { kind: 'group_explicit' } });
    expect(await mem.search({ kind: 'user', userId: b.id }, 'canary', 10)).toEqual([]);
    expect((await mem.search({ kind: 'user', userId: a.id }, 'canary', 10)).map((h) => h.text)).toEqual(['Secret canary alpha']);
    expect((await mem.search(g, 'canary', 10)).map((h) => h.text)).toEqual(['Group canary beta']);
    expect(mem.getMany({ kind: 'user', userId: b.id }, [fa])).toEqual([]);
    expect(mem.getMany(g, [fa])).toEqual([]);
    expect(mem.getMany({ kind: 'user', userId: a.id }, [fa]).map((h) => h.id)).toEqual([fa]);
    await expect(mem.edit(b.id, fa, { text: 'hijack' })).rejects.toThrow();
    expect((await mem.forget({ kind: 'user', userId: b.id }, { ids: [fa] }, { tgUserId: b.tgUserId })).forgotten).toEqual([]);
    expect(env.keyStore.deks.get(`m:${a.id}:1`)?.owner).toBe(a.id);
    expect(env.keyStore.deks.get('mg:-1:1')?.owner).toBe('grp:-1');
  });

  it('edit re-encrypts and is written to the ledger; list pages with a cursor', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const id = await saveOk(sc, 'Lives in Almaty');
    await mem.edit(u.id, id, { text: 'Lives in Astana' });
    expect((await mem.search(sc, 'Astana', 5))[0]!.text).toBe('Lives in Astana');
    expect(env.ledger.entries.some((e) => e.kind === 'memory_saved' && e.summary === 'Memory edited')).toBe(true);
    for (let i = 0; i < 5; i++) await saveOk(sc, `fact ${i} x${i}`);
    const p1 = await mem.list(sc, { limit: 4 });
    expect(p1.items).toHaveLength(4);
    const p2 = await mem.list(sc, { limit: 4, cursor: p1.next! });
    expect(p2.items).toHaveLength(2);
    expect(p2.next).toBeUndefined();
  });
});
