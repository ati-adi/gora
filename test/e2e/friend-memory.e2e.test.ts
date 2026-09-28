// Spec 05 §E rows owned by set M (docs/spec/06 §4), end to end on the real scheduler / memory / profile factories with
// every other package pinned to fakes (test/unit/memory/e2eHarness.ts): extraction without a consent card (✍ reaction,
// no markup; incognito / memory off → no extract call), hybrid retrieval in <user_model>, nightly profile consolidation
// through the real SideCalls.structured (scripted parse), forget → card rebuilt without the fact, sealed embeddings and
// the deletion plan. Fakes only: FakeEmbedder with controlled vectors, ScriptedTransport for the consolidate parse.
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRow, InputRow, ProfileCard, ReplyChannel, RunRow, UserRow } from '../../src/contracts/index.ts';
import { USER_DATA_TABLES } from '../../src/contracts/storage.ts';
import { createSideCalls } from '../../src/agent/side.ts';
import { buildContextText } from '../../src/agent/context.ts';
import { createProfileService } from '../../src/memory/profile.ts';
import { vecToBytes } from '../../src/capabilities/embedder.ts';
import { wallTimeOf } from '../../src/kernel/timeMath.ts';
import { FakeEmbedder } from '../harness/fakes.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { addUser, dm, newShared, wp6Factories, type WpShared } from '../unit/memory/e2eHarness.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
let t: TestApp;
let sh: WpShared;
let emb: FakeEmbedder;
afterEach(async () => {
  await t?.close();
});

async function app(): Promise<TestApp> {
  sh = newShared();
  t = await createTestApp({ clock: sh.clock, factories: { ...wp6Factories(sh), createProfileService }, noopFallback: false });
  // the consolidate call goes through the real SideCalls.structured → ScriptedTransport.parse (t.llm.pushParse)
  const real = createSideCalls(t.s);
  sh.side.structured = (req, meta) => real.structured(req, meta);
  emb = new FakeEmbedder(8);
  (t.s.caps as unknown as { embedder: FakeEmbedder }).embedder = emb;
  return t;
}
function newUser(tgUserId: number, o: { consent?: boolean | null } = {}): UserRow {
  const u = addUser(t, { tgUserId });
  t.s.repos.users.update(u.id, { memoryConsent: o.consent === undefined ? null : o.consent }); // null = never asked (spec 05: on)
  return t.s.repos.users.getById(u.id)!;
}
let tgMsg = 100;
function input(conv: ConversationRow, text: string, o: Partial<Pick<InputRow, 'kind' | 'author' | 'untrusted'>> = {}): string {
  return t.s.repos.inputs.add({
    conversationId: conv.id, kind: o.kind ?? 'text', author: o.author ?? 'owner', untrusted: o.untrusted ?? false, content: [{ type: 'text', text }],
    tgUpdateId: null, tgChatId: conv.tgChatId, tgMessageId: ++tgMsg, fromTgUserId: null, replyToCardId: null,
  });
}
async function exchange(conv: ConversationRow, text: string): Promise<string> {
  const id = input(conv, text);
  const epoch = t.s.repos.conversations.currentEpoch(conv.id).epoch;
  const run = t.s.repos.runs.create({ conversationId: conv.id, userId: conv.userId, epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId!, triggerMessageId: tgMsg }, maxTokens: 1000 });
  t.s.repos.inputs.markConsumed([id], run.id, epoch);
  t.s.repos.runs.update(run.id, { state: 'done' });
  const done = t.s.repos.runs.get(run.id)!;
  for (const h of t.s.runHooks) await h.onRunFinished(done, conv, []);
  await t.advance(0);
  return id;
}
async function tool(u: UserRow, conv: ConversationRow, name: string, inp: Record<string, unknown>) {
  const run = t.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.dmChatId! }, maxTokens: 1000 });
  const r = await t.s.executor.processRound(run, conv, 1, [{ type: 'tool_use', id: `toolu_${name}_${t.clock.now()}`, name, input: inp }], null as unknown as ReplyChannel, new AbortController().signal);
  return JSON.parse(String(r.results[0]!.content)) as Record<string, unknown>;
}
const fact = (text: string, source_input_id: string, extra: Record<string, unknown> = {}) => ({
  text, kind: 'fact', subject: null, sensitivity: 'normal', confidence: 0.95, source_input_id, supersedes_id: null, explicit: false, importance: 0.6, ttl_days: null, ...extra,
});
async function userModel(conv: ConversationRow, query: string): Promise<string> {
  const run = t.s.repos.runs.create({ conversationId: conv.id, userId: conv.userId, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId! }, maxTokens: 1000 });
  const text = await buildContextText(t.s, conv, run, { events: [], replyToCard: null, previousStopped: false, query });
  const m = /<user_model>\n([\s\S]*?)\n<\/user_model>/.exec(text);
  return m ? m[1]! : '';
}
const markupSent = () => t.tg.calls.some((c) => c.payload?.reply_markup !== undefined);
const CARD: ProfileCard = {
  summary: 'Aida is a designer in Almaty who loves mountains and is preparing for a big job interview.',
  people: [{ name: 'Anna', relation: 'sister', notes: 'allergic to nuts' }],
  goals: ['land the design lead job'],
  preferences: ['short, informal replies'],
  style: { length: 'short', formality: 'informal', emoji: 'light', language: 'ru', humor: null },
  current_context: [],
  open_threads: [{ what: 'job interview at Kaspi', when_local: '2026-10-01T15:00', follow_up_after_local: '2026-10-01T19:00' }],
};

describe('friend memory e2e (spec 05 B, set M)', () => {
  it('extraction without a consent card: three messages → one batched extract → facts + ✍ reactions, no markup', async () => {
    await app();
    const u = newUser(9101);
    const conv = dm(t, u);
    const a = await exchange(conv, 'Привет! Я переехала в Алматы.');
    await exchange(conv, 'Сегодня был длинный день.');
    expect(sh.side.extractCalls).toHaveLength(0); // batched: not after every message
    const c = input(conv, 'Моя сестра Анна не ест орехи — аллергия.');
    sh.side.extractQueue.push({ facts: [fact('Переехала в Алматы', a, { kind: 'profile', importance: 0.8 }), fact('Сестра Анна — аллергия на орехи', c, { kind: 'person' })], commitments: [] });
    // the third exchange
    const epoch = t.s.repos.conversations.currentEpoch(conv.id).epoch;
    const run = t.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: conv.tgChatId! }, maxTokens: 1000 });
    t.s.repos.inputs.markConsumed([c], run.id, epoch);
    t.s.repos.runs.update(run.id, { state: 'done' });
    for (const h of t.s.runHooks) await h.onRunFinished(t.s.repos.runs.get(run.id)!, conv, []);
    await t.advance(0);
    expect(sh.side.extractCalls).toHaveLength(1);
    expect(sh.side.extractCalls[0]!.inputs).toHaveLength(3);
    expect(sh.side.extractCalls[0]!.priority).toBe('background');
    const items = (await t.s.memory.list({ kind: 'user', userId: u.id }, { limit: 10 })).items.map((f) => f.text).sort();
    expect(items).toEqual(['Переехала в Алматы', 'Сестра Анна — аллергия на орехи']);
    const reactions = t.tg.byMethod('setMessageReaction');
    expect(reactions.map((r) => r.message_id).sort()).toEqual([Number(t.s.repos.inputs.get(a)!.tgMessageId), Number(t.s.repos.inputs.get(c)!.tgMessageId)].sort());
    expect(reactions[0].reaction).toEqual([{ type: 'emoji', emoji: '✍' }]);
    expect(markupSent()).toBe(false);
    expect(t.s.repos.users.getById(u.id)!.memoryConsent).toBeNull(); // never asked, still on

    // incognito, or memory turned off («не запоминай») → no extraction call at all
    const inc = newUser(9102);
    t.s.repos.users.update(inc.id, { incognitoUntil: t.clock.now() + 2 * HOUR });
    const off = newUser(9103, { consent: false });
    for (const who of [inc, off]) {
      const cv = dm(t, who);
      for (let i = 0; i < 3; i++) await exchange(cv, `message ${i}`);
    }
    await t.advance(15 * MIN);
    expect(sh.side.extractCalls).toHaveLength(1);
  });

  it('hybrid retrieval in <user_model>: the paraphrase ranks above an unrelated keyword match; no model → BM25 order', async () => {
    await app();
    const u = newUser(9201);
    const conv = dm(t, u);
    const Q = 'what should she never eat?'; // a paraphrase of the allergy; shares only "eat" with the recipe
    emb.set('Anna is allergic to nuts', [1, 0, 0, 0, 0, 0, 0, 0]).set(Q, [0.97, 0.1, 0, 0, 0, 0, 0, 0]).set('Loves a nut-free chocolate recipe she can eat every day', [0, 0, 0, 0, 1, 0, 0, 0]);
    await tool(u, conv, 'memory_save', { text: 'Loves a nut-free chocolate recipe she can eat every day', kind: 'preference', sensitivity: 'normal', explicit: true });
    await tool(u, conv, 'memory_save', { text: 'Anna is allergic to nuts', kind: 'person', sensitivity: 'normal', explicit: true });
    await t.advance(0); // memory_embed backfill
    expect(t.s.db.prepare(`SELECT COUNT(*) AS n FROM fact_embeddings`).get<{ n: number }>()!.n).toBe(2);
    const lines = (await userModel(conv, Q)).split('\n');
    expect(lines.findIndex((l) => l.includes('allergic'))).toBeLessThan(lines.findIndex((l) => l.includes('chocolate')));
    emb.available = false;
    const lex = await userModel(conv, Q); // silently lexical: only the keyword match is left, and nothing throws
    expect(lex).toContain('chocolate');
    expect(lex).not.toContain('allergic');
  });

  it('nightly consolidation (scripted parse) → the card heads <user_model>; forget → rebuilt without the fact; relearning blocked', async () => {
    await app();
    const u = newUser(9301);
    const conv = dm(t, u);
    const src = await exchange(conv, 'I have a job interview at Kaspi on Thursday. My sister Anna is allergic to nuts.');
    sh.side.extractQueue.push({ facts: [fact('Has a job interview at Kaspi on Thursday', src, { kind: 'date', importance: 0.9 }), fact('Sister Anna is allergic to nuts', src, { kind: 'person' })], commitments: [] });
    await t.advance(10 * MIN);
    expect((await t.s.memory.list({ kind: 'user', userId: u.id }, { limit: 10 })).items).toHaveLength(2);
    const kaspi = (await t.s.memory.list({ kind: 'user', userId: u.id }, { limit: 10 })).items.find((f) => f.text.includes('Kaspi'))!;
    // go to 04:xx in the owner's zone: the hourly sweep queues them, the per-user job makes ONE fast consolidate call
    t.llm.pushParse('consolidate', CARD);
    for (let i = 0; i < 30 && wallTimeOf(t.clock.now(), 'Asia/Almaty').hour !== 4; i++) await t.advance(HOUR);
    await t.advance(20 * MIN);
    await t.advance(30 * MIN);
    const calls = t.llm.parseRequests.filter((r) => r.purpose === 'consolidate');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).not.toBe('main');
    expect(calls[0]!.user).toContain('Has a job interview at Kaspi');
    expect(t.s.userProfile.get(u.id)).toMatchObject({ version: 1, card: CARD });
    const um = await userModel(conv, 'hi');
    expect(um.split('\n')[0]).toBe(`- about: ${CARD.summary}`);
    expect(um).toContain('open threads: job interview at Kaspi');
    expect(t.s.userProfile.dueThreads(u.id, Date.UTC(2026, 9, 1, 15, 0))).toHaveLength(1); // 20:00 Almaty
    await t.advance(0);
    const vecKaspi = () => t.s.db.prepare(`SELECT COUNT(*) AS n FROM fact_embeddings WHERE fact_id = ?`).get<{ n: number }>(kaspi.id)!.n;
    expect(vecKaspi()).toBe(1);

    // forget the interview
    t.llm.pushParse('consolidate', { ...CARD, summary: 'Aida is a designer in Almaty who loves mountains.', open_threads: [] });
    const out = await tool(u, conv, 'memory_forget', { ids: [kaspi.id] });
    expect((out['forgotten'] as unknown[]).length).toBe(1);
    expect(vecKaspi()).toBe(0);
    await t.advance(0);
    const rebuild = t.llm.parseRequests.filter((r) => r.purpose === 'consolidate');
    expect(rebuild).toHaveLength(2);
    expect(rebuild[1]!.user).not.toContain('Kaspi');
    expect(rebuild[1]!.user).toContain('Previous card:\n(none)');
    const rows = t.s.db.prepare(`SELECT version FROM user_profile WHERE user_id = ?`).all<{ version: number }>(u.id);
    expect(rows).toEqual([{ version: 1 }]); // the old versions are gone; the rebuilt card is the only one
    expect(JSON.stringify(t.s.userProfile.get(u.id)!.card)).not.toContain('Kaspi');
    expect(await userModel(conv, 'interview Kaspi')).not.toContain('Kaspi');
    // the owner repeats it; extraction proposes it again → blocked by the fingerprints
    const again = await exchange(conv, 'Reminder to self: I have a job interview at Kaspi on Thursday.');
    sh.side.extractQueue.push({ facts: [fact('Has a job interview at Kaspi on Thursday', again, { kind: 'date' })], commitments: [] });
    await t.advance(10 * MIN);
    expect((await t.s.memory.list({ kind: 'user', userId: u.id }, { limit: 10 })).items.map((f) => f.text)).toEqual(['Sister Anna is allergic to nuts']);
  });

  it('embedding rows are sealed, and the deletion plan leaves no embedding / profile / fact rows', async () => {
    await app();
    const u = newUser(9401);
    const conv = dm(t, u);
    await tool(u, conv, 'memory_save', { text: 'Climbs every Saturday', kind: 'routine', sensitivity: 'normal', explicit: true });
    await t.advance(0);
    t.llm.pushParse('consolidate', CARD);
    await t.s.userProfile.consolidate(u.id, { reason: 'manual' });
    const row = t.s.db.prepare(`SELECT vec_enc, dim FROM fact_embeddings`).get<{ vec_enc: Uint8Array; dim: number }>()!;
    expect(row.dim).toBe(8);
    const plain = vecToBytes((await emb.embed(['Climbs every Saturday'], 'passage'))![0]!);
    expect(Buffer.from(row.vec_enc).includes(Buffer.from(plain))).toBe(false);
    expect(row.vec_enc.byteLength).not.toBe(plain.byteLength);
    for (const d of USER_DATA_TABLES.filter((x) => ['fact_embeddings', 'user_profile', 'memory_facts'].includes(x.table))) t.s.db.raw.prepare(`DELETE FROM ${d.table} WHERE ${d.where}`).run({ userId: u.id });
    for (const table of ['fact_embeddings', 'user_profile', 'memory_facts']) expect(t.s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()!.n, table).toBe(0);
  });
});
