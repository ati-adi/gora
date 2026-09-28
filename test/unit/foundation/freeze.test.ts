// WP0 pre-freeze pass: the contract additions and harness capabilities every implementer relies on (docs/spec/04-foundation-notes.md).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.ts';
import {
  ALLOWED_UPDATES_ALL, allowedUpdates, NUDGE_KINDS, STRING_KEYS, uiLang, USER_DATA_TABLES, type IntegrationProvider, type MainRequest, type StringKey,
} from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { BadRequestLlmError, ConfigError } from '../../../src/kernel/errors.ts';
import { formatDisplay } from '../../../src/kernel/timeMath.ts';
import {
  createFakeCrypto, createFakeIntegrations, createFakeKeyStore, createFakeScheduler, createFakeStrings, createMemoryCoreRepos, createRecordingChannelFactory,
} from '../../harness/fakes.ts';
import { checkRequest, checkRequestSequence } from '../../harness/invariants.ts';
import { ScriptedTransport, turn } from '../../harness/scriptedTransport.ts';
import { createTestApp } from '../../harness/testApp.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';

describe('contracts added before the freeze', () => {
  it('allowedUpdates filters by FEATURE_BUSINESS / FEATURE_GUEST (01 §4.5)', () => {
    expect(ALLOWED_UPDATES_ALL).toHaveLength(13);
    expect(allowedUpdates({ business: true, guest: true })).toEqual([...ALLOWED_UPDATES_ALL]);
    const none = allowedUpdates({ business: false, guest: false });
    expect(none).toEqual(['message', 'edited_message', 'callback_query', 'stopped_message_generation', 'my_chat_member', 'pre_checkout_query', 'subscription', 'message_reaction']);
    expect(allowedUpdates({ business: true, guest: false })).not.toContain('guest_message');
  });
  it('i18n: uiLang maps ru/uk/kk/be to ru; STRING_KEYS placeholders match their vars', () => {
    expect(['ru', 'uk-UA', 'kk', 'be', 'RU'].map(uiLang)).toEqual(['ru', 'ru', 'ru', 'ru', 'ru']);
    expect(['en', 'de', '', null, undefined].map(uiLang)).toEqual(['en', 'en', 'en', 'en', 'en']);
    for (const [key, v] of Object.entries(STRING_KEYS)) {
      const found = [...v.en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(found, key).toEqual([...v.vars].sort());
    }
    for (const k of ['step_cap', 'temp_error', 'refusal', 'prompt_budget', 'stopped', 'busy_retrying', 'already_handled', 'late', 'missed'] as StringKey[]) expect(STRING_KEYS[k]).toBeDefined();
    expect((STRING_KEYS as Record<string, unknown>)['why_now']).toBeUndefined(); // spec 05 A5: no "Why now:" line
    expect(STRING_KEYS.prompt_budget.en).toBe('That was too long for me to process — could you split it?'); // 03 R2 verbatim
  });
  it('the fake Strings echoes keys (and sorted vars) and records lookups', () => {
    const s = createFakeStrings();
    expect(s.t('stopped', 'en')).toBe('stopped');
    expect(s.t('busy_retrying', 'ru', { seconds: 12 })).toBe('busy_retrying(seconds=12)');
    expect(s.t('quota_exceeded', 'kk', { what: 'turns', used: 40, limit: 40, resets: '00:00' })).toBe('quota_exceeded(limit=40,resets=00:00,used=40,what=turns)');
    expect(s.calls.map((c) => c.lang)).toEqual(['en', 'ru', 'ru']);
  });
  it('NUDGE_KINDS lists every kind once; business_drafts is in the deletion plan', () => {
    expect(new Set(NUDGE_KINDS).size).toBe(8);
    expect(USER_DATA_TABLES.map((t) => t.table)).toContain('business_drafts');
  });
});

describe('ScriptedTransport: 03 R1/R6 signals and error codes', () => {
  const req = (): MainRequest => ({ model: 'groq:openai/gpt-oss-120b', max_tokens: 1200, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  it("signal('retry') emits {index:-1,type:'retry'} and drops the failed attempt from the final message", async () => {
    const llm = new ScriptedTransport({ chunkSize: 100 });
    llm.push(turn().text('partial draft').signal('retry').text('clean answer'));
    const seen: string[] = [];
    const r = await llm.stream(req(), { onText: (d) => seen.push(`text:${d}`), onBlockStart: (b) => seen.push(`${b.index}:${b.type}${b.name ? ':' + b.name : ''}`) }, new AbortController().signal);
    expect(seen).toEqual(['0:text', 'text:partial draft', '-1:retry', '0:text', 'text:clean answer']);
    expect(r.message.content).toEqual([{ type: 'text', text: 'clean answer', citations: null }]);
    expect(r.message.stop_reason).toBe('end_turn');
  });
  it("signal('busy', seconds) is emitted where scripted; nothing is dropped", async () => {
    const llm = new ScriptedTransport();
    llm.push(turn().signal('busy', '12').text('ok').toolUse('time_resolve', { expression: 'now' }, 'toolu_b'));
    const starts: string[] = [];
    const r = await llm.stream(req(), { onText() {}, onBlockStart: (b) => starts.push(`${b.index}:${b.type}:${b.name ?? ''}`) }, new AbortController().signal);
    expect(starts).toEqual(['-1:busy:12', '0:text:', '1:tool_use:time_resolve']);
    expect(r.message.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(r.message.stop_reason).toBe('tool_use');
  });
  it("error('bad_request', msg, {code}) → BadRequestLlmError with that code (e.g. 'prompt_budget', 'tool_use_failed')", async () => {
    const llm = new ScriptedTransport();
    llm.push(turn().error('bad_request', 'prompt_budget', { code: 'prompt_budget' }), turn().text('x').error('bad_request'));
    const e1 = await llm.stream(req(), { onText() {} }, new AbortController().signal).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BadRequestLlmError);
    expect((e1 as BadRequestLlmError).code).toBe('prompt_budget');
    const e2 = await llm.stream(req(), { onText() {} }, new AbortController().signal).catch((e: unknown) => e);
    expect((e2 as BadRequestLlmError).code).toBeNull();
  });
  it('pushParse accepts the new side purposes', async () => {
    const { z } = await import('zod');
    const llm = new ScriptedTransport();
    llm.pushParse('make_file', { filename: 'a.csv', content: 'x,y' }).pushParse('handoff', { note: 'n' }).pushParse('summarize', { summary: 's' });
    const r = await llm.parse({ purpose: 'make_file', system: 's', user: 'u', schema: z.object({ filename: z.string(), content: z.string() }), meta: { userId: 'u1', runId: 'r1' } });
    expect(r.parsed).toEqual({ filename: 'a.csv', content: 'x,y' });
    expect(llm.parseRequests[0]!.meta).toEqual({ userId: 'u1', runId: 'r1' });
  });
});

describe('db/sqlite tx(): COMMIT / ROLLBACK failures', () => {
  it('a failing COMMIT rolls back and leaves no open transaction (deferred FK)', () => {
    const t = openTmpDb();
    try {
      const db = t.db;
      db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED) STRICT;');
      expect(() => db.tx(() => db.prepare('INSERT INTO c(pid) VALUES (99)').run())).toThrow(/FOREIGN KEY/);
      expect(db.raw.isTransaction).toBe(false);
      expect(() => db.tx(() => db.tx(() => db.prepare('INSERT INTO c(pid) VALUES (98)').run()))).toThrow(/FOREIGN KEY/);
      expect(db.raw.isTransaction).toBe(false);
      db.tx(() => {
        db.prepare('INSERT INTO p(id) VALUES (1)').run();
        db.prepare('INSERT INTO c(pid) VALUES (1)').run();
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM c').get<{ n: number }>()!.n).toBe(1);
    } finally {
      t.cleanup();
    }
  });
  it("fn's error survives when the transaction is already gone", () => {
    const t = openTmpDb();
    try {
      expect(() => t.db.tx(() => { t.db.exec('ROLLBACK'); throw new Error('original'); })).toThrow('original');
      expect(t.db.raw.isTransaction).toBe(false);
      t.db.tx(() => t.db.prepare(`INSERT INTO kv(key, value_json, updated_at) VALUES ('k', '1', 0)`).run());
    } finally {
      t.cleanup();
    }
  });
});

describe('timeMath formatDisplay uses 3-letter months', () => {
  it("September is 'Sep', never ICU's 'Sept'", () => {
    expect(formatDisplay(Date.UTC(2026, 8, 28, 9, 3), 'Asia/Almaty', 'en')).toBe('Mon 28 Sep, 14:03 (Asia/Almaty)');
    expect(formatDisplay(Date.UTC(2026, 5, 7, 6, 0), 'UTC', 'de')).toBe('Sun 7 Jun, 06:00 (UTC)');
  });
});

describe('config additions', () => {
  const issuesOf = (env: Record<string, string>): string[] => {
    try {
      loadConfig(env);
      return [];
    } catch (e) {
      return (e as ConfigError).issues;
    }
  };
  const key = () => Buffer.alloc(32, 7).toString('base64');
  it('BACKUP_DIR defaults to ./backups and is refused under DATA_DIR in production', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).backupDir).toBe('./backups');
    const prod = { NODE_ENV: 'production', TELEGRAM_BOT_TOKEN: '123456:AAAA-fake-token-for-tests', TELEGRAM_WEBHOOK_SECRET: 'w', GORA_KEK: key(), GORA_CALLBACK_KEY: key(), GORA_HASH_KEY: key(), GROQ_API_KEY: 'gsk_x', DATA_DIR: '/data', KEYS_DB_PATH: '/keys/k.db', INTEGRATIONS_PROVIDER: 'none', PUBLIC_URL: 'https://bot.gora-test.dev' };
    expect(issuesOf({ ...prod, BACKUP_DIR: '/backups' })).toEqual([]);
    expect(issuesOf({ ...prod, BACKUP_DIR: '/data/backups' }).join()).toContain('BACKUP_DIR');
  });
  it('a real bot token requires the three secrets outside tests (ALLOW_INSECURE_DEV_KEYS=1 overrides)', () => {
    const dev = { TELEGRAM_BOT_TOKEN: '123456:AAAA-fake-token-for-tests' };
    expect(issuesOf(dev).join()).toMatch(/GORA_KEK, GORA_CALLBACK_KEY and GORA_HASH_KEY are required/);
    expect(issuesOf({ ...dev, ALLOW_INSECURE_DEV_KEYS: '1' })).toEqual([]);
    expect(issuesOf({ ...dev, GORA_KEK: key(), GORA_CALLBACK_KEY: key(), GORA_HASH_KEY: key() })).toEqual([]);
    expect(issuesOf({})).toEqual([]); // no token: dev keys are fine (sim, local tests)
    expect(loadConfig({ NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '123456:AAAA-fake-token-for-tests' }).secrets.insecureDefaults).toBe(true);
  });
});

describe('request invariants: toolset byte identity and bare tokens', () => {
  const base = (tools: unknown[], user = 'u1'): MainRequest =>
    ({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: `hi ${user}` }] }], tools, system: [{ type: 'text', text: 'SYS' }], metadata: { user_id: user } }) as unknown as MainRequest;
  it('same tool names with different bytes (key order) are a violation', () => {
    const t1 = [{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }];
    const t2 = [{ description: 'd', name: 'a', input_schema: { properties: {}, type: 'object' } }];
    expect(checkRequestSequence([base(t1, 'u1'), base(t2, 'u2')], { provider: 'groq' }).join()).toMatch(/tools differ byte-wise/);
    expect(checkRequestSequence([base(t1, 'u1'), base(structuredClone(t1), 'u2')], { provider: 'groq' })).toEqual([]);
  });
  it('a bare bot token (digits:secret) is caught (G8)', () => {
    expect(checkRequest(base([]), { provider: 'groq' })).toEqual([]);
    const leak = base([]);
    (leak.messages[0]!.content as Array<{ text: string }>)[0]!.text = 'my token is 8878123456:AAH-abcdefghijklmnopqrstuvwxyz012345';
    expect(checkRequest(leak, { provider: 'groq' }).join()).toMatch(/bare bot token/);
  });
});

describe('fakes added before the freeze', () => {
  it('crypto.ensureDek records the real owner, so destroyOwner covers epoch DEKs', () => {
    const ks = createFakeKeyStore();
    const c = createFakeCrypto(ks, new Uint8Array(32));
    c.ensureDek('e:c_1:1', 'user_1', 'epoch');
    const ct = c.seal('e:c_1:1', 'secret', 'messages|content_enc|c_1:1:1');
    c.ensureDek('e:c_1:1', 'someone_else', 'epoch'); // idempotent: the owner does not change
    expect(ks.deks.get('e:c_1:1')!.owner).toBe('user_1');
    expect(c.destroyOwner('user_1')).toBe(1);
    expect(() => c.open(ct, 'messages|content_enc|c_1:1:1')).toThrow(/DEK destroyed/);
    expect(() => c.ensureDek('e:c_1:1', 'user_1', 'epoch')).toThrow(/DEK destroyed/);
  });
  it('memory repos: users.list / iterate (keyset), settings.homeCity, run visibleText / stopCategory', () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 28));
    const r = createMemoryCoreRepos(clock);
    const ids = [1, 2, 3, 4, 5].map((n) => r.users.upsertFromTelegram({ id: 1000 + n, first_name: `U${n}` }).id);
    r.users.update(ids[1]!, { status: 'paused' });
    expect(r.users.list({ limit: 2 }).map((u) => u.id)).toEqual(ids.slice(0, 2));
    expect(r.users.list({ afterId: ids[1]!, limit: 10 }).map((u) => u.id)).toEqual(ids.slice(2));
    expect(r.users.list({ status: 'paused', limit: 10 }).map((u) => u.id)).toEqual([ids[1]]);
    expect([...r.users.iterate({ batchSize: 2 })].map((u) => u.id)).toEqual(ids);
    expect([...r.users.iterate({ status: 'active' })]).toHaveLength(4);
    expect(r.users.settings(ids[0]!).homeCity).toBeNull();
    r.users.updateSettings(ids[0]!, { homeCity: { name: 'Almaty', lat: 43.24, lon: 76.95 } });
    expect(r.users.settings(ids[0]!).homeCity).toEqual({ name: 'Almaty', lat: 43.24, lon: 76.95 });
    const conv = r.conversations.create({ scopeKey: 'dm:1001', kind: 'dm', userId: ids[0]!, tgChatId: 1001, threadId: null, businessConnectionId: null, route: 'chat', model: 'm', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false });
    const run = r.runs.create({ conversationId: conv.id, userId: ids[0]!, epoch: 1, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1001 }, maxTokens: 1000 });
    expect([run.visibleText, run.stopCategory]).toEqual([null, null]);
    r.runs.update(run.id, { visibleText: 'partial', stopCategory: 'user_stop' });
    expect(r.runs.get(run.id)).toMatchObject({ visibleText: 'partial', stopCategory: 'user_stop' });
    r.conversations.startEpoch(conv.id, 'user_new', 'none', []);
    expect(r.conversations.currentEpoch(conv.id).reason).toBe('user_new');
  });
  it('scheduler health, recording channel blockStart, integrations provider passthrough', async () => {
    const clock = new FakeClock(1_000);
    const sch = createFakeScheduler(() => clock);
    expect(sch.health().lastTickAt).toBeNull();
    await sch.tick();
    expect(sch.health().lastTickAt).toBe(1_000);

    const f = createRecordingChannelFactory();
    const run = { channel: 'dm_stream', replyRef: { chatId: 1 } } as never;
    const ch = f.forRun(run, {} as never, () => {});
    ch.text('bad partial');
    ch.blockStart({ index: -1, type: 'retry' });
    ch.text('good');
    ch.blockStart({ index: -1, type: 'busy', name: '7' });
    expect(ch.visibleText).toBe('good');
    expect(f.channels[0]!.log.filter((x) => x.op === 'status').map((x) => x.arg)).toEqual(['busy:7']);

    const p = { name: 'fake' } as unknown as IntegrationProvider;
    expect(createFakeIntegrations('https://x', p).provider).toBe(p);
    expect(createFakeIntegrations('https://x').provider).toBeNull();
  });
});

describe('testApp.restart() keeps the integration provider (the external world)', () => {
  it('the provider built by the IntegrationService itself (no `integrations` option) is handed to the next App', async () => {
    let built = 0;
    const t1 = await createTestApp({
      factories: { createIntegrationService: (s, provider) => createFakeIntegrations(s.config.publicUrl, provider ?? ({ name: 'fake', seq: ++built } as unknown as IntegrationProvider)) },
    });
    const p1 = t1.s.integrations.provider;
    expect(p1).not.toBeNull();
    const t2 = await t1.restart();
    try {
      expect(t2.s.integrations.provider).toBe(p1);
      expect(built).toBe(1);
      expect(t2.s.strings.t('stopped', 'en')).toMatch(/Stopped/); // WP7a's real strings (integration: stubs are gone)
      expect(t2.s.keyStore).toBe(t2.app.keyStore);
      expect(t2.app.tg.dispatcher.lagMs()).toBe(0);
      expect(t2.s.scheduler.health()).toHaveProperty('lastTickAt');
    } finally {
      await t2.close();
    }
  });
});
