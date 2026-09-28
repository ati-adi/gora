// WP3 e2e — epochs (01 §5.9, §15.2; 03 R2): idle rotation uses the handoff fork (same prefix plus ONE non-persisted
// row); the seed is the first USER row; a tainted epoch gets a deterministic seed with no model text; forget rotation
// shreds the old epoch (rows gone, DEK destroyed) and the note is post-filtered; context_mode inline after the 400;
// Groq profile: synchronous size rotation with a fast-model handoff note.
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRow, Factories, MemoryService, UserRow } from '../../src/contracts/index.ts';
import { createAgentModule } from '../../src/agent/index.ts';
import type { EngineRunner } from '../../src/agent/engine.ts';
import { checkEpochGrammar } from '../../src/agent/grammar.ts';
import { TAINTED_LINE } from '../../src/agent/epochs.ts';
import {
  NOOP_FACTORIES, createFakeCapabilities, createFakeGovernance, createFakeIntegrations, createFakeLedger, createFakeQuotas, createFakeScheduler, createFakeStrings,
  createFakeTelegramModule, createRecordingChannelFactory, createStaticRegistry, notImplemented,
} from '../harness/fakes.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { createTestApp } from '../harness/testApp.ts';
import type { TestApp } from '../harness/testApp.ts';

const MIN = 60_000;

async function agentApp(env?: Record<string, string>): Promise<{ t: TestApp; runner: EngineRunner; user: UserRow; conv: ConversationRow }> {
  const channels = createRecordingChannelFactory();
  const factories: Partial<Factories> = {
    createStrings: () => createFakeStrings(),
    createLedger: (s) => createFakeLedger(s.clock),
    createQuotaService: (s) => createFakeQuotas(s.clock),
    createLlmGovernance: () => createFakeGovernance(),
    createCapabilities: (_c, _f, s) => createFakeCapabilities(() => s.clock.now()),
    createIntegrationService: (s, p) => createFakeIntegrations(s.config.publicUrl, p ?? null),
    createToolRegistry: () => createStaticRegistry([]),
    createTrustModule: NOOP_FACTORIES.createTrustModule,
    // forget post-filter: sentences that mention the forgotten fact are dropped (stands in for memory_fingerprints)
    createMemoryService: () => notImplemented<MemoryService>('memory', { filterFingerprinted: (_s, xs) => xs.filter((x) => !/green tea/i.test(x)) }),
    createScheduler: (s) => createFakeScheduler(() => s.clock),
    createReminderModule: NOOP_FACTORIES.createReminderModule,
    createProactiveModule: NOOP_FACTORIES.createProactiveModule,
    createMissionModule: NOOP_FACTORIES.createMissionModule,
    createTelegramModule: (s, o) => createFakeTelegramModule(s, o),
    createBusinessModule: NOOP_FACTORIES.createBusinessModule,
    createSurfaces: NOOP_FACTORIES.createSurfaces,
    createHttpApp: NOOP_FACTORIES.createHttpApp,
    createAgentModule: (s) => createAgentModule(s, { channels }),
  };
  const t = await createTestApp({ factories, ...(env ? { env } : {}) });
  const user = t.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  const conv = t.s.conversations.resolve({ kind: 'dm', tgUserId: 1001 }, { userId: user.id, tgChatId: 1001 });
  return { t, runner: t.s.runner as EngineRunner, user, conv };
}

let seq = 0;
async function userSays(t: TestApp, conv: ConversationRow, text: string, o: { untrusted?: boolean } = {}): Promise<void> {
  seq += 1;
  t.s.repos.inputs.add({
    conversationId: conv.id, kind: o.untrusted ? 'forward' : 'text', author: 'owner', untrusted: !!o.untrusted, content: [{ type: 'text', text }],
    tgUpdateId: 90_000 + seq, tgChatId: 1001, tgMessageId: 500 + seq, fromTgUserId: 1001, replyToCardId: null,
  });
  t.s.runner.kick(conv.id);
  await t.settle();
}
const cur = (t: TestApp, conv: ConversationRow) => t.s.repos.conversations.get(conv.id)!;
const rowsOf = (t: TestApp, conv: ConversationRow, epoch: number) => t.s.repos.messages.load(conv.id, epoch);
const firstText = (m: { content: { content: unknown } }) => (m.content.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('epochs (01 §5.9)', () => {
  it('idle rotation uses the handoff fork: same prefix plus one non-persisted row; the seed is the first user row', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().text('Noted: you like tea.').usage({ input_tokens: 20_000 }));
    await userSays(x.t, x.conv, 'I like tea');
    const before = x.t.llm.requests.length;
    // handoff_fork at lastRequestAt + 45 min
    x.t.llm.push(say('Owner likes tea. Open threads: none.'));
    await x.t.advance(45 * MIN);
    expect(x.t.llm.requests.length).toBe(before + 1);
    const fork = x.t.llm.requests[before]!;
    const last = fork.messages[fork.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('handoff_request');
    expect(fork.max_tokens).toBe(4_000);
    expect(JSON.stringify(rowsOf(x.t, x.conv, 1))).not.toContain('handoff_request');
    expect(x.t.s.repos.conversations.currentEpoch(x.conv.id).handoffSummary).toContain('Owner likes tea');
    // > 55 min idle with ≥ 12 000 tokens → rotation at the next run start
    await x.t.advance(11 * MIN);
    x.t.llm.push(say('Welcome back.'));
    await userSays(x.t, x.conv, 'hi again');
    const c = cur(x.t, x.conv);
    expect(c.epoch).toBe(2);
    expect(x.t.s.repos.conversations.currentEpoch(x.conv.id)).toMatchObject({ reason: 'idle', seedKind: 'handoff' });
    const r2 = rowsOf(x.t, x.conv, 2);
    expect(r2[0]!).toMatchObject({ role: 'user', kind: 'seed' });
    expect(firstText(r2[0]!)).toMatch(/^<previous_epoch_summary source="handoff">\nOwner likes tea/);
    expect(JSON.stringify(r2[0]!.content)).toContain('hi again');
    expect(checkEpochGrammar(r2)).toEqual([]);
    x.t.llm.assertInvariants();
  });

  it('a tainted epoch gets a deterministic seed with no model text', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().text('MODEL SAID THIS about the forward').usage({ input_tokens: 20_000 }));
    await userSays(x.t, x.conv, 'Forwarded: buy crypto now!', { untrusted: true });
    x.t.llm.push(turn().text('MODEL SAID THAT too').usage({ input_tokens: 20_000 }));
    await userSays(x.t, x.conv, 'what do you think about it?');
    expect(x.t.s.repos.conversations.currentEpoch(x.conv.id).taint).toContain('forward');
    const n = x.t.llm.requests.length;
    await x.t.advance(56 * MIN);
    expect(x.t.llm.requests.length).toBe(n); // no fork for a tainted epoch
    x.t.llm.push(say('Fresh start.'));
    await userSays(x.t, x.conv, 'new topic');
    const seedRow = rowsOf(x.t, x.conv, cur(x.t, x.conv).epoch)[0]!;
    const seed = firstText(seedRow);
    expect(seed).toMatch(/^<previous_epoch_summary source="deterministic">/);
    expect(seed).toContain(TAINTED_LINE);
    expect(seed).toContain('what do you think about it?');
    expect(seed).not.toContain('MODEL SAID');
    expect(seed).not.toContain('buy crypto'); // untrusted inputs are not quoted
    expect(x.t.s.repos.conversations.currentEpoch(x.conv.id)).toMatchObject({ seedKind: 'deterministic', taint: [] });
    x.t.llm.assertInvariants();
  });

  it('forget rotation: handoff regenerated with exclusions and post-filtered; the old epoch is shredded (rows gone, DEK destroyed)', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(say('Noted.'));
    await userSays(x.t, x.conv, 'I like green tea and I work at Kaspi');
    expect(rowsOf(x.t, x.conv, 1).length).toBeGreaterThan(0);
    x.t.llm.push(say('Owner works at Kaspi. Owner likes green tea.'));
    x.runner.requestRotation(x.conv.id, 'forget', { excludeTexts: ['likes green tea'] });
    await x.t.advance(0); // epoch_rotate
    await x.t.advance(0); // shred_epoch
    const fork = x.t.llm.requests[x.t.llm.requests.length - 1]!;
    expect(JSON.stringify(fork.messages[fork.messages.length - 1])).toContain('likes green tea'); // passed transiently
    expect(cur(x.t, x.conv).epoch).toBe(2);
    expect(cur(x.t, x.conv).rotatePending).toBeNull();
    expect(rowsOf(x.t, x.conv, 1)).toEqual([]);
    expect(x.t.s.crypto.isDestroyed(`e:${x.conv.id}:1`)).toBe(true);
    x.t.llm.push(say('Hi!'));
    await userSays(x.t, x.conv, 'hello');
    const seed = firstText(rowsOf(x.t, x.conv, 2)[0]!);
    expect(seed).toContain('works at Kaspi');
    expect(seed).not.toMatch(/green tea/i);
    expect(JSON.stringify(x.t.llm.requests[x.t.llm.requests.length - 1])).not.toMatch(/green tea/i);
  });

  it("context_mode becomes inline after the 400 \"role 'system' is not supported\" and the same inputs re-run once", async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().error('bad_request', "messages: role 'system' is not supported", { code: 'system_role_unsupported' }), say('Answer in inline mode.'));
    await userSays(x.t, x.conv, 'question');
    const c = cur(x.t, x.conv);
    expect(c.contextMode).toBe('inline');
    expect(c.epoch).toBe(2);
    const req = x.t.llm.requests[1]!;
    expect(req.messages.some((m) => m.role === 'system')).toBe(false);
    const firstRow = req.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(firstRow[firstRow.length - 1]!.text).toMatch(/^<gora_context v="1">/);
    expect(JSON.stringify(firstRow)).toContain('question');
    const r2 = rowsOf(x.t, x.conv, 2);
    expect(r2.map((m) => m.kind)).toEqual(['seed', 'assistant']);
    expect(checkEpochGrammar(r2)).toEqual([]);
  });

  it('groq profile: size rotation happens synchronously at run start with a fast-model handoff note (03 R2)', async () => {
    const x = await agentApp({ LLM_PROVIDER: 'groq' });
    app = x.t;
    expect(x.t.s.config.profile.provider).toBe('groq');
    expect(cur(x.t, x.conv).model).toMatch(/^groq:/);
    const long = 'details '.repeat(1_400); // > 2 400 estimated tokens in the epoch
    x.t.llm.push(say(`Summary: ${long}`));
    await userSays(x.t, x.conv, 'plan my week');
    x.t.llm.pushParse('handoff', { note: 'Owner is planning the week.' });
    x.t.llm.push(say('Sure.'));
    await userSays(x.t, x.conv, 'continue');
    expect(cur(x.t, x.conv).epoch).toBe(2);
    expect(x.t.llm.parseRequests.map((p) => p.purpose)).toContain('handoff');
    const seed = firstText(rowsOf(x.t, x.conv, 2)[0]!);
    expect(seed).toMatch(/^<previous_epoch_summary source="handoff">\nOwner is planning the week\./);
    x.t.llm.assertInvariants({ provider: 'groq' });
  });
});
