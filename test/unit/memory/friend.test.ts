// Spec 05 B1–B5 (set M): embeddings (sealed, backfilled, dropped on forget, re-sealed on rotation, model mismatch),
// hybrid retrieval through the store, TTL expiry, the profile card (consolidation, limits, gates, once a day, forget →
// rebuild without the fact, edits, due threads), the <user_model> head, memory_search about_me and the export.
// Fakes only: FakeEmbedder with pinned vectors, scripted structured calls, a seeded Random.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Embedder, MemoryService, ProfileCard, ProfileService, RunRow, Scheduler, Scope, ToolSpec } from '../../../src/contracts/index.ts';
import { bytesToVec, cosine, vecToBytes } from '../../../src/capabilities/embedder.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createJobsRepo } from '../../../src/scheduler/repo.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { storeOf } from '../../../src/memory/impl.ts';
import { createProfileService } from '../../../src/memory/profile.ts';
import { profileHeadLines } from '../../../src/memory/context.ts';
import { TOOLS } from '../../../src/memory/tools.ts';
import type { MemoryStore } from '../../../src/memory/store.ts';
import { fingerprintGrams } from '../../../src/memory/text.ts';
import { seededRandom } from '../../../src/kernel/random.ts';
import { wallTimeOf } from '../../../src/kernel/timeMath.ts';
import { estimateTokens } from '../../../src/kernel/tokens.ts';
import { FakeEmbedder } from '../../harness/fakes.ts';
import { makeEnv, toolCtx, type TestEnv } from './env.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let env: TestEnv;
let sch: Scheduler;
let mem: MemoryService;
let st: MemoryStore;
let emb: FakeEmbedder;
let prof: ProfileService;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  emb = new FakeEmbedder(8);
  Object.assign(env.s as object, { scheduler: sch, caps: { embedder: emb }, random: seededRandom(1) });
  mem = createMemoryService(env.s);
  prof = createProfileService(env.s);
  Object.assign(env.s as object, { userProfile: prof });
  st = storeOf(env.s)!;
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

const save = async (scope: Scope, text: string, o: Partial<Parameters<MemoryService['save']>[1]> = {}) => {
  const r = await mem.save(scope, { text, kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: null, source: { kind: 'tool_explicit' }, ...o });
  if (!('id' in r)) throw new Error(`denied: ${r.denied}`);
  return r.id;
};
const embRows = () => env.db.prepare(`SELECT fact_id, dek_gen, model, dim, vec_enc FROM fact_embeddings ORDER BY fact_id`).all<{ fact_id: string; dek_gen: number; model: string; dim: number; vec_enc: Uint8Array }>();
const tool = (n: string) => TOOLS.find((t) => t.name === n) as ToolSpec;

const CARD: ProfileCard = {
  summary: 'Adi is a developer in Almaty building a Telegram friend bot.',
  people: [{ name: 'Anna', relation: 'sister', notes: 'allergic to nuts' }],
  goals: ['ship Gora this autumn'],
  preferences: ['short answers'],
  style: { length: 'short', formality: 'informal', emoji: null, language: 'ru', humor: null },
  current_context: [{ text: 'busy with a release', expires_local: '2026-10-05' }],
  open_threads: [{ what: 'job interview at Kaspi', when_local: '2026-10-01T15:00', follow_up_after_local: '2026-10-01T19:00' }],
};

describe('embeddings (B2)', () => {
  it('a save schedules the backfill; vectors are sealed under the fact generation (never plain Float32)', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const id = await save(sc, 'Anna is allergic to nuts');
    expect(createJobsRepo(env.db).byDedupe(`me:user:${u.id}`)).toMatchObject({ kind: 'memory_embed' });
    expect(embRows()).toEqual([]); // never inline with the save
    await sch.tick();
    const [row] = embRows();
    expect(row).toMatchObject({ fact_id: id, dek_gen: 1, model: 'fake-8', dim: 8 });
    const plain = vecToBytes((await emb.embed(['Anna is allergic to nuts'], 'passage'))![0]!);
    expect(Buffer.from(row!.vec_enc).includes(Buffer.from(plain))).toBe(false);
    const opened = bytesToVec(env.crypto.open(row!.vec_enc, `fact_embeddings|vec_enc|${id}`));
    expect(cosine(opened, bytesToVec(plain))).toBeCloseTo(1, 5);
    expect(emb.calls.filter((c) => c.kind === 'passage').length).toBeGreaterThan(0);
  });

  it('hybrid retrieval through the store: the paraphrase outranks a keyword match; unavailable model → lexical, no throw', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    emb.set('Anna is allergic to nuts', [1, 0, 0, 0, 0, 0, 0, 0]).set('what should I not cook for her?', [0.98, 0.2, 0, 0, 0, 0, 0, 0]).set('Loves to cook pasta for friends', [0, 0, 1, 0, 0, 0, 0, 0]);
    const allergy = await save(sc, 'Anna is allergic to nuts');
    const pasta = await save(sc, 'Loves to cook pasta for friends');
    await sch.tick();
    const hits = await mem.retrieve(sc, 'what should I not cook for her?', 'run_1');
    expect(hits.map((h) => h.id)).toEqual([allergy, pasta]);
    expect(emb.calls.at(-1)).toEqual({ texts: ['what should I not cook for her?'], kind: 'query' });
    emb.available = false;
    const lexical = await mem.retrieve(sc, 'what should I not cook for her?', 'run_2');
    expect(lexical.map((h) => h.id)).toEqual([pasta]);
    const s2 = await mem.search(sc, 'cook', 5);
    expect(s2.map((h) => h.id)).toEqual([pasta]);
  });

  it('never waits for the first model load: an idle embedder is not called by a turn, the backfill job warms it', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    let state: 'idle' | 'ready' = 'idle';
    const calls: string[] = [];
    const lazy: Embedder = { model: 'lazy-8', dim: 8, status: () => state, embed: async (t, k) => (calls.push(k), (state = 'ready'), emb.embed(t, k)) };
    (env.s as { caps: { embedder: Embedder } }).caps.embedder = lazy;
    await save(sc, 'Plays tennis on Sundays');
    env.db.prepare(`DELETE FROM jobs WHERE kind = 'memory_embed'`).run();
    const hits = await mem.retrieve(sc, 'tennis', 'r');
    expect(hits).toHaveLength(1);
    expect(calls).toEqual([]); // the turn did not trigger a load
    expect(createJobsRepo(env.db).byDedupe(`me:user:${u.id}`)).toBeDefined();
    await sch.tick();
    expect(calls).toEqual(['passage']);
  });

  it('forget deletes the vector; the rotation re-seals the others under the new generation', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const gone = await save(sc, 'Works at the secret lab downtown');
    const keep = await save(sc, 'Plays chess every evening');
    await sch.tick();
    expect(embRows()).toHaveLength(2);
    await mem.forget(sc, { ids: [gone] }, { tgUserId: u.tgUserId });
    const rows = embRows();
    expect(rows.map((r) => r.fact_id)).toEqual([keep]);
    expect(rows[0]!.dek_gen).toBe(2);
    expect(env.keyStore.isDestroyed(`m:${u.id}:1`)).toBe(true);
    expect(bytesToVec(env.crypto.open(rows[0]!.vec_enc, `fact_embeddings|vec_enc|${keep}`))).toHaveLength(8);
    // retrieval still uses it after the rotation
    emb.set('chess', [0, 0, 0, 1, 0, 0, 0, 0]).set('Plays chess every evening', [0, 0, 0, 1, 0, 0, 0, 0]);
    expect((await mem.retrieve(sc, 'chess', 'r')).map((h) => h.id)).toEqual([keep]);
  });

  it('supersede and edit drop the stale vector; a vector of another model is ignored and re-embedded', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const a = await save(sc, 'Lives in Almaty');
    await sch.tick();
    await mem.edit(u.id, a, { text: 'Lives in Astana' });
    expect(embRows()).toEqual([]);
    await sch.tick();
    expect(embRows().map((r) => r.fact_id)).toEqual([a]);
    const b = st.save(sc, { text: 'Lives in Tbilisi', kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: null, source: { kind: 'tool_explicit' } }, { supersedesId: a });
    expect(embRows().map((r) => r.fact_id)).toEqual([]);
    await sch.tick();
    expect(embRows().map((r) => r.fact_id)).toEqual([(b as { id: string }).id]);
    env.db.prepare(`UPDATE fact_embeddings SET model = 'old-model'`).run();
    st.invalidate(sc);
    await mem.retrieve(sc, 'where do I live', 'r'); // notices the missing current-model vector → backfill queued
    await sch.tick();
    expect(embRows()[0]!.model).toBe('fake-8');
  });

  it('USER_DATA_TABLES-style deletion leaves no vector rows (FK cascade from memory_facts)', async () => {
    const u = env.user();
    await save({ kind: 'user', userId: u.id }, 'Has a cat named Luna');
    await sch.tick();
    expect(embRows()).toHaveLength(1);
    env.db.prepare(`DELETE FROM fact_embeddings WHERE scope = ? OR user_id = ?`).run(`user:${u.id}`, u.id);
    env.db.prepare(`DELETE FROM memory_facts WHERE scope = ? OR user_id = ?`).run(`user:${u.id}`, u.id);
    expect(embRows()).toHaveLength(0);
  });
});

describe('TTL facts (B1 mood / context)', () => {
  it('an expired fact is invisible at once and deleted (with its vector) by the retention sweep', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const mood = await save(sc, 'Feels tired this week', { expiresAt: env.clock.now() + 2 * DAY, importance: 0.3 });
    await save(sc, 'Is a morning person');
    await sch.tick();
    expect((await mem.list(sc, { limit: 10 })).items).toHaveLength(2);
    await env.clock.advance(2 * DAY + 1);
    expect((await mem.list(sc, { limit: 10 })).items.map((f) => f.text)).toEqual(['Is a morning person']);
    expect((await mem.retrieve(sc, 'tired week', 'r')).map((h) => h.id)).not.toContain(mood);
    await env.s.privacyHooks.find((h) => h.name === 'memory')!.retentionSweep!(env.clock.now());
    expect(st.repo().get(mood)).toBeUndefined();
    expect(embRows().map((r) => r.fact_id)).not.toContain(mood);
  });
});

describe('profile card (B4)', () => {
  const setup = async () => {
    const u = env.user({ lang: 'ru' });
    const sc: Scope = { kind: 'user', userId: u.id };
    await save(sc, 'Sister Anna is allergic to nuts', { kind: 'person' });
    await save(sc, 'Has an interview at Kaspi on Oct 1', { kind: 'date', importance: 0.9 });
    await save(sc, 'Takes antidepressants', { sensitivity: 'sensitive' });
    await save(sc, 'Is anxious today', { expiresAt: env.clock.now() + HOUR });
    return { u, sc };
  };

  it('one fast-role consolidate call over the non-sensitive live facts; sealed; ledger without text; head of <user_model>', async () => {
    const { u, sc } = await setup();
    await env.clock.advance(2 * HOUR); // the mood fact expired
    env.side.structuredQueue.push(CARD);
    const v = await prof.consolidate(u.id, { reason: 'manual' });
    expect(v).toMatchObject({ version: 1, card: CARD, factCount: 2 });
    const call = env.side.structuredCalls[0]!;
    expect(call).toMatchObject({ purpose: 'consolidate', role: 'fast', meta: expect.objectContaining({ userId: u.id, priority: 'background' }) });
    expect(call.user).toContain('Sister Anna is allergic to nuts');
    expect(call.user).toContain('Language: ru');
    expect(call.user).not.toContain('antidepressants'); // sensitive facts never reach the card (B composes from it)
    expect(call.user).not.toContain('anxious'); // expired
    expect(prof.get(u.id)).toMatchObject({ version: 1, card: CARD });
    const raw = env.db.prepare(`SELECT profile_enc, dek_gen FROM user_profile WHERE user_id = ?`).get<{ profile_enc: Uint8Array; dek_gen: number }>(u.id)!;
    expect(Buffer.from(raw.profile_enc).toString('latin1')).not.toContain('Almaty');
    expect(raw.dek_gen).toBe(1);
    const led = env.ledger.entries.filter((e) => e.kind === 'profile_updated');
    expect(led).toHaveLength(1);
    expect(JSON.stringify(led)).not.toContain('Almaty');
    // <user_model>: the card head first, then facts
    const p = env.s.contextProviders.find((x) => x.name === 'memory')!;
    const parts = await p.parts(env.dmConv(u), { id: 'run_um' } as RunRow, 'nuts');
    expect(parts[0]!.key).toBe('user_model');
    expect(parts[0]!.lines[0]).toBe('about: Adi is a developer in Almaty building a Telegram friend bot.');
    expect(parts[0]!.lines.join('\n')).toContain('people: Anna (sister): allergic to nuts');
    expect(parts[0]!.lines.join('\n')).toContain('open threads: job interview at Kaspi (2026-10-01T15:00) [ask after 2026-10-01T19:00]');
    expect(sc.kind).toBe('user');
  });

  it('clamps to the B4 limits and drops malformed local times', async () => {
    const { u } = await setup();
    const long = { ...CARD, summary: Array.from({ length: 80 }, (_, i) => `w${i}`).join(' '), people: Array.from({ length: 14 }, (_, i) => ({ name: `P${i}`, relation: 'friend', notes: '' })), goals: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], open_threads: [{ what: 'x', when_local: 'next week', follow_up_after_local: '2026-13-40' }] };
    env.side.structuredQueue.push(long);
    const v = (await prof.consolidate(u.id, { reason: 'manual' }))!;
    expect(v.card.summary.split(' ')).toHaveLength(60);
    expect(v.card.people).toHaveLength(12);
    expect(v.card.goals).toHaveLength(6);
    expect(v.card.open_threads[0]).toEqual({ what: 'x', when_local: null, follow_up_after_local: null });
  });

  it('gates: memory off / incognito / budget → no call; ≤ 1 per day; nightly skips an unchanged memory', async () => {
    const { u, sc } = await setup();
    env.repos.users.update(u.id, { memoryConsent: false });
    expect(await prof.consolidate(u.id, { reason: 'facts' })).toBeNull();
    env.repos.users.update(u.id, { memoryConsent: null, incognitoUntil: env.clock.now() + HOUR });
    expect(await prof.consolidate(u.id, { reason: 'facts' })).toBeNull();
    env.repos.users.update(u.id, { incognitoUntil: null });
    env.llmBudget.blocked.add('background');
    expect(await prof.consolidate(u.id, { reason: 'facts' })).toBeNull();
    expect(env.side.structuredCalls).toHaveLength(0);
    env.llmBudget.blocked.clear();
    env.side.structuredQueue.push(CARD, CARD, CARD);
    expect((await prof.consolidate(u.id, { reason: 'facts' }))!.version).toBe(1);
    await env.clock.advance(HOUR);
    await save(sc, 'Started learning Spanish');
    expect((await prof.consolidate(u.id, { reason: 'facts' }))!.version).toBe(1); // once a day
    expect(env.side.structuredCalls).toHaveLength(1);
    await env.clock.advance(DAY);
    expect((await prof.consolidate(u.id, { reason: 'nightly' }))!.version).toBe(2); // changed since → rebuilt
    await env.clock.advance(DAY);
    expect((await prof.consolidate(u.id, { reason: 'nightly' }))!.version).toBe(2); // nothing changed → no call
    expect(env.side.structuredCalls).toHaveLength(2);
    expect(env.side.structuredCalls[1]!.user).toContain('"summary":"Adi is a developer'); // the previous card is an input
  });

  it('15 new facts schedule a consolidation; the hourly sweep queues owners at 04:xx local only', async () => {
    const u = env.user({ tz: 'Asia/Almaty' });
    const far = env.user({ tz: 'America/New_York' });
    const sc: Scope = { kind: 'user', userId: u.id };
    for (let i = 0; i < 14; i++) await save(sc, `fact number ${i} about thing${i}`);
    expect(createJobsRepo(env.db).byDedupe(`pc:${u.id}`)).toBeUndefined();
    await save(sc, 'fact number 15 about thing15');
    expect(createJobsRepo(env.db).byDedupe(`pc:${u.id}`)).toMatchObject({ kind: 'profile_consolidate', payload: { reason: 'facts' } });
    env.db.prepare(`DELETE FROM jobs WHERE dedupe_key = ?`).run(`pc:${u.id}`);
    await save({ kind: 'user', userId: far.id }, 'Lives in Brooklyn');
    // advance to the sweep of the hour where Almaty is at 04:xx
    for (let i = 0; i < 48 && wallTimeOf(env.clock.now(), 'Asia/Almaty').hour !== 4; i++) await env.clock.advance(HOUR);
    await env.clock.advance(20 * MIN);
    await sch.tick();
    expect(createJobsRepo(env.db).byDedupe(`pc:${u.id}`)).toMatchObject({ payload: { reason: 'nightly' } });
    expect(createJobsRepo(env.db).byDedupe(`pc:${far.id}`)).toBeUndefined();
  });

  it('forget → every version deleted at once; the rebuild never sees the fact or the old card; fingerprints scrub the card', async () => {
    const { u, sc } = await setup();
    env.side.structuredQueue.push(CARD);
    await prof.consolidate(u.id, { reason: 'manual' });
    const interview = (await mem.list(sc, { limit: 10 })).items.find((f) => f.text.includes('Kaspi'))!;
    await mem.forget(sc, { ids: [interview.id] }, { tgUserId: u.tgUserId });
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM user_profile`).get<{ n: number }>()!.n).toBe(0);
    expect(prof.get(u.id)).toBeNull();
    expect(createJobsRepo(env.db).byDedupe(`pc:${u.id}:forget`)).toMatchObject({ payload: { reason: 'forget' } });
    // the model (wrongly) re-adds it: the fingerprint filter drops the item before it is sealed
    env.side.structuredQueue.push({ ...CARD, open_threads: [{ what: 'Has an interview at Kaspi on Oct 1', when_local: null, follow_up_after_local: null }] });
    await sch.tick();
    const call = env.side.structuredCalls.at(-1)!;
    expect(call.user).not.toContain('Kaspi');
    expect(call.user).toContain('Previous card:\n(none)');
    const v = prof.get(u.id)!;
    expect(v.version).toBe(1);
    expect(JSON.stringify(v.card)).not.toContain('Kaspi');
    for (const g of fingerprintGrams('Has an interview at Kaspi on Oct 1')) expect(JSON.stringify(v.card).toLowerCase()).not.toContain(g);
  });

  it('a card computed while a forget rotated the memory is discarded', async () => {
    const { u, sc } = await setup();
    const anna = (await mem.list(sc, { limit: 10 })).items.find((f) => f.text.includes('Anna'))!;
    (env.side as { structured: unknown }).structured = async () => {
      await mem.forget(sc, { ids: [anna.id] }, { tgUserId: u.tgUserId }); // lands while the model runs
      return CARD;
    };
    expect(await prof.consolidate(u.id, { reason: 'manual' })).toBeNull();
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM user_profile`).get<{ n: number }>()!.n).toBe(0);
  });

  it('edits: delete / correct write a new version; a delete erases the facts behind it; removals never reach the model', async () => {
    const { u, sc } = await setup();
    env.side.structuredQueue.push(CARD);
    await prof.consolidate(u.id, { reason: 'manual' });
    // deleting Anna from the card forgets the fact behind her (01 §9: every card version goes, the generation rotates)
    const v2 = prof.edit(u.id, { op: 'delete', field: 'people', index: 0 })!;
    expect(v2.card.people).toEqual([]);
    expect((await mem.list(sc, { limit: 20 })).items.map((f) => f.text).join('|')).not.toContain('Anna');
    const v3 = prof.edit(u.id, { op: 'correct', field: 'goals', index: 0, text: 'ship Gora before winter' })!;
    expect(v3.version).toBe(v2.version + 1);
    expect(v3.card.goals).toEqual(['ship Gora before winter']);
    expect(prof.edit(u.id, { op: 'delete', field: 'goals', index: 9 })!.version).toBe(v3.version); // out of range: unchanged
    const w = prof.edit(u.id, { op: 'correct', field: 'people', index: 0, text: 'x' });
    expect(w!.version).toBe(v3.version);
    env.side.structuredQueue.push({ ...CARD, goals: ['ship Gora before winter'] });
    const v4 = (await prof.consolidate(u.id, { reason: 'manual' }))!;
    const prompt = env.side.structuredCalls.at(-1)!.user;
    // removals are kept as token signatures: neither the removed text nor a "removed" list is ever sent to the model
    expect(prompt).not.toContain('Removed by the owner');
    expect(prompt).not.toContain('Anna');
    expect(prompt).not.toContain('ship Gora this autumn');
    expect(prompt).toContain('Corrected by the owner (keep as written):\n- ship Gora before winter');
    expect(v4.card.people).toEqual([]); // the model re-added Anna; the owner's removal wins
    expect(v4.card.goals).toEqual(['ship Gora before winter']);
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM user_profile`).get<{ n: number }>()!.n).toBe(3); // pruned to the newest 3
  });

  it('dueThreads: follow_up_after passed in the owner tz, oldest first; none while memory is off', async () => {
    const u = env.user({ tz: 'Asia/Almaty' }); // UTC+5; clock 2026-09-28 09:00Z = 14:00 local
    await save({ kind: 'user', userId: u.id }, 'x');
    env.side.structuredQueue.push({
      ...CARD,
      open_threads: [
        { what: 'later', when_local: null, follow_up_after_local: '2026-09-28T15:00' },
        { what: 'dateOnly', when_local: null, follow_up_after_local: '2026-09-28' },
        { what: 'none', when_local: '2026-09-20', follow_up_after_local: null },
        { what: 'earlier', when_local: null, follow_up_after_local: '2026-09-27T20:00' },
      ],
    });
    await prof.consolidate(u.id, { reason: 'manual' });
    const now = env.clock.now();
    expect(prof.dueThreads(u.id, now).map((t) => [t.what, t.index])).toEqual([['earlier', 3], ['dateOnly', 1]]);
    expect(prof.dueThreads(u.id, now + HOUR).map((t) => t.what)).toEqual(['earlier', 'dateOnly', 'later']);
    env.repos.users.update(u.id, { memoryConsent: false });
    expect(prof.dueThreads(u.id, now + HOUR)).toEqual([]);
  });

  it('the head is trimmed to its token budget, least important groups first', () => {
    const big: ProfileCard = { ...CARD, preferences: Array.from({ length: 10 }, (_, i) => `preference number ${i} ${'blah '.repeat(12)}`), goals: Array.from({ length: 6 }, (_, i) => `goal ${i} ${'more words '.repeat(8)}`) };
    const lines = profileHeadLines(big, { tz: 'UTC', now: Date.UTC(2026, 8, 28), maxTokens: 120 });
    expect(lines.reduce((n, l) => n + estimateTokens(l) + 2, 0)).toBeLessThanOrEqual(120);
    expect(lines[0]!.startsWith('about: ')).toBe(true);
    expect(lines.join('\n')).toContain('people: Anna');
    // expired context is left out
    expect(profileHeadLines(CARD, { tz: 'UTC', now: Date.UTC(2026, 9, 7), maxTokens: 250 }).join('\n')).not.toContain('busy with a release');
  });
});

describe('memory_search about_me (B5) and export', () => {
  it('returns the card, the top facts and the Mini App link; nothing when memory is off', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    await save(sc, 'Sister Anna is allergic to nuts', { kind: 'person', importance: 0.9 });
    await save(sc, 'Likes green tea', { importance: 0.2 });
    env.side.structuredQueue.push(CARD);
    await prof.consolidate(u.id, { reason: 'manual' });
    const ctx = toolCtx(env, { userId: u.id, tgUserId: u.tgUserId });
    const out = JSON.parse((await tool('memory_search').execute({ query: '', about_me: true, limit: 8 }, ctx)).content) as Record<string, unknown>;
    expect(out['profile']).toMatchObject({ summary: CARD.summary, people: CARD.people });
    expect((out['facts'] as Array<{ text: string }>).map((f) => f.text)).toEqual(['Sister Anna is allergic to nuts', 'Likes green tea']);
    expect(out['miniapp']).toBe(`${env.s.config.publicUrl}/app/?screen=memory`);
    expect(out['total']).toBe(2);
    // empty query + kind profile is the same request
    const alt = JSON.parse((await tool('memory_search').execute({ query: '', kind: 'profile', limit: 8 }, ctx)).content) as Record<string, unknown>;
    expect(alt['miniapp']).toBeDefined();
    const ex = (await env.s.privacyHooks.find((h) => h.name === 'memory')!.exportUser!(u.id, u.tgUserId)) as Record<string, unknown>;
    expect(ex['profile']).toMatchObject({ version: 1, card: CARD });
    await sch.tick();
    expect(ex['embeddings']).toMatchObject({ model: 'fake-8' });
    env.repos.users.update(u.id, { memoryConsent: false });
    expect(JSON.parse((await tool('memory_search').execute({ query: '', about_me: true, limit: 8 }, ctx)).content)).toEqual({ facts: [], note: 'memory is off' });
  });
});
