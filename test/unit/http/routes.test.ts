// WP8: the §12 API routes beyond the e2e flows — Home with the provider and today's LLM budget (03 R8), Settings incl.
// the voice replies toggle (03 R8), the nudge budget cap and pause, Tasks (to-dos, reminders), Connections (level,
// trusted contacts), Ledger (list, verify, planned), Memory incognito/consent, Secretary/Billing degradation, and
// ownership checks (another Telegram user never sees or changes someone else's rows).
import { afterEach, describe, expect, it } from 'vitest';
import type { Factories, LlmGovernance, Services } from '../../../src/contracts/index.ts';
import { createFakeGovernance, NOOP_FACTORIES } from '../../harness/fakes.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const EVE = { id: 4242, first_name: 'Eve', language_code: 'en' };

function governance(): LlmGovernance {
  const g = createFakeGovernance();
  return { governor: g.governor, budget: { allow: () => true, snapshot: () => ({ 'openai/gpt-oss-120b': { rpdUsed: 120, rpdLimit: 1000, tpmRemaining: 7000 } }) } };
}

async function boot(extra: Partial<Factories> = {}, config?: NonNullable<Parameters<typeof createTestApp>[0]>['config']): Promise<TestApp> {
  t = await createTestApp({
    factories: {
      createAgentModule: NOOP_FACTORIES.createAgentModule,
      createTelegramModule: NOOP_FACTORIES.createTelegramModule,
      createSurfaces: NOOP_FACTORIES.createSurfaces,
      createBusinessModule: NOOP_FACTORIES.createBusinessModule,
      createLlmGovernance: () => governance(),
      ...extra,
    },
    ...(config ? { config } : {}),
  });
  expect((await t.api('GET', '/api/me')).status).toBe(200);
  return t;
}
const me = (app: TestApp) => app.s.repos.users.getByTg(TEST_USER.id)!;
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;

describe('GET /api/me and /api/home (03 R8)', () => {
  it('home shows the provider, the model and today\'s LLM budget snapshot', async () => {
    const app = await boot();
    const h = await json<{ llm: { provider: string; profile: string; model: string; budget: Array<{ model: string; rpdUsed: number; rpdLimit: number }> }; pendingApprovals: number; paused: boolean; incognitoUntil: number | null; usage: Array<{ kind: string; used: number; limit: number }> }>(app.api('GET', '/api/home'));
    expect(h.llm.provider).toBe(app.s.profile.provider);
    expect(h.llm.profile).toBe(app.s.profile.id);
    expect(h.llm.model).toBe(app.s.profile.models.main);
    expect(h.llm.budget).toEqual([{ model: 'openai/gpt-oss-120b', rpdUsed: 120, rpdLimit: 1000, tpmRemaining: 7000 }]);
    expect(h.pendingApprovals).toBe(0);
    expect(h.paused).toBe(false);
    expect(h.incognitoUntil).toBeNull();
    expect(h.usage.find((u) => u.kind === 'turn')?.limit).toBe(app.config.plans.free.turnsPerDay);
  });

  it('home on the Groq profile reports groq', async () => {
    t = await createTestApp({ env: { LLM_PROVIDER: 'groq' }, factories: { createLlmGovernance: () => governance(), createAgentModule: NOOP_FACTORIES.createAgentModule, createTelegramModule: NOOP_FACTORIES.createTelegramModule, createSurfaces: NOOP_FACTORIES.createSurfaces, createBusinessModule: NOOP_FACTORIES.createBusinessModule } });
    const h = await json<{ llm: { provider: string; profile: string } }>(t.api('GET', '/api/home'));
    expect(h.llm).toMatchObject({ provider: 'groq', profile: 'groq-free' });
  });

  it('me carries flags, plan and language', async () => {
    const app = await boot();
    const m = await json<{ user: { plan: string; lang: string; voiceReplies: boolean }; flags: { voiceReplies: boolean; business: boolean }; provider: { id: string } }>(app.api('GET', '/api/me'));
    expect(m.user).toMatchObject({ plan: 'free', lang: 'en', voiceReplies: false });
    expect(m.flags.voiceReplies).toBe(true);
    expect(m.provider.id).toBe(app.s.profile.id);
    const ru = await json<{ user: { lang: string } }>(app.api('GET', '/api/me', undefined, { user: { id: 5555, first_name: 'Иван', language_code: 'uk' } }));
    expect(ru.user.lang).toBe('ru');
  });
});

describe('Settings (01 §12, 03 R8)', () => {
  it('voice replies toggle writes users.voice_replies; refused when the feature is off', async () => {
    const app = await boot();
    const r = await json<{ voiceReplies: boolean; voiceAvailable: boolean }>(app.api('PATCH', '/api/settings', { voiceReplies: true }));
    expect(r).toMatchObject({ voiceReplies: true, voiceAvailable: true });
    expect(me(app).voiceReplies).toBe(true);
    await app.api('PATCH', '/api/settings', { voiceReplies: false });
    expect(me(app).voiceReplies).toBe(false);
    await app.close();
    t = undefined;
    const off = await boot({}, { features: { voiceReplies: false } } as never);
    const res = await off.api('PATCH', '/api/settings', { voiceReplies: true });
    expect(res.status).toBe(422);
    expect(me(off).voiceReplies).toBe(false);
  });

  it('nudge budget is capped by the plan; quiet hours and pause are saved and ledgered', async () => {
    const app = await boot();
    expect((await app.api('PATCH', '/api/settings', { nudgeBudget: app.config.plans.free.nudgeBudgetMax + 1 })).status).toBe(422);
    const ok = await json<{ settings: { nudgeBudget: number; quietStart: string } ; paused: boolean }>(app.api('PATCH', '/api/settings', { nudgeBudget: 2, quietStart: '23:30', paused: true }));
    expect(ok.settings).toMatchObject({ nudgeBudget: 2, quietStart: '23:30' });
    expect(ok.paused).toBe(true);
    expect(me(app).status).toBe('paused');
    const kinds = app.s.ledger.list(me(app).id, { limit: 10 }).map((e) => e.kind);
    expect(kinds).toContain('pause');
    expect(kinds).toContain('settings');
    expect((await app.api('PATCH', '/api/settings', { quietStart: '25:00' })).status).toBe(400);
    expect((await app.api('PATCH', '/api/settings', { tz: 'Not/AZone' })).status).toBe(400);
  });

  it('manual tz changes users.tz with source manual; home city is stored', async () => {
    const app = await boot();
    await app.api('PATCH', '/api/settings', { tz: 'Europe/Kyiv', homeCity: { name: 'Kyiv', lat: 50.45, lon: 30.52 } });
    expect(me(app)).toMatchObject({ tz: 'Europe/Kyiv', tzSource: 'manual' });
    expect(app.s.repos.users.settings(me(app).id).homeCity).toEqual({ name: 'Kyiv', lat: 50.45, lon: 30.52 });
  });
});

describe('Memory toggles', () => {
  it('incognito on/off and memory consent', async () => {
    const app = await boot();
    const on = await json<{ incognitoUntil: number }>(app.api('POST', '/api/memory/incognito', { on: true, minutes: 30 }));
    expect(on.incognitoUntil).toBe(app.clock.now() + 30 * 60_000);
    expect(me(app).incognitoUntil).toBe(on.incognitoUntil);
    const off = await json<{ incognitoUntil: number | null }>(app.api('POST', '/api/memory/incognito', { on: false }));
    expect(off.incognitoUntil).toBeNull();
    expect(me(app).incognitoUntil).toBeNull();
    await app.api('PATCH', '/api/memory/consent', { on: true });
    expect(me(app).memoryConsent).toBe(true);
    expect(app.s.repos.users.hasConsent(me(app).id, 'memory')).toBe(true);
    await app.api('PATCH', '/api/memory/consent', { on: false });
    expect(me(app).memoryConsent).toBe(false);
  });
});

describe('Tasks', () => {
  it('to-dos toggle idempotently; reminders cancel; another user gets 404', async () => {
    const app = await boot();
    const u = me(app);
    const scope = { kind: 'user' as const, userId: u.id };
    const list = app.s.todos.apply(scope, u.id, { action: 'add', text: 'Buy milk' });
    const todo = list[0]!;
    const r1 = await json<{ todos: Array<{ id: string; done: boolean }> }>(app.api('PATCH', `/api/todos/${todo.id}`, { done: true }));
    expect(r1.todos.find((x) => x.id === todo.id)?.done).toBe(true);
    const r2 = await json<{ todos: Array<{ id: string; done: boolean }> }>(app.api('PATCH', `/api/todos/${todo.id}`, { done: true }));
    expect(r2.todos.find((x) => x.id === todo.id)?.done).toBe(true);
    expect((await app.api('PATCH', `/api/todos/${todo.id}`, { done: false }, { user: EVE })).status).toBe(404);

    const rem = app.s.reminders.create({ scope, userId: u.id, kind: 'reminder', text: 'Call mom', atLocal: '2026-09-29T10:00', tz: 'Asia/Almaty', chatId: u.tgUserId });
    const tasks = await json<{ reminders: Array<{ id: string }>; todos: unknown[] }>(app.api('GET', '/api/tasks'));
    expect(tasks.reminders.map((x) => x.id)).toContain(rem.id);
    expect((await app.api('DELETE', `/api/reminders/${rem.id}`, undefined, { user: EVE })).status).toBe(404);
    const del = await json<{ reminder: { status: string } }>(app.api('DELETE', `/api/reminders/${rem.id}`));
    expect(del.reminder.status).toBe('cancelled');
    expect((await app.api('POST', '/api/missions/nope/stop', {})).status).toBe(404);
  });
});

describe('Connections', () => {
  it('level change writes the permission and a permission_change ledger entry; trusted contacts add/remove', async () => {
    const app = await boot();
    const u = me(app);
    expect((await app.api('PATCH', '/api/connections/gmail', { level: 'act' })).status).toBe(200);
    expect(app.s.repos.users.permissions(u.id).gmail).toBe('act');
    expect(app.s.ledger.list(u.id, { limit: 5, kinds: ['permission_change'] })).toHaveLength(1);
    expect((await app.api('PATCH', '/api/connections/slack', { level: 'act' })).status).toBe(404);
    expect((await app.api('PATCH', '/api/connections/gmail', { level: 'root' })).status).toBe(400);

    expect((await app.api('POST', '/api/trusted-targets', { kind: 'email', value: 'not-an-email' })).status).toBe(400);
    const added = await json<{ items: Array<{ hmac: string; value: string; source: string }> }>(app.api('POST', '/api/trusted-targets', { kind: 'email', value: 'Anna@Example.com' }));
    expect(added.items).toHaveLength(1);
    expect(added.items[0]).toMatchObject({ value: 'anna@example.com', source: 'miniapp' });
    expect(app.s.trustedTargets.isTrusted(u.id, 'email', 'anna@example.com')).toBe(true);
    // Eve cannot see or remove it
    expect((await json<{ items: unknown[] }>(app.api('GET', '/api/trusted-targets', undefined, { user: EVE }))).items).toHaveLength(0);
    expect((await app.api('DELETE', `/api/trusted-targets/${added.items[0]!.hmac}`, undefined, { user: EVE })).status).toBe(404);
    const removed = await json<{ items: unknown[] }>(app.api('DELETE', `/api/trusted-targets/${added.items[0]!.hmac}`));
    expect(removed.items).toHaveLength(0);
    const c = await json<{ integrations: Array<{ kind: string; connected: boolean }>; grants: unknown[]; trusted: unknown[] }>(app.api('GET', '/api/connections'));
    expect(c.integrations.map((i) => i.kind)).toEqual(['gmail', 'gcal']);
  });
});

describe('Ledger', () => {
  it('lists newest first with a cursor, filters by chip, verifies the chain, shows planned items', async () => {
    const app = await boot();
    const u = me(app);
    for (let i = 0; i < 5; i++) app.s.ledger.append({ userId: u.id, actor: 'agent', kind: i % 2 ? 'memory_saved' : 'email_sent', summary: `entry ${i}` });
    const p1 = await json<{ items: Array<{ seq: number; summary: string }>; next: number | null }>(app.api('GET', '/api/ledger?limit=2'));
    expect(p1.items.map((e) => e.summary)).toEqual(['entry 4', 'entry 3']);
    expect(p1.next).not.toBeNull();
    const p2 = await json<{ items: Array<{ summary: string }> }>(app.api('GET', `/api/ledger?limit=2&cursor=${p1.next}`));
    expect(p2.items.map((e) => e.summary)).toEqual(['entry 2', 'entry 1']);
    const mem = await json<{ items: Array<{ summary: string }> }>(app.api('GET', '/api/ledger?filter=memory'));
    expect(mem.items.map((e) => e.summary)).toEqual(['entry 3', 'entry 1']);
    expect((await app.api('GET', '/api/ledger?filter=bogus')).status).toBe(400);
    expect(await json(app.api('GET', '/api/ledger/verify'))).toEqual({ ok: true, brokenAtSeq: null });
    const eve = await json<{ items: unknown[] }>(app.api('GET', '/api/ledger', undefined, { user: EVE }));
    expect(eve.items).toHaveLength(0);
    const planned = await json<Record<string, unknown[]>>(app.api('GET', '/api/ledger/planned'));
    expect(Object.keys(planned).sort()).toEqual(['approvals', 'jobs', 'missions', 'reminders', 'watchers']);
  });
});

describe('degraded modules', () => {
  it('secretary reports disabled when FEATURE_BUSINESS=false and refuses changes', async () => {
    const app = await boot({}, { features: { business: false } } as never);
    expect(await json(app.api('GET', '/api/secretary'))).toEqual({ enabled: false, connection: null, chats: [] });
    expect((await app.api('PATCH', '/api/secretary', { aiDefault: 'new_chats' })).status).toBe(404);
  });
  it('enabling AI for new chats needs `high` freshness', async () => {
    const business = (s: Services) => ({
      ...NOOP_FACTORIES.createBusinessModule(s),
      business: { ...NOOP_FACTORIES.createBusinessModule(s).business, connection: () => ({ id: 'c1', enabled: true, canReply: true, aiDefault: 'off' as const, connectedAt: 0, consentTextVersion: 'biz-v1' }), setDefault: async () => {}, listChats: () => [] },
    });
    const app = await boot({ createBusinessModule: business as Factories['createBusinessModule'] });
    const { staleInitData } = await import('../../harness/initData.ts');
    const old = staleInitData(TEST_USER, { nowMs: app.clock.now(), ageSec: 20 * 60 });
    const r = await app.api('PATCH', '/api/secretary', { aiDefault: 'new_chats' }, { initData: old });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ need: 'high' });
    expect((await app.api('PATCH', '/api/secretary', { aiDefault: 'off' }, { initData: old })).status).toBe(200);
    expect((await app.api('PATCH', '/api/secretary', { aiDefault: 'new_chats' })).status).toBe(200);
  });
  it('billing degrades to the user row when payments are not available', async () => {
    const app = await boot();
    const b = await json<{ plan: string; plans: Array<{ id: string; priceXtr: number }> }>(app.api('GET', '/api/billing'));
    expect(b.plan).toBe('free');
    expect(b.plans.map((p) => [p.id, p.priceXtr])).toEqual([['free', 0], ['plus', 500], ['pro', 1500]]);
    expect((await app.api('POST', '/api/billing/cancel', {})).status).toBe(409);
  });
  it('privacy disclosure lists retention and the key-separation facts', async () => {
    const app = await boot();
    const d = await json<{ retention: Array<{ what: string; keep: string }>; keysSeparate: boolean; noTraining: boolean; cacheNote: boolean }>(app.api('GET', '/api/privacy'));
    expect(d.retention.find((r) => r.what === 'location')?.keep).toBe('1h');
    expect(d.keysSeparate && d.noTraining && d.cacheNote).toBe(true);
  });
});
