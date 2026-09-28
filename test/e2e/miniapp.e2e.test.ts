// WP8 e2e (01 §15.2): the Mini App API over the whole app — approve through the API executes exactly once; memory
// forget; tz (TzDetect); export token → download headers; delete needs `high` freshness plus the phrase; an `always`
// grant needs a step-up. Real WP1 (storage, privacy), WP4 (trust) and WP6 (memory, scheduler) are used; the agent,
// Telegram and surfaces modules are pinned to their fakes (04 §4.1) so no LLM or Telegram module is involved.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalDiff, BetaToolUseBlock, ConversationRow, Factories, RunRow, Services, Target, ToolCtx, ToolSpec, UserRow } from '../../src/contracts/index.ts';
import { TOOLS as TRUST_TOOLS } from '../../src/trust/tools.ts';
import { NOOP_FACTORIES, createFakeIntegrations, createFakePolicy, createFakeProfileService, createRecordingNotices, createRecordingSignals, createStaticRegistry } from '../harness/fakes.ts';
import { staleInitData } from '../harness/initData.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { TEST_USER } from '../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

interface World { sent: Array<{ to: string; idemKey: string }>; notices: ReturnType<typeof createRecordingNotices> }

function sendTool(w: World): ToolSpec {
  const input = z.object({ to: z.string().email(), subject: z.string(), body: z.string() });
  return {
    name: 'gmail_send_draft',
    description: 'test send; call when the owner asks to send',
    input,
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: false,
    classify: () => ({ actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act' }),
    targets: async (i: z.infer<typeof input>): Promise<Target[]> => [{ kind: 'email', value: i.to, hmac: '', provenance: 'user' }],
    renderDiff: async (i: z.infer<typeof input>): Promise<ApprovalDiff> => ({ title: 'Send email', summary: `Send email to ${i.to}`, rows: [['To', i.to], ['Subject', i.subject]], body: { label: 'Body', text: i.body }, warnings: [], targets: [] }),
    statusLabel: () => 'Sending',
    async execute(i: z.infer<typeof input>, ctx: ToolCtx) {
      w.sent.push({ to: i.to, idemKey: ctx.idemKey });
      return { content: JSON.stringify({ sent: true }), ledger: [{ kind: 'email_sent', summary: 'Email sent' }] };
    },
  };
}

async function boot(extra: Partial<Factories> = {}): Promise<{ t: TestApp; w: World }> {
  const w: World = { sent: [], notices: createRecordingNotices() };
  const factories: Partial<Factories> = {
    ...extra,
    createAgentModule: NOOP_FACTORIES.createAgentModule,
    createTelegramModule: NOOP_FACTORIES.createTelegramModule,
    createBusinessModule: NOOP_FACTORIES.createBusinessModule,
    createSurfaces: (s: Services) => ({ ...NOOP_FACTORIES.createSurfaces(s), notices: w.notices }),
    createToolRegistry: () => createStaticRegistry([sendTool(w), ...TRUST_TOOLS]),
    createIntegrationService: (s: Services, provider) => {
      const base = createFakeIntegrations(s.config.publicUrl, provider ?? null);
      return { ...base, status: () => ({ gmail: { connected: true, level: 'act' as const }, gcal: { connected: true, level: 'act' as const } }) };
    },
  };
  const app = await createTestApp({ factories });
  t = app;
  return { t: app, w };
}

/** The Mini App's first call creates the user (01 §12); then the test owner is set up for sends. */
async function owner(app: TestApp): Promise<UserRow> {
  expect((await app.api('GET', '/api/me')).status).toBe(200);
  const u = app.s.repos.users.getByTg(TEST_USER.id)!;
  app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', memoryConsent: true });
  app.s.repos.users.setPermission(u.id, 'gmail', 'act', 'system');
  return app.s.repos.users.getById(u.id)!;
}

function dmRun(app: TestApp, u: UserRow): { conv: ConversationRow; run: RunRow } {
  const existing = app.s.repos.conversations.byScopeKey(`dm:${u.tgUserId}`);
  const conv = existing ?? app.s.repos.conversations.create({
    scopeKey: `dm:${u.tgUserId}`, kind: 'dm', userId: u.id, tgChatId: u.tgUserId, threadId: null, businessConnectionId: null, route: 'chat',
    model: 'claude-opus-5', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false,
  });
  const run = app.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.tgUserId }, maxTokens: 1000 });
  return { conv, run };
}

let toolSeq = 0;
async function propose(app: TestApp, u: UserRow, to = 'anna@x.com'): Promise<string> {
  const { conv, run } = dmRun(app, u);
  const uses = [{ type: 'tool_use', id: `toolu_${++toolSeq}`, name: 'gmail_send_draft', input: { to, subject: 'Report', body: 'Hi Anna' } }] as BetaToolUseBlock[];
  const out = await app.s.executor.processRound(run, conv, 1, uses, null as never, new AbortController().signal);
  const res = JSON.parse(String(out.results[0]!.content)) as { status: string; approval_id: string };
  expect(res.status).toBe('pending_approval');
  return res.approval_id;
}

const aged = (app: TestApp, ageSec: number) => staleInitData(TEST_USER, { nowMs: app.clock.now(), ageSec });

describe('Mini App e2e (01 §12, F15)', () => {
  it('approve through the API executes exactly once; a second approve is "already handled"', async () => {
    const { t, w } = await boot();
    const u = await owner(t);
    const id = await propose(t, u);

    const list = (await (await t.api('GET', '/api/approvals?status=pending')).json()) as { items: Array<{ id: string; title: string; rows: Array<[string, string]> }> };
    expect(list.items.map((i) => i.id)).toEqual([id]);
    expect(list.items[0]!.title).toBe('Send email');
    const detail = await t.api('GET', `/api/approvals/${id}`);
    expect(detail.status).toBe(200);

    // another Telegram user cannot see or resolve it
    const other = { id: 4242, first_name: 'Eve', language_code: 'en' };
    expect((await t.api('GET', `/api/approvals/${id}`, undefined, { user: other })).status).toBe(404);
    expect((await t.api('POST', `/api/approvals/${id}`, { decision: 'approve' }, { user: other })).status).toBe(404);
    // write freshness: > 1 h old initData cannot approve
    expect((await t.api('POST', `/api/approvals/${id}`, { decision: 'approve', scope: 'once' }, { initData: aged(t, 2 * 3600) })).status).toBe(401);
    expect(w.sent).toHaveLength(0);

    const [a, b] = await Promise.all([
      t.api('POST', `/api/approvals/${id}`, { decision: 'approve', scope: 'once' }),
      t.api('POST', `/api/approvals/${id}`, { decision: 'approve', scope: 'once' }),
    ]);
    const bodies = [await a.json(), await b.json()] as Array<{ status: string }>;
    expect(bodies.map((x) => x.status).sort()).toEqual(['already_handled', 'executed']);
    const again = (await (await t.api('POST', `/api/approvals/${id}`, { decision: 'approve', scope: 'once' })).json()) as { status: string };
    expect(again.status).toBe('already_handled');
    await t.settle();
    expect(w.sent).toEqual([{ to: 'anna@x.com', idemKey: `pa:${id}` }]);
    expect(t.s.approvals.get(id, u.id)?.status).toBe('executed');
    expect((await (await t.api('GET', '/api/approvals')).json()) as { items: unknown[] }).toEqual({ items: [] });
  });

  it('deny through the API never executes', async () => {
    const { t, w } = await boot();
    const u = await owner(t);
    const id = await propose(t, u);
    const r = (await (await t.api('POST', `/api/approvals/${id}`, { decision: 'deny' })).json()) as { status: string };
    expect(r.status).toBe('denied');
    await t.settle();
    expect(w.sent).toHaveLength(0);
  });

  it('an `always` grant needs a step-up (biometric token or the ⚠U20 phrase) and `high` freshness', async () => {
    const { t, w } = await boot();
    const u = await owner(t);
    // two identical approved sends meet the trust ladder (S16), so the third card is eligible for "Always…"
    for (let i = 0; i < 2; i++) {
      const id = await propose(t, u);
      expect(((await (await t.api('POST', `/api/approvals/${id}`, { decision: 'approve' })).json()) as { status: string }).status).toBe('executed');
    }
    const third = await propose(t, u);
    expect(w.sent).toHaveLength(2);

    // no step-up → refused
    const noStep = await t.api('POST', '/api/grants', { pendingActionId: third, stepupGrantId: 'sg_bogus' });
    expect(noStep.status).toBe(403);
    expect(await noStep.json()).toMatchObject({ error: 'stepup_invalid' });
    // high freshness: 30-minute-old initData cannot create an always grant or enroll a device
    expect((await t.api('POST', '/api/grants', { pendingActionId: third, stepupGrantId: 'sg_bogus' }, { initData: aged(t, 30 * 60) })).status).toBe(401);
    expect((await t.api('POST', '/api/stepup/enroll', {}, { initData: aged(t, 30 * 60) })).status).toBe(401);

    // phrase path (⚠U20): the wrong phrase fails, 'ALWAYS <FIRST WORD OF TARGET>' succeeds
    expect((await t.api('POST', '/api/stepup/phrase', { phrase: 'ALWAYS BOB', pendingActionId: third })).status).toBe(403);
    const phrase = await t.api('POST', '/api/stepup/phrase', { phrase: 'always anna', pendingActionId: third });
    expect(phrase.status).toBe(200);
    const { grantId: phraseGrant } = (await phrase.json()) as { grantId: string };

    // biometric path: enroll → token (stored by BiometricManager) → verify → a step-up grant
    const { token } = (await (await t.api('POST', '/api/stepup/enroll', {})).json()) as { token: string };
    expect((await t.api('POST', '/api/stepup/verify', { token: `${token}x` })).status).toBe(403);
    const v = await t.api('POST', '/api/stepup/verify', { token });
    expect(v.status).toBe(200);
    const { grantId } = (await v.json()) as { grantId: string };

    const g = await t.api('POST', '/api/grants', { pendingActionId: third, stepupGrantId: grantId });
    expect(g.status).toBe(200);
    const created = (await g.json()) as { id: string };
    expect(created.id).toBeTruthy();
    // a step-up grant is single-use
    expect((await t.api('POST', '/api/grants', { pendingActionId: third, stepupGrantId: grantId })).status).toBe(403);
    expect(phraseGrant).not.toBe(grantId);

    const grants = (await (await t.api('GET', '/api/grants')).json()) as { items: Array<{ id: string; scope: string }> };
    expect(grants.items.some((x) => x.id === created.id && x.scope === 'always')).toBe(true);
    // revoke from the Mini App
    expect((await t.api('DELETE', `/api/grants/${created.id}`)).status).toBe(200);
    expect(((await (await t.api('GET', '/api/grants')).json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('memory forget from the Mini App removes the fact', async () => {
    const { t } = await boot();
    const u = await owner(t);
    const c = await t.api('PATCH', '/api/memory/consent', { on: true });
    expect(c.status).toBe(200);
    const saved = await t.s.memory.save({ kind: 'user', userId: u.id }, { text: 'My sister Dana lives in Astana', kind: 'person', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'miniapp' } });
    expect('id' in saved).toBe(true);
    const factId = (saved as { id: string }).id;
    const before = (await (await t.api('GET', '/api/memory')).json()) as { items: Array<{ id: string; text: string }> };
    expect(before.items.map((i) => i.id)).toContain(factId);

    expect((await t.api('DELETE', `/api/memory/${factId}`, undefined, { initData: aged(t, 2 * 3600) })).status).toBe(401);
    const del = await t.api('DELETE', `/api/memory/${factId}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ forgotten: [factId] });
    const after = (await (await t.api('GET', '/api/memory')).json()) as { items: Array<{ id: string; text: string }> };
    expect(after.items.map((i) => i.id)).not.toContain(factId);
    expect(JSON.stringify(after)).not.toContain('Dana');
    expect((await t.api('DELETE', `/api/memory/${factId}`)).status).toBe(404);
    // another user cannot forget someone else's fact
    const s2 = await t.s.memory.save({ kind: 'user', userId: u.id }, { text: 'I like green tea', kind: 'preference', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'miniapp' } });
    const id2 = (s2 as { id: string }).id;
    expect((await t.api('DELETE', `/api/memory/${id2}`, undefined, { user: { id: 4242, first_name: 'Eve' } })).status).toBe(404);
    expect(t.s.memory.getMany({ kind: 'user', userId: u.id }, [id2])).toHaveLength(1);
  });

  it('TzDetect: POST /api/settings/tz sets the zone and sends the confirmation once', async () => {
    const { t, w } = await boot();
    await t.api('GET', '/api/me');
    const u0 = t.s.repos.users.getByTg(TEST_USER.id)!;
    expect(u0.tzSource).toBe('default');
    expect((await t.api('POST', '/api/settings/tz', { tz: 'Mars/Olympus' })).status).toBe(400);
    const r = await t.api('POST', '/api/settings/tz', { tz: 'Asia/Almaty' });
    expect(r.status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    expect(u.tz).toBe('Asia/Almaty');
    expect(u.tzSource).toBe('miniapp');
    expect(w.notices.calls).toEqual([{ op: 'timezoneSet', userId: u.id, arg: { tz: 'Asia/Almaty', source: 'miniapp' } }]);
    // reopening TzDetect with the same zone does not DM again
    await t.api('POST', '/api/settings/tz', { tz: 'Asia/Almaty' });
    expect(w.notices.calls).toHaveLength(1);
    const st = (await (await t.api('GET', '/api/settings')).json()) as { tz: string; tzSource: string };
    expect(st).toMatchObject({ tz: 'Asia/Almaty', tzSource: 'miniapp' });
  });

  it('friend mode (05 B5): GET /api/memory carries the profile card and memory state; PATCH /api/memory/profile corrects / deletes', async () => {
    const profile = createFakeProfileService();
    const { t } = await boot({ createProfileService: () => profile });
    await t.api('GET', '/api/me');
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    expect(u.memoryConsent).toBeNull();
    let m = (await (await t.api('GET', '/api/memory')).json()) as { profile: unknown; memory: string };
    expect(m).toMatchObject({ profile: null, memory: 'on' }); // never asked = on
    profile.put(u.id, { summary: 'Designer in Almaty', goals: ['run a half marathon', 'learn Spanish'], people: [{ name: 'Anna', relation: 'sister', notes: 'allergic to nuts' }] });
    m = (await (await t.api('GET', '/api/memory')).json()) as { profile: { card: { summary: string; goals: string[] } }; memory: string };
    expect((m.profile as { card: { summary: string } }).card.summary).toBe('Designer in Almaty');

    expect((await t.api('PATCH', '/api/memory/profile', { op: 'delete', field: 'goals', index: 0 }, { initData: aged(t, 2 * 3600) })).status).toBe(401); // write freshness
    expect((await t.api('PATCH', '/api/memory/profile', { op: 'delete', field: 'goals', index: 5 })).status).toBe(404);
    expect((await t.api('PATCH', '/api/memory/profile', { op: 'delete', field: 'nope', index: 0 })).status).toBe(400);
    const del = await t.api('PATCH', '/api/memory/profile', { op: 'delete', field: 'goals', index: 0 });
    expect(del.status).toBe(200);
    expect(profile.get(u.id)!.card.goals).toEqual(['learn Spanish']);
    const fix = await t.api('PATCH', '/api/memory/profile', { op: 'correct', field: 'summary', text: 'Product designer in Almaty' });
    expect(((await fix.json()) as { profile: { card: { summary: string } } }).profile.card.summary).toBe('Product designer in Almaty');
    // the ledger never carries the corrected text
    const rows = t.s.ledger.list(u.id, { limit: 20 }).filter((r) => r.summary.startsWith('Profile card'));
    expect(rows.length).toBe(2);
    expect(JSON.stringify(rows)).not.toContain('Product designer');
    // "profile" is never taken for a fact id
    expect((await t.api('DELETE', '/api/memory/profile')).status).toBe(404);
  });

  it('friend mode (05 C5): settings carry the writing-first level and reply style; changes report feedback to the behaviour model', async () => {
    const signals = createRecordingSignals();
    const { t } = await boot({ createBehaviourModule: () => ({ signals, policy: createFakePolicy() }) });
    await t.api('GET', '/api/me');
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    let st = (await (await t.api('GET', '/api/settings')).json()) as { proactiveLevel: string; style: unknown; memory: string };
    expect(st).toMatchObject({ proactiveLevel: 'normal', style: null, memory: 'on' });
    const r = await t.api('PATCH', '/api/settings', { proactiveLevel: 'off', style: { length: 'short', emoji: 'none' } });
    expect(r.status).toBe(200);
    st = (await r.json()) as typeof st;
    expect(st).toMatchObject({ proactiveLevel: 'off', style: { length: 'short', emoji: 'none' } });
    expect(t.s.repos.users.getById(u.id)!.proactiveLevel).toBe('off');
    expect(signals.calls.filter((c) => c.op === 'feedback').map((c) => (c.arg as { kind: string }).kind)).toEqual(['stop']);
    expect((await t.api('PATCH', '/api/settings', { style: { length: 'huge' } })).status).toBe(400);
    await t.api('PATCH', '/api/settings', { style: null });
    expect(t.s.repos.users.settings(u.id).style).toBeNull();
    const me = (await (await t.api('GET', '/api/me')).json()) as { user: { proactiveLevel: string; memory: string } };
    expect(me.user).toMatchObject({ proactiveLevel: 'off', memory: 'on' });
  });

  it('export: token → single-use download with attachment + Telegram Web CORS headers', async () => {
    const { t } = await boot();
    await owner(t);
    expect((await t.api('POST', '/api/export/token', {}, { initData: aged(t, 2 * 3600) })).status).toBe(401);
    const tok = await t.api('POST', '/api/export/token', {});
    expect(tok.status).toBe(200);
    const { url, fileName } = (await tok.json()) as { url: string; fileName: string };
    expect(fileName).toBe('gora-export.json');
    expect(url.startsWith('https://gora.test/api/export/download?token=')).toBe(true);
    const path = url.slice('https://gora.test'.length);

    const dl = await t.app.http.request(path); // no Authorization header: the token is the credential
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toBe('attachment; filename="gora-export.json"');
    expect(dl.headers.get('access-control-allow-origin')).toBe('https://web.telegram.org');
    expect(dl.headers.get('content-type')).toContain('application/json');
    expect(dl.headers.get('cache-control')).toBe('no-store');
    const json = JSON.parse(await dl.text()) as Record<string, unknown>;
    expect(json).toBeTypeOf('object');
    expect(JSON.stringify(json)).toContain(String(TEST_USER.id));

    const again = await t.app.http.request(path);
    expect(again.status).toBe(410);
    expect((await t.app.http.request('/api/export/download?token=AAAAAAAAAAAAAAAA')).status).toBe(404);
  });

  it('account delete needs `high` freshness (≤ 10 min) plus the typed DELETE', async () => {
    const { t } = await boot();
    const u = await owner(t);
    const stale = await t.api('POST', '/api/account/delete', { confirm: 'DELETE' }, { initData: aged(t, 11 * 60) });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: 'stale', need: 'high' });
    expect((await t.api('POST', '/api/account/delete', { confirm: 'delete' })).status).toBe(422);
    expect((await t.api('POST', '/api/account/delete', {})).status).toBe(400);
    expect(t.s.repos.users.getById(u.id)).toBeDefined();

    const ok = await t.api('POST', '/api/account/delete', { confirm: 'DELETE' }, { initData: aged(t, 5 * 60) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true });
    expect(t.s.repos.users.getById(u.id)).toBeUndefined();
    await t.settle();
    const texts = t.tg.calls.filter((c) => c.method === 'sendRichMessage' || c.method === 'sendMessage').map((c) => JSON.stringify(c.payload));
    expect(texts.some((x) => x.includes('Deleted.'))).toBe(true);
  });
});
