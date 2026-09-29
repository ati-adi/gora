import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp, EXTERNAL_TOOLS, REAL_FACTORIES } from '../../../src/app.ts';
import { testConfig } from '../../../src/config.ts';
import type { Factories, IntegrationProvider } from '../../../src/contracts/index.ts';
import { NotBuiltError } from '../../../src/kernel/errors.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { createFakeIntegrations, createFakeLedger, NOOP_FACTORIES } from '../../harness/fakes.ts';
import { createFakeTelegram, TEST_BOT_INFO } from '../../harness/fakeTelegram.ts';
import { ScriptedTransport } from '../../harness/scriptedTransport.ts';
import { createTestApp } from '../../harness/testApp.ts';
import { makeTmpDir, removeDir, tmpPaths } from '../../harness/tmpDb.ts';
import { U } from '../../harness/updates.ts';

describe('app.ts wiring', () => {
  it('wires every factory in the §4.4 table', () => {
    const names = Object.keys(REAL_FACTORIES).sort();
    expect(names).toEqual([
      'createAgentModule', 'createBehaviourModule', 'createBrowserModule', 'createBusinessModule', 'createCapabilities', 'createCoreRepos', 'createCrypto', 'createGroupModule', 'createHttpApp', 'createIntegrationService', 'createLedger', 'createLlmGovernance',
      'createMemoryService', 'createMissionModule', 'createPrivacyService', 'createProactiveModule', 'createProfileService', 'createQuotaService', 'createReminderModule', 'createScheduler',
      'createStrings', 'createSurfaces', 'createTelegramModule', 'createToolRegistry', 'createTransport', 'createTrustModule', 'openKeyStore',
    ]);
    expect(Object.keys(NOOP_FACTORIES).sort()).toEqual(names);
  });
  it('without fallbacks, boot stops at the first stub with NotBuiltError (production behaviour) and releases the lock', async () => {
    const dir = makeTmpDir();
    const p = tmpPaths(dir);
    const config = testConfig({ DATA_DIR: p.dataDir, KEYS_DB_PATH: p.keysDbPath });
    const tg = createFakeTelegram();
    let fromReal: unknown;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp({ config, log: createMemoryLogger(), fetchImpl: tg.fetch, transport: new ScriptedTransport(), telegram: { transformers: [tg.transformer], botInfo: TEST_BOT_INFO } });
    } catch (e) {
      fromReal = e;
    }
    // Before WP1 merges this is NotBuiltError('WP1'); once every WP has merged, boot succeeds.
    if (app) await app.stop();
    else expect(fromReal).toBeInstanceOf(NotBuiltError);
    expect(existsSync(p.dbPath + '.lock')).toBe(false);
    removeDir(dir);
  });
});

describe('createTestApp()', () => {
  it('boots with every real module, serves /healthz, routes updates and sends through the outbox', async () => {
    // Integration: every WP has merged, so nothing falls back. WP7's handlers are pinned to the no-op fakes so this
    // test's own grammY handlers see the raw updates (it tests the harness plumbing, not WP7 routing).
    const t = await createTestApp({ factories: { createSurfaces: NOOP_FACTORIES.createSurfaces, createBusinessModule: NOOP_FACTORIES.createBusinessModule } });
    try {
      expect(t.app.fallbacksUsed).toEqual([]);
      expect(t.app.fallbacksUsed).not.toContain('createTransport'); // the ScriptedTransport is injected
      expect(t.s.transport).toBe(t.llm);
      expect(t.s.capabilities).toBe(t.s.caps);
      expect(t.s.profile).toBe(t.config.profile);
      expect(t.s.groq).toBeNull();
      const noSecret = await t.app.tg.webhookHandler(new Request('https://gora.test/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(U.privateText('x')) }));
      expect(noSecret.status).toBe(401);
      const health = await t.api('GET', '/healthz');
      expect(health.status).toBe(200);
      // migrations ran on the real temp gora.db
      expect(t.s.db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);

      const got: string[] = [];
      t.app.tg.bot.on('message:text', (ctx) => void got.push(ctx.msg.text));
      await t.userSends('hello Gora');
      expect(got).toEqual(['hello Gora']);

      t.s.telegram.outbox.enqueue({ idempotencyKey: 'k1', chatId: 1001, method: 'sendRichMessage', payload: { reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: 'a1:X' }]] } }, markdown: '🔐 **Approve: Send email**' });
      t.s.telegram.outbox.enqueue({ idempotencyKey: 'k1', chatId: 1001, method: 'sendRichMessage', payload: {}, markdown: 'duplicate' });
      await t.settle();
      expect(t.tg.byMethod('sendRichMessage')).toHaveLength(1);
      const card = t.lastCard();
      expect(card.markdown).toContain('Approve: Send email');
      expect(card.buttons[0]).toMatchObject({ text: '✅ Send', callback_data: 'a1:X' });

      const taps: string[] = [];
      t.app.tg.bot.on('callback_query:data', (ctx) => void taps.push(`${ctx.callbackQuery.data}@${ctx.callbackQuery.message?.message_id}`));
      await t.tap('a1:X');
      expect(taps).toEqual([`a1:X@${card.messageId}`]);

      await t.s.telegram.api.sendRichMessageDraft(1001, 99, { markdown: '<tg-thinking>Thinking…</tg-thinking>' }, { can_stop: true });
      const stops: number[] = [];
      t.app.tg.bot.on('stopped_message_generation', (ctx) => void stops.push(ctx.update.stopped_message_generation!.draft_id));
      await t.pressStop();
      expect(stops).toEqual([99]);
    } finally {
      await t.close();
    }
    expect(existsSync(t.dir)).toBe(false);
  });

  it('registries exist before module factories run; s.telegram is a pre-gateway until the Telegram module is built', async () => {
    const preGatewayErrors: string[] = [];
    const sentIds: string[] = [];
    const factories: Partial<Factories> = {
      createLedger: (s) => {
        for (const f of [() => s.telegram.api, () => s.telegram.outbox.enqueue({ idempotencyKey: 'x', chatId: 1, method: 'sendMessage', payload: {} })]) {
          try {
            f();
          } catch (e) {
            preGatewayErrors.push(String((e as Error).message));
          }
        }
        s.telegram.callbacks.register('ob', async (c) => ({ text: `ob ${c.parts.join(':')}` }));
        s.telegram.outbox.onSent('nudge', (refId, sent) => void sentIds.push(`${refId}:${sent[0]?.messageId}`)); // buffered
        s.scheduler.register('retention_sweep', async () => ({ status: 'done' }));
        s.contextProviders.push({ name: 'test', surfaces: ['dm'], parts: async () => [] });
        s.runHooks.push({ name: 'onboarding', onRunFinished() {} });
        s.quotas.registerCounter('mission', () => 1);
        return createFakeLedger(s.clock);
      },
    };
    // WP7a registers `ob` itself; pin it to the no-op fake so the test's own `ob` registration is the only one.
    const t = await createTestApp({ factories: { ...factories, createSurfaces: NOOP_FACTORIES.createSurfaces } });
    try {
      expect(preGatewayErrors).toHaveLength(2);
      expect(preGatewayErrors[0]).toMatch(/s\.telegram\.api used before the Telegram module was built/);
      expect(preGatewayErrors[1]).toMatch(/s\.telegram\.outbox\.enqueue used before/);
      expect(await t.s.telegram.callbacks.dispatch({ kind: 'ob', parts: ['mem', 'y'], fromTgId: 1, user: undefined, callbackQueryId: 'q' })).toEqual({ text: 'ob mem:y' });
      // registered first (at createLedger time), before every real module factory adds its own
      expect(t.s.contextProviders.map((p) => p.name)[0]).toBe('test');
      expect(t.s.runHooks.map((h) => h.name)[0]).toBe('onboarding');
      expect(t.s.quotas.check('u1', 'mission').used).toBe(1);
      // the buffered onSent hook was installed on the real outbox before it started
      t.s.telegram.outbox.enqueue({ idempotencyKey: 'n1', chatId: 1001, method: 'sendRichMessage', payload: {}, markdown: '💡 x', refKind: 'nudge', refId: 'ng_1' });
      await t.settle();
      const sent = t.tg.callsOf('sendRichMessage').at(-1)!;
      expect(sentIds).toEqual([`ng_1:${(sent.result as { message_id: number }).message_id}`]);
    } finally {
      await t.close();
    }
  });

  it('every cross-WP service is wired (WP0 contract additions)', async () => {
    const t = await createTestApp();
    try {
      const s = t.s;
      for (const k of ['toolkits', 'untrusted', 'grants', 'trustedTargets', 'location', 'notices', 'deepLinks', 'choices', 'groups', 'guests', 'runHooks'] as const) expect(s[k], k).toBeDefined();
      expect(s.location).toBe(s.caps.location);
      // the registry holds WP5's own tools plus every external TOOLS array (app.ts EXTERNAL_TOOLS)
      const names = new Set(s.registry.all().map((x) => x.name));
      for (const tool of EXTERNAL_TOOLS) expect(names.has(tool.name), tool.name).toBe(true);
      expect(names.size).toBeGreaterThan(EXTERNAL_TOOLS.length);
      // the real CoreRepos
      const u = s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim' }, { dmChatId: 1001 });
      expect(s.repos.users.getByTg(1001)?.id).toBe(u.id);
      // the real Telegram module's channel factory
      const conv = s.repos.conversations.create({ scopeKey: 'dm:1001', kind: 'dm', userId: u.id, tgChatId: 1001, threadId: null, businessConnectionId: null, route: 'chat', model: 'm', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false });
      const run = s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1001 }, maxTokens: 1000 });
      const ch = t.app.tg.channels.forRun(run, conv, () => {});
      ch.text('hi');
      expect(ch.visibleText).toBe('hi');
    } finally {
      await t.close();
    }
  });

  it('advance() moves the fake clock and ticks the scheduler', async () => {
    const t = await createTestApp({ now: Date.UTC(2026, 8, 28, 9) });
    try {
      const fired: number[] = [];
      t.s.scheduler.register('reminder_fire', async (_j, ctx) => (fired.push(ctx.now), { status: 'done' }));
      t.s.scheduler.schedule({ kind: 'reminder_fire', runAt: t.clock.now() + 60_000, refId: 'r1' });
      await t.advance(30_000);
      expect(fired).toEqual([]);
      await t.advance(30_000);
      expect(fired).toEqual([Date.UTC(2026, 8, 28, 9, 1)]);
    } finally {
      await t.close();
    }
  });

  it('restart() reopens the same files and shares the fake Telegram and LLM', async () => {
    const t = await createTestApp();
    // WP2 writes kv.bot_flags / kv.commands_hash at boot (§4.5), so use a key of the test's own.
    t.s.db.prepare(`INSERT INTO kv(key, value_json, updated_at) VALUES ('restart_marker', '{}', 1)`).run();
    await t.send(U.privateText('before'));
    const t2 = await t.restart();
    try {
      expect(t2.dir).toBe(t.dir);
      expect(t2.tg).toBe(t.tg);
      expect(t2.llm).toBe(t.llm);
      expect(t2.s.db.prepare(`SELECT key FROM kv WHERE key = 'restart_marker'`).all()).toEqual([{ key: 'restart_marker' }]);
      expect(t2.clock.now()).toBe(t.clock.now());
    } finally {
      await t2.close();
    }
    expect(existsSync(t.dir)).toBe(false);
  });

  it("restart() hands the IntegrationService's own default provider to the next App (the fake external world survives)", async () => {
    // Mimics WP5: when no provider is passed, the service builds its default fake provider and exposes it as `provider`.
    const given: Array<IntegrationProvider | undefined> = [];
    const createIntegrationService: Factories['createIntegrationService'] = (s, provider) => {
      given.push(provider);
      const p = provider ?? ({ name: 'fake', sentMail: [] as string[] } as unknown as IntegrationProvider);
      return createFakeIntegrations(s.config.publicUrl, p);
    };
    const t = await createTestApp({ factories: { createIntegrationService } });
    const built = t.s.integrations.provider as unknown as { sentMail: string[] };
    built.sentMail.push('msg_1');
    const t2 = await t.restart();
    try {
      expect(given[0]).toBeUndefined();
      expect(given[1]).toBe(built);
      expect(t2.s.integrations.provider).toBe(built);
      expect((t2.s.integrations.provider as unknown as { sentMail: string[] }).sentMail).toEqual(['msg_1']);
    } finally {
      await t2.close();
    }
  });

  it('can run with the Groq profile', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'groq' } });
    try {
      expect(t.s.profile).toMatchObject({ id: 'groq-free', toolMode: 'toolkits', caching: false });
    } finally {
      await t.close();
    }
  });
});
