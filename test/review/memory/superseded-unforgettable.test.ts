// Review (memory): superseded facts keep their text forever and cannot be found by the user.
// save() marks the old fact 'superseded' (store.ts:335-336) but keeps its ciphertext; rotate() even re-encrypts it under
// each new generation (repo.withText, store.ts:254). list()/search()/export only load active+pending (repo.ts:57), and
// forget-by-query selects only active/pending facts (store.ts:529-535). So "forget Paris" reports nothing matched while
// "Lives in Paris" stays stored and decryptable.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { storeOf } from '../../../src/memory/impl.ts';
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

describe('superseded facts', () => {
  it('"forget Paris" leaves the superseded "Lives in Paris" stored and decryptable', async () => {
    const u = env.user();
    const sc: Scope = { kind: 'user', userId: u.id };
    const st = storeOf(env.s)!;
    const a = st.save(sc, { text: 'Lives in Paris with partner Marc', kind: 'profile', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' } }) as { id: string };
    // the extractor later supersedes it (supersedes_id → a.id)
    st.save(sc, { text: 'Moved to London', kind: 'profile', sensitivity: 'normal', explicit: false, authorUserId: u.id, source: { kind: 'user_message' } }, { createdBy: 'extractor', supersedesId: a.id });
    expect((await mem.list(sc, { limit: 20 })).items.map((f) => f.text)).toEqual(['Moved to London']);
    const r = await mem.forget(sc, { query: 'Paris Marc' }, { tgUserId: u.tgUserId });
    const row = env.db.prepare(`SELECT status, text_enc FROM memory_facts WHERE id = ?`).get<{ status: string; text_enc: Uint8Array | null }>(a.id)!;
    const stillReadable = row.text_enc ? env.crypto.openText(row.text_enc, `memory_facts|text_enc|${a.id}`) : null;
    // regression (was failing before the fix): nothing was forgotten and the Paris/Marc text is still stored and readable
    expect({ forgotten: r.forgotten.length, stillReadable }).toEqual({ forgotten: 1, stillReadable: null });
  });
});
