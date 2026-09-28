// Review (memory): a forget query made only of punctuation/emoji matches EVERY pending fact.
// store.ts:530 keeps pending facts whose normalized text `includes(normalize(query))`; normalize('?') === '' and
// ''.includes('') is true, so memory_forget {query:"?"} / {query:"*"} selects all pending facts (≤ 3 of them are
// forgotten with no confirm card, tools.ts:159) — irreversibly, with fingerprints that block re-learning them.
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

describe('forget by query', () => {
  it('a punctuation-only query matches nothing', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    // spec 05 B1 removed the sensitive ✓/✗ card: pending facts now come from an import checklist (or a tainted run)
    env.side.importResult = ['Takes insulin daily', 'Sees a therapist on Tuesdays'].map((text) => ({ text, kind: 'fact', sensitivity: 'sensitive' as const }));
    expect(await mem.importText(u.id, 'export')).toHaveLength(2);
    expect((await mem.list(sc, { limit: 10 })).items.map((f) => f.status)).toEqual(['pending_confirm', 'pending_confirm']);
    const out = await mem.forget(sc, { query: '?' }, { tgUserId: u.tgUserId });
    // regression (was failing before the fix): both pending facts are forgotten
    expect(out.forgotten).toHaveLength(0);
  });
});
