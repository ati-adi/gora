// Review (memory, groups): group memory is permanently broken after the bot is re-added to a group it left > 7 days ago.
// surfaces/index.ts:141-142 retention destroys every 'grp:<chatId>' DEK (incl. the memory DEKs 'mg:<chatId>:<gen>') and
// deletes the groups row, but memory_facts rows of the group are kept. On re-join store.currentGen (store.ts:100) resolves
// to the old generation (max of held gen 1 and the table's dek_gen), seal() → ensureDek on a destroyed DEK →
// DekDestroyedError, which save() rethrows (store.ts:342-344): every /remember / memory_save in that group crashes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService, Scheduler, Scope } from '../../../src/contracts/index.ts';
import { createScheduler } from '../../../src/scheduler/index.ts';
import { createMemoryService } from '../../../src/memory/index.ts';
import { createReminderModule } from '../../../src/reminders/index.ts';
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

describe('group memory after leave + retention + re-add', () => {
  it('memory_save in the re-joined group works', async () => {
    const u = env.user();
    const g: Scope = { kind: 'group', chatId: -100777 };
    const save = (text: string) => mem.save(g, { text, kind: 'group_decision', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'group_explicit' } });
    expect('id' in (await save('Standup is at 10:00'))).toBe(true);
    // bot left the group; 7 days later the surfaces retention sweep shreds the group's DEKs (surfaces/index.ts:141)
    env.crypto.destroyOwner(`grp:${g.chatId}`);
    (env.s as { groups: unknown }).groups = { memoryGen: () => 1, bumpMemoryGen: () => 2 }; // groups row forgotten → gen 1
    // the bot is added back; a member says "/remember retro is on Fridays"
    // regression (was failing before the fix): throws DekDestroyedError
    const r = await save('Retro is on Fridays');
    expect('id' in r).toBe(true);
  });

  it('group to-dos (sealed under g:<chatId>, same owner grp:<chatId>) work in the re-joined group', () => {
    (env.s as { scheduler: Scheduler }).scheduler = sch;
    const mod = createReminderModule(env.s);
    const g: Scope = { kind: 'group', chatId: -100888 };
    mod.todos.apply(g, null, { action: 'add', text: 'buy snacks' });
    env.crypto.destroyOwner(`grp:${g.chatId}`); // retention after the bot left (surfaces/index.ts:141)
    // regression (was failing before the fix): DekDestroyedError from reminders/repo.ts insertTodo → crypto.seal('g:-100888')
    expect(() => mod.todos.apply(g, null, { action: 'add', text: 'book a room' })).not.toThrow();
  });
});
