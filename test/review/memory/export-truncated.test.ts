// Review (memory): the privacy export silently truncates to 100 facts.
// memory/index.ts:50 calls store.list(scope, { limit: 100_000 }) but store.ts:424 clamps limit to 100 and the `next`
// cursor is ignored, so a user with up to 2 000 active facts (the cap) gets only the newest 100 in their data export.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { makeEnv, type TestEnv } from '../../unit/memory/env.ts';

let env: TestEnv;
let sch: Scheduler;
let mem: MemoryService;

beforeEach(() => {
  env = makeEnv();
  sch = createScheduler(env.s);
  (env.s as { scheduler: Scheduler }).scheduler = sch;
  mem = createMemoryService(env.s);
});
afterEach(async () => {
  await sch.stop();
  env.close();
});

describe('memory export', () => {
  it('exports every fact of the user', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    for (let i = 0; i < 150; i++) {
      const r = await mem.save(sc, { text: `Fact number ${i} about item${i}`, kind: 'fact', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' } });
      expect('id' in r).toBe(true);
    }
    const hook = (env.s.privacyHooks as Array<{ name: string; exportUser?: (id: string) => Promise<unknown> }>).find((h) => h.name === 'memory')!;
    const out = (await hook.exportUser!(u.id)) as { facts: unknown[] };
    // regression (was failing before the fix): 100
    expect(out.facts).toHaveLength(150);
  });
});
