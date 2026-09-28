// RED TEAM (friend mode, spec 05 B4/B5 "the user can always see, correct and erase what Gora knows").
//  (a) A Mini App delete of a profile-card item is remembered in the sealed card ('removed'), so the next consolidation
//      does not re-add it. But forgetFacts() deletes EVERY card version (store.ts), and the forget rebuild starts from
//      `current === null` → keptRemoved = [] → an unrelated "forget X" resurrects every item the owner deleted.
//  (b) The Mini App delete only hides the card line: the underlying fact stays active and keeps flowing into
//      <user_model>, and the deleted text is kept verbatim and re-sent to the LLM ("Removed by the owner") on every
//      consolidation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, ProfileCard, ProfileService, RunRow, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { createProfileService } from '../../../src/memory/profile.ts';
import { seededRandom } from '../../../src/kernel/random.ts';
import { FakeEmbedder } from '../../harness/fakes.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
let sch: Scheduler;
let mem: MemoryService;
let prof: ProfileService;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  Object.assign(env.s as object, { scheduler: sch, caps: { embedder: new FakeEmbedder(8) }, random: seededRandom(1) });
  mem = createMemoryService(env.s);
  prof = createProfileService(env.s);
  Object.assign(env.s as object, { userProfile: prof });
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

const CARD: ProfileCard = {
  summary: 'Adi is a developer in Almaty.',
  people: [{ name: 'Masha', relation: 'ex-girlfriend', notes: 'broke up in August' }],
  goals: ['ship Gora this autumn'],
  preferences: ['short answers'],
  style: { length: 'short', formality: 'informal', emoji: null, language: 'en', humor: null },
  current_context: [],
  open_threads: [],
};

describe('profile card removals', () => {
  it('(a) an item the owner deleted in the Mini App stays deleted after an unrelated forget', async () => {
    const u = env.user({ lang: 'en' });
    const sc: Scope = { kind: 'user', userId: u.id };
    await save(sc, 'Ex-girlfriend Masha, broke up in August', { kind: 'person' });
    const job = await save(sc, 'Works at Kaspi as a backend developer');
    await save(sc, 'Wants to ship Gora this autumn', { kind: 'goal' });
    env.side.structuredQueue.push(CARD);
    await prof.consolidate(u.id, { reason: 'manual' });
    // the owner opens /memory and deletes Masha from the card
    expect(prof.edit(u.id, { op: 'delete', field: 'people', index: 0 })!.card.people).toEqual([]);
    // control: a normal rebuild where the model re-adds her → the removal wins
    await env.clock.advance(25 * 3_600_000);
    env.side.structuredQueue.push(CARD);
    expect((await prof.consolidate(u.id, { reason: 'manual' }))!.card.people).toEqual([]);
    // later the owner says "forget where I work" — nothing to do with Masha
    await mem.forget(sc, { ids: [job] }, { tgUserId: u.tgUserId });
    env.side.structuredQueue.push(CARD); // the rebuild (from the remaining facts, which still mention Masha)
    await sch.tick();
    const call = env.side.structuredCalls.at(-1)!;
    expect(call.purpose).toBe('consolidate');
    expect(prof.get(u.id)!.card.people).toEqual([]); // FAILS: Masha is back on the card
  });

  it('(b) deleting a card item in the Mini App erases it: not in <user_model>, not re-sent to the LLM', async () => {
    const u = env.user({ lang: 'en' });
    const sc: Scope = { kind: 'user', userId: u.id };
    await save(sc, 'Ex-girlfriend Masha, broke up in August', { kind: 'person' });
    await save(sc, 'Wants to ship Gora this autumn', { kind: 'goal' });
    env.side.structuredQueue.push(CARD);
    await prof.consolidate(u.id, { reason: 'manual' });
    prof.edit(u.id, { op: 'delete', field: 'people', index: 0 });
    // the next chat turn: the memory provider still retrieves the fact the owner just erased from the card
    const p = env.s.contextProviders.find((x) => x.name === 'memory')!;
    const parts = await p.parts(env.dmConv(u), { id: 'run_x' } as RunRow, 'Masha');
    const ctx = parts.flatMap((x) => x.lines).join('\n');
    await env.clock.advance(25 * 3_600_000);
    env.side.structuredQueue.push({ ...CARD, people: [] });
    await prof.consolidate(u.id, { reason: 'manual' });
    const prompt = env.side.structuredCalls.at(-1)!.user;
    expect({ inContext: ctx.includes('Masha'), resentToLlm: prompt.includes('Masha') }).toEqual({ inContext: false, resentToLlm: false });
    // FAILS: { inContext: true, resentToLlm: true } — "Removed by the owner (never include): - Masha (ex-girlfriend): …"
  });
});
