// s07 CAL (spec 07 B1, plan 08 §4.4–§4.5): pending connect links and the integration_poll job, through the real
// IntegrationService in a test app (FakeClock): polling every 5 s until active, the 10-min deadline, a callback + poll
// race completing exactly once, a failed link, network errors, privacy — and the whole path with Composio's REST shapes.
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionPoll, IntegrationKind, UserId, UserRow } from '../../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../../src/integrations/fake.ts';
import { createLinksRepo, errorClass } from '../../../src/integrations/links.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { composioProvider, createComposioFetch } from '../../harness/s07-cal.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const NOW = Date.UTC(2026, 8, 29, 6, 0);
function addUser(app: TestApp, lang = 'en'): UserRow {
  const u = app.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: lang }, { dmChatId: 1001 });
  app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
  app.s.repos.users.grantConsent({ userId: u.id, kind: 'terms', textVersion: 'v1', via: 'command' });
  return app.s.repos.users.getById(u.id)!;
}
const texts = (app: TestApp) => app.tg.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text ?? ''));
const statusCalls = (p: FakeIntegrationProvider) => p.calls.filter((c) => c.startsWith('connectionStatus:')).length;
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('integration_poll', () => {
  it('polls every 5 s until the account is active, then completes once and stops', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t);
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    const link = createLinksRepo(t.s).byState(stateOf(url))!;
    expect(link).toMatchObject({ status: 'pending', kind: 'gcal', returnChatId: 1001, resumeConversationId: null, polls: 0 });
    expect(link.deadlineAt - NOW).toBe(10 * 60_000);
    expect(link.pendingRef).toBe(provider.pendingRefs()[0]);
    // the pending ref is sealed at rest
    const raw = t.s.db.prepare('SELECT pending_ref_enc FROM integration_links WHERE id = ?').get<{ pending_ref_enc: Uint8Array }>(link.id)!;
    expect(Buffer.from(raw.pending_ref_enc).toString('latin1')).not.toContain(link.pendingRef!);

    for (let i = 1; i <= 3; i++) {
      await t.advance(5_000);
      expect(statusCalls(provider)).toBe(i);
    }
    expect(createLinksRepo(t.s).get(link.id)!.polls).toBe(3);
    expect(t.s.integrations.status(u.id).gcal.connected).toBe(false);

    provider.completeByPoll(link.pendingRef!);
    await t.advance(5_000);
    await t.settle();
    expect(t.s.integrations.status(u.id).gcal).toEqual({ connected: true, level: 'draft' });
    expect(createLinksRepo(t.s).get(link.id)!.status).toBe('active');
    expect(texts(t).filter((x) => x.startsWith('Done ✓'))).toEqual(['Done ✓ Google Calendar is connected.']);
    const n = statusCalls(provider);
    await t.advance(60_000);
    expect(statusCalls(provider)).toBe(n);
    expect(t.s.ledger.list(u.id, { limit: 20 }).find((e) => e.kind === 'connection')?.summary).toMatch(/connected \(fake, poll\)/);
  });

  it('after 10 minutes the link expires quietly (no message) and polling stops', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t);
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    expect(t.s.integrations.pendingLinks?.(u.id)).toEqual([{ kind: 'gcal', createdAt: NOW, deadlineAt: NOW + 10 * 60_000 }]);
    const conns = (await (await t.api('GET', '/api/connections')).json()) as { integrations: Array<{ kind: string; pending?: boolean }> };
    expect(conns.integrations.map((i) => [i.kind, i.pending])).toEqual([['gmail', false], ['gcal', true]]); // Mini App: "waiting for the connection…"
    for (let i = 0; i < 125; i++) await t.advance(5_000);
    const link = createLinksRepo(t.s).byState(stateOf(url))!;
    expect(link.status).toBe('expired');
    expect(statusCalls(provider)).toBeLessThanOrEqual(120);
    expect(statusCalls(provider)).toBeGreaterThanOrEqual(115);
    const n = statusCalls(provider);
    await t.advance(60_000);
    expect(statusCalls(provider)).toBe(n);
    expect(texts(t)).toEqual([]);
    expect(t.s.integrations.pendingLinks?.(u.id)).toEqual([]);
    expect(t.s.ledger.list(u.id, { limit: 20 }).some((e) => /expired unused/.test(e.summary))).toBe(true);
    // the provider completing late changes nothing
    provider.completeByPoll(link.pendingRef!);
    await t.advance(10_000);
    expect(t.s.integrations.status(u.id).gcal.connected).toBe(false);
  });

  it('a callback and a poll hit at the same moment complete exactly once', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t, 'ru');
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    const ref = provider.pendingRefs()[0]!;
    provider.completeByPoll(ref);
    const [res] = await Promise.all([t.s.integrations.oauthCallback({ state: stateOf(url), status: 'success', connected_account_id: ref }), t.advance(5_000)]);
    expect(res.status).toBe(200);
    await t.advance(5_000);
    await t.settle();
    expect(texts(t).filter((x) => x.startsWith('Готово ✓'))).toHaveLength(1);
    expect(t.s.ledger.list(u.id, { limit: 20 }).filter((e) => e.kind === 'connection')).toHaveLength(1);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM connections WHERE user_id = ?').get<{ n: number }>(u.id)!.n).toBe(1);
  });

  it('a failed connection says one line in the return chat; a failed callback stops the poller too', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t, 'ru');
    await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001, threadId: 77 });
    provider.failByPoll(provider.pendingRefs()[0]!);
    await t.advance(5_000);
    await t.settle();
    const failed = t.tg.calls.filter((c) => c.method === 'sendMessage');
    expect(failed.map((c) => c.payload.text)).toEqual(['Не получилось подключить Google Календарь — попробуем ещё раз?']);
    expect(failed[0]!.payload.message_thread_id).toBe(77);

    const { url } = await t.s.integrations.startConnect(u.id, 'gmail', { chatId: 1001 });
    expect((await t.s.integrations.oauthCallback({ state: stateOf(url), status: 'failed' })).status).toBe(400);
    expect(createLinksRepo(t.s).byState(stateOf(url))!.status).toBe('failed');
    const n = statusCalls(provider);
    await t.advance(10_000);
    expect(statusCalls(provider)).toBe(n);
  });

  it('a network error is recorded as an error class and polling goes on', async () => {
    class Flaky extends FakeIntegrationProvider {
      fails = 2;
      override async connectionStatus(ref: string, expect: { userId: UserId; kind: IntegrationKind }): Promise<ConnectionPoll> {
        if (this.fails-- > 0) throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
        return super.connectionStatus(ref, expect);
      }
    }
    const provider = new Flaky({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t);
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    await t.advance(5_000);
    const repo = createLinksRepo(t.s);
    expect(repo.byState(stateOf(url))).toMatchObject({ status: 'pending', lastError: 'network', polls: 1 });
    provider.completeByPoll(provider.pendingRefs()[0]!);
    await t.advance(5_000);
    await t.advance(5_000);
    await t.settle();
    expect(t.s.integrations.status(u.id).gcal.connected).toBe(true);
    expect(errorClass(Object.assign(new Error('x'), { status: 502 }))).toBe('http_5xx');
    expect(errorClass(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
  });

  it('privacy: deleting the user removes the links; export lists metadata only', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t);
    await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    const hook = t.s.privacyHooks.find((h) => h.name === 'integrations')!;
    const exp = (await hook.exportUser!(u.id, u.tgUserId)) as { connect_links: Array<Record<string, unknown>> };
    expect(exp.connect_links).toEqual([{ integration: 'gcal', provider: 'fake', status: 'pending', created_at: NOW, completed_at: null }]);
    expect(JSON.stringify(exp)).not.toContain(provider.pendingRefs()[0]!);
    await hook.onDeleteUser(u.id, u.tgUserId);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM integration_links WHERE user_id = ?').get<{ n: number }>(u.id)!.n).toBe(0);
  });

  it('the Composio provider end to end: link → poll sees ACTIVE → connected with the account; executes carry it', async () => {
    const f = createComposioFetch({ now: () => NOW });
    const provider = composioProvider(f, { authConfigs: { gcal: 'ac_kB4OafdmH77M' } });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t);
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    expect(url).toMatch(/^https:\/\/connect\.composio\.dev\//);
    const link = f.to('/api/v3.1/connected_accounts/link')[0]!;
    const row = t.s.db.prepare('SELECT state FROM integration_links').get<{ state: string }>()!;
    expect(link.body!['callback_url']).toBe(`https://gora.test/oauth/callback?state=${encodeURIComponent(row.state)}`);
    const caId = [...f.accounts.keys()][0]!;
    await t.advance(5_000);
    expect(t.s.integrations.status(u.id).gcal.connected).toBe(false); // INITIATED
    f.setStatus(caId, 'INACTIVE');
    await t.advance(5_000);
    expect(t.s.integrations.status(u.id).gcal.connected).toBe(false); // INACTIVE is not active → failed
    expect(texts(t)).toEqual(["Couldn't connect Google Calendar — want to try again?"]);

    // a second attempt that the owner completes
    await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    const ca2 = [...f.accounts.keys()][1]!;
    f.setStatus(ca2, 'ACTIVE');
    await t.advance(5_000);
    await t.settle();
    expect(t.s.integrations.status(u.id).gcal).toEqual({ connected: true, level: 'draft' });
    await t.s.integrations.calendar(u.id)!.list({ fromIso: '2026-09-30T00:00:00Z', toIso: '2026-10-01T00:00:00Z', max: 5 });
    const ex = f.to('/api/v3.1/tools/execute/').at(-1)!;
    expect(ex.body).toMatchObject({ connected_account_id: ca2, version: '20260915_00' });
  });
});
