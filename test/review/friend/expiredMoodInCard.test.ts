// RED TEAM (friend mode, spec 05 B1 "mood or context signals (short-lived, with a TTL)"). The TTL sweep deletes the
// expired fact rows (store.sweepExpired) but never touches the profile card: whatever the consolidation copied from a
// mood fact into the summary stays in <user_model> (and in the proactive composer's about_owner) until some later
// rebuild — which is fed the previous card as input, so the mood can be carried forward indefinitely. The nightly run
// does not even notice: lastActiveChange ignores deletions by the TTL sweep.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, ProfileCard, ProfileService, RunRow, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { createProfileService } from '../../../src/memory/profile.ts';
import { storeOf } from '../../../src/memory/impl.ts';
import { seededRandom } from '../../../src/kernel/random.ts';
import { FakeEmbedder } from '../../harness/fakes.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

const HOUR = 3_600_000;
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

const CARD: ProfileCard = {
  summary: 'Adi is a developer in Almaty, anxious and scared about the layoffs at work this week.',
  people: [], goals: [], preferences: [], style: { length: null, formality: null, emoji: null, language: null, humor: null },
  current_context: [{ text: 'anxious about the layoffs', expires_local: null }], open_threads: [],
};

describe('expired mood facts vs the profile card', () => {
  it('once the mood fact expired and was swept, it is no longer in <user_model>', async () => {
    const u = env.user({ lang: 'en' });
    const sc: Scope = { kind: 'user', userId: u.id };
    await mem.save(sc, { text: 'Is a developer in Almaty', kind: 'profile', sensitivity: 'normal', explicit: true, authorUserId: null, source: { kind: 'tool_explicit' } });
    await mem.save(sc, { text: 'Is anxious about the layoffs at work', kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: null, source: { kind: 'tool_explicit' }, expiresAt: env.clock.now() + 2 * HOUR });
    env.side.structuredQueue.push(CARD);
    await prof.consolidate(u.id, { reason: 'manual' });
    // two weeks later: the TTL sweep deleted the mood fact; the nightly consolidation ran
    await env.clock.advance(14 * 24 * HOUR);
    expect(storeOf(env.s)!.sweepExpired(env.clock.now())).toBe(1);
    env.side.structuredQueue.push({ ...CARD, summary: 'Adi is a developer in Almaty.', current_context: [] });
    await prof.consolidate(u.id, { reason: 'nightly' });
    expect(env.side.structuredCalls).toHaveLength(1); // the nightly run skipped: the sweep's deletion is not a "change"
    const p = env.s.contextProviders.find((x) => x.name === 'memory')!;
    const ctx = (await p.parts(env.dmConv(u), { id: 'run_m' } as RunRow, 'hi')).flatMap((x) => x.lines).join('\n');
    expect(ctx).not.toMatch(/anxious|layoffs/); // FAILS: the card (never rebuilt: "nothing changed") still says it
  });
});
