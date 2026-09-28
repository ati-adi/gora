// Shared fixture for WP1 privacy unit tests: real gora.db/keys.db/crypto/repos/ledger/quotas + fake scheduler/runner,
// assembled into the slice of Services the privacy module uses.
import type { PrivacyHook, Services } from '../../../src/contracts/index.ts';
import { ZERO_USAGE } from '../../../src/contracts/llm.ts';
import { testConfig } from '../../../src/config.ts';
import { createQuotas } from '../../../src/billing/index.ts';
import { createLedgerCore } from '../../../src/ledger/index.ts';
import { createLogger } from '../../../src/kernel/log.ts';
import { createFakeRunner, createFakeScheduler } from '../../harness/fakes.ts';
import { chat, dbEnv, HASH_KEY, KEK, mkConv, mkUser, type DbEnv } from '../db/env.ts';

export { chat, mkConv, mkUser };

export interface PrivEnv extends DbEnv {
  s: Services;
  scheduler: ReturnType<typeof createFakeScheduler>;
  runner: ReturnType<typeof createFakeRunner>;
  stopped: string[];
  hookCalls: string[];
  addHook(h: Partial<PrivacyHook> & { name: string }): void;
}

export function privEnv(o: { now?: number } = {}): PrivEnv {
  const e = dbEnv(o);
  const scheduler = createFakeScheduler(() => e.clock);
  const runner = createFakeRunner();
  const stopped: string[] = [];
  runner.stopRun = async (id: string) => {
    stopped.push(id);
    return true;
  };
  const hookCalls: string[] = [];
  const s = {
    config: testConfig({}, { backupDir: `${e.dir}/backups`, dataDir: e.dataDir, keysDbPath: e.keysDbPath, secrets: { kek: KEK, hashKey: HASH_KEY } }),
    clock: e.clock,
    log: createLogger({ level: 'silent' }),
    db: e.db,
    crypto: e.crypto,
    repos: e.repos,
    keyStore: e.ks,
    privacyHooks: [] as PrivacyHook[],
    scheduler,
    runner,
  } as unknown as Services;
  s.ledger = createLedgerCore(() => e.db, () => e.crypto, () => e.clock);
  s.quotas = createQuotas({ db: () => e.db, clock: () => e.clock });
  return {
    ...e,
    s,
    scheduler,
    runner,
    stopped,
    hookCalls,
    addHook(h) {
      s.privacyHooks.push({ onDeleteUser: async () => {}, ...h } as PrivacyHook);
    },
  };
}

/** A user with a DM conversation holding two epochs (1 closed, 2 current), a run, tool call, llm call, blob, input,
 *  event, ledger rows and usage — every WP1 table the deletion plan touches. */
export function seedUser(p: PrivEnv, tgId?: number) {
  const u = mkUser(p, tgId === undefined ? {} : { tgId });
  const c = mkConv(p, u.id);
  const run1 = p.repos.runs.create({ conversationId: c.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.tgUserId }, maxTokens: 1000 });
  chat(p, c.id, 1, 'epoch one question', 'epoch one answer', run1.id);
  p.repos.runs.stageToolCalls([{ toolUseId: `tu_${c.id}`, runId: run1.id, conversationId: c.id, epoch: 1, userId: u.id, assistantSeq: 2, ordinal: 0, name: 'weather_get', input: { place: 'Almaty' } }]);
  p.repos.runs.recordLlmCall({
    runId: run1.id, conversationId: c.id, epoch: 1, userId: u.id, purpose: 'main', requestHmac: 'h', modelRequested: 'm', modelServed: 'm', servedByFallback: false,
    stopReason: 'end_turn', refusalCategory: null, usage: ZERO_USAGE, iterations: null, costMicros: 5, latencyMs: 1, ttftMs: 1, requestId: null, errorClass: null, raw: { req: 'raw' },
  });
  p.repos.runs.recordMemoryUses(run1.id, ['m1']);
  p.repos.runs.update(run1.id, { state: 'done' });
  const blob = p.repos.messages.putBlob({ ownerUserId: u.id, dek: `e:${c.id}:1`, mime: 'image/png', bytes: new Uint8Array([1, 2]) });
  p.repos.messages.refBlobs(c.id, 1, [blob]);
  const inp = p.repos.inputs.add({ conversationId: c.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'epoch one question' }], tgUpdateId: null, tgChatId: u.tgUserId, tgMessageId: 1, fromTgUserId: u.tgUserId, replyToCardId: null });
  p.repos.inputs.markConsumed([inp], run1.id, 1);
  p.repos.conversations.startEpoch(c.id, 'idle', 'none', []);
  const run2 = p.repos.runs.create({ conversationId: c.id, userId: u.id, epoch: 2, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.tgUserId }, maxTokens: 1000 });
  chat(p, c.id, 2, 'current question', 'current answer', run2.id);
  p.repos.inputs.add({ conversationId: c.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'pending' }], tgUpdateId: 99, tgChatId: u.tgUserId, tgMessageId: 2, fromTgUserId: u.tgUserId, replyToCardId: null });
  p.repos.inputs.addEvent(c.id, 'an event');
  p.s.ledger.append({ userId: u.id, actor: 'user', kind: 'consent', summary: 'Memory on' });
  p.s.ledger.append({ userId: u.id, actor: 'agent', kind: 'tool_call', summary: 'Checked the weather', detail: { tool: 'weather_get' } });
  p.s.quotas.consume(u.id, 'turn', 2);
  p.repos.users.grantConsent({ userId: u.id, kind: 'terms', textVersion: 'v1', via: 'callback' });
  p.repos.users.setPermission(u.id, 'gcal', 'read', 'miniapp');
  p.repos.users.updateSettings(u.id, { nudgeBudget: 2 });
  p.repos.kv.set(`cooldown:${u.id}`, 1);
  p.db.prepare('INSERT INTO rate_buckets(key, window_start, count) VALUES (?, 0, 1)').run(`guest:${u.tgUserId}`);
  p.db.prepare(`INSERT INTO jobs(id, kind, user_id, run_at, status, created_at, updated_at) VALUES (?, 'reminder_fire', ?, 0, 'scheduled', 0, 0)`).run(`job_${u.id}`, u.id);
  return { u, c, run1, run2, blob };
}

export const count = (p: Pick<PrivEnv, 'db'>, table: string, where = '1=1', ...params: Array<string | number>) =>
  Number(p.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get<{ n: number }>(...params)!.n);
