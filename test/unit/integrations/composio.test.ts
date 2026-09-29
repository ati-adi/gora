// s07 CAL (spec 07 B1/B5, plan 08 §4.2–§4.5): ComposioProvider request shapes against a fake Composio REST server.
import { describe, expect, it } from 'vitest';
import type { CalEventInput } from '../../../src/contracts/index.ts';
import { ComposioMisconfiguredError } from '../../../src/integrations/composio.ts';
import { TOOLKIT_VERSIONS } from '../../../src/integrations/composioMap.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { CALENDAR_TOOLS } from '../../../src/tools/impl/calendar.ts';
import { composioProvider, createComposioFetch, testHmac } from '../../harness/s07-cal.ts';
import { createToolEnv } from '../tools/env.ts';

const cid = (userId: string) => `g_${testHmac.hmac('composio_user', userId).slice(0, 32)}`;
const CB = 'https://gora.test/oauth/callback?state=st_1';

describe('ComposioProvider: connect links and auth configs', () => {
  it('link: HMAC user_id, the callback with state, the managed auth config from env → pendingRef + expiresAt', async () => {
    const f = createComposioFetch();
    const p = composioProvider(f, { authConfigs: { gcal: 'ac_env' } });
    const r = await p.connectLink('u_1', 'gcal', CB);
    const [link] = f.to('/api/v3.1/connected_accounts/link', 'POST');
    expect(link!.body).toEqual({ auth_config_id: 'ac_env', user_id: cid('u_1'), callback_url: CB });
    expect(link!.apiKey).toBe('ak_test');
    expect(JSON.stringify(f.requests)).not.toContain('u_1'); // never the internal (or Telegram) id in clear
    expect(r.url).toMatch(/^https:\/\/connect\.composio\.dev\/link\//);
    expect(r.pendingRef).toMatch(/^ca_fake/);
    expect(r.expiresAt).toBe(Date.parse(f.linkExpiresAt));
    expect(f.to('/api/v3/auth_configs')).toHaveLength(0); // env id used as-is
    expect(p.composioUserId('u_1')).toBe(cid('u_1'));
    expect(p.composioUserId('u_1')).toBe(p.composioUserId('u_1'));
    expect(p.composioUserId('u_2')).not.toBe(p.composioUserId('u_1'));
  });

  it('auth config: found by name gora-<slug>, else created with that name (managed), idempotently', async () => {
    const f = createComposioFetch();
    f.authConfigs.push({ id: 'ac_foreign', name: 'someone-elses', status: 'ENABLED', is_composio_managed: false, toolkit: { slug: 'googlecalendar' } });
    const p = composioProvider(f);
    await p.connectLink('u_1', 'gcal', CB);
    const posts = f.to('/api/v3/auth_configs', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ toolkit: { slug: 'googlecalendar' }, auth_config: { type: 'use_composio_managed_auth', name: 'gora-googlecalendar' } });
    expect(f.to('/api/v3/auth_configs', 'GET')[0]!.query).toEqual({ toolkit_slug: 'googlecalendar' });
    const created = f.authConfigs.find((a) => a.name === 'gora-googlecalendar')!.id;
    expect(f.to('/api/v3.1/connected_accounts/link')[0]!.body!['auth_config_id']).toBe(created); // not the foreign one

    // a second connect: no new config
    await p.connectLink('u_2', 'gcal', CB);
    expect(f.to('/api/v3/auth_configs', 'POST')).toHaveLength(1);
    // a new process finds the named config instead of creating another one
    const p2 = composioProvider(f);
    await p2.connectLink('u_3', 'gcal', CB);
    expect(f.to('/api/v3/auth_configs', 'POST')).toHaveLength(1);
    expect(f.to('/api/v3.1/connected_accounts/link').at(-1)!.body!['auth_config_id']).toBe(created);
  });

  it('concurrent first connects create one config', async () => {
    const f = createComposioFetch();
    const p = composioProvider(f);
    await Promise.all([p.connectLink('u_1', 'gcal', CB), p.connectLink('u_2', 'gcal', CB)]);
    expect(f.to('/api/v3/auth_configs', 'POST')).toHaveLength(1);
  });

  it('the Gmail auth config is created only on the first Gmail connect', async () => {
    const f = createComposioFetch();
    const p = composioProvider(f, { authConfigs: { gcal: 'ac_kB4OafdmH77M' } });
    await p.connectLink('u_1', 'gcal', CB);
    expect(f.to('/api/v3/auth_configs')).toHaveLength(0);
    await p.connectLink('u_1', 'gmail', CB);
    const posts = f.to('/api/v3/auth_configs', 'POST');
    expect(posts.map((x) => x.body)).toEqual([{ toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', name: 'gora-gmail' } }]);
  });
});

describe('ComposioProvider: connection status', () => {
  const statuses: Array<[string, unknown]> = [
    ['INITIALIZING', { status: 'pending' }],
    ['INITIATED', { status: 'pending' }],
    ['ACTIVE', { status: 'active', accountRef: 'ca_x' }],
    ['FAILED', { status: 'failed', reason: 'failed' }],
    ['EXPIRED', { status: 'failed', reason: 'expired' }],
    ['INACTIVE', { status: 'failed', reason: 'revoked' }], // not active (the old /active/i matched it)
    ['REVOKED', { status: 'failed', reason: 'revoked' }],
  ];
  it.each(statuses)('%s → %j', async (status, want) => {
    const f = createComposioFetch();
    f.accounts.set('ca_x', { id: 'ca_x', status, user_id: cid('u_1'), toolkit: { slug: 'googlecalendar' }, auth_config: { id: 'ac', is_composio_managed: true } });
    const p = composioProvider(f);
    expect(await p.connectionStatus('ca_x', { userId: 'u_1', kind: 'gcal' })).toEqual(want);
    expect(f.requests[0]!.path).toBe('/api/v3.1/connected_accounts/ca_x');
  });

  it('another owner or toolkit → mismatch, whatever the status; completeConnection refuses it', async () => {
    const f = createComposioFetch();
    const acc = (id: string, user: string, slug: string, status = 'ACTIVE') => f.accounts.set(id, { id, status, user_id: user, toolkit: { slug }, auth_config: { id: 'ac', is_composio_managed: true } });
    acc('ca_other', cid('u_2'), 'googlecalendar');
    acc('ca_pending_other', cid('u_2'), 'googlecalendar', 'INITIATED');
    acc('ca_gmail', cid('u_1'), 'gmail');
    acc('ca_ok', cid('u_1'), 'googlecalendar');
    const p = composioProvider(f);
    const want = { userId: 'u_1', kind: 'gcal' as const };
    expect(await p.connectionStatus('ca_other', want)).toEqual({ status: 'failed', reason: 'mismatch' });
    expect(await p.connectionStatus('ca_pending_other', want)).toEqual({ status: 'failed', reason: 'mismatch' });
    expect(await p.connectionStatus('ca_gmail', want)).toEqual({ status: 'failed', reason: 'mismatch' });
    expect(await p.connectionStatus('ca_missing', want)).toEqual({ status: 'failed', reason: 'error' });
    await expect(p.completeConnection({ connected_account_id: 'ca_other' }, want)).rejects.toThrow();
    await expect(p.completeConnection({ connected_account_id: 'ca_ok' })).rejects.toThrow(); // no expected owner: refused
    expect(await p.completeConnection({ connected_account_id: 'ca_ok' }, want)).toEqual({ accountRef: 'ca_ok' });
  });

  it('a network error is thrown (the poller retries); ids never reach the logs', async () => {
    const f = createComposioFetch();
    const log = createMemoryLogger();
    const p = composioProvider(f, { log });
    f.failNext(503);
    await expect(p.connectionStatus('ca_secret123', { userId: 'u_1', kind: 'gcal' })).rejects.toThrow(/503/);
    expect(JSON.stringify(log.entries)).not.toContain('ca_secret123');
    expect(JSON.stringify(log.entries)).toContain('/api/v3.1/connected_accounts/:id');
  });
});

describe('ComposioProvider: tool execution', () => {
  const setup = (o: { tz?: string } = {}) => {
    const f = createComposioFetch();
    const p = composioProvider(f, { tzOf: () => o.tz ?? 'Asia/Almaty' });
    return { f, p, cal: p.calendar('u_1', 'ca_1'), mail: p.mail('u_1', 'ca_1') };
  };
  const exec = (f: ReturnType<typeof createComposioFetch>) => f.to('/api/v3.1/tools/execute/', 'POST');
  const slugOf = (path: string) => path.split('/').pop();
  const EV: CalEventInput = { title: 'Lunch', start: '2026-10-01T13:00:00+05:00', end: '2026-10-01T14:00:00+05:00', tz: 'Asia/Almaty', attendees: [] };

  it('every execute carries the pinned version, the HMAC user id and the connected account', async () => {
    const { f, cal, mail } = setup();
    await cal.list({ fromIso: '2026-09-30T00:00:00Z', toIso: '2026-10-01T00:00:00Z', max: 10 });
    await cal.freeBusy({ fromIso: '2026-09-30T00:00:00Z', toIso: '2026-10-01T00:00:00Z' });
    await cal.remove('ev_1');
    await mail.search({ query: 'invoice', maxResults: 5 });
    expect(exec(f)).toHaveLength(4);
    for (const r of exec(f)) {
      expect(r.body).toMatchObject({ connected_account_id: 'ca_1', user_id: cid('u_1'), version: '20260915_00' });
      expect(r.path.startsWith('/api/v3.1/')).toBe(true);
    }
    expect(TOOLKIT_VERSIONS).toEqual({ gcal: '20260915_00', gmail: '20260915_00' });
  });

  it('EVENTS_LIST uses camelCase (calendarId, query, timeZone), FREE_BUSY items + timeZone, findByIdem calendarId', async () => {
    const { f, cal } = setup();
    await cal.list({ fromIso: '2026-09-30T00:00:00Z', toIso: '2026-10-01T00:00:00Z', query: 'dentist', max: 10 });
    await cal.freeBusy({ fromIso: '2026-09-30T00:00:00Z', toIso: '2026-10-01T00:00:00Z' });
    await cal.findByIdem('idem_1');
    const [list, fb, idem] = exec(f);
    expect(slugOf(list!.path)).toBe('GOOGLECALENDAR_EVENTS_LIST');
    expect(list!.body!['arguments']).toEqual({ calendarId: 'primary', timeMin: '2026-09-30T00:00:00Z', timeMax: '2026-10-01T00:00:00Z', timeZone: 'Asia/Almaty', query: 'dentist', maxResults: 10, singleEvents: true, orderBy: 'startTime' });
    expect(slugOf(fb!.path)).toBe('GOOGLECALENDAR_FREE_BUSY_QUERY');
    expect(fb!.body!['arguments']).toEqual({ items: ['primary'], timeMin: '2026-09-30T00:00:00Z', timeMax: '2026-10-01T00:00:00Z', timeZone: 'Asia/Almaty' });
    expect(slugOf(idem!.path)).toBe('GOOGLECALENDAR_EVENTS_LIST');
    expect(idem!.body!['arguments']).toEqual({ calendarId: 'primary', privateExtendedProperty: 'gora_idem=idem_1', maxResults: 1 });
  });

  it('send_updates is a string: create none/all + no Meet link, update and delete all', async () => {
    const { f, cal } = setup();
    f.tools.set('GOOGLECALENDAR_CREATE_EVENT', (a) => ({ data: { response_data: { id: 'ev_new', summary: a['summary'], start: { dateTime: a['start_datetime'] }, end: { dateTime: a['end_datetime'] } } } }));
    const made = await cal.create(EV, 'idem_1');
    expect(made.id).toBe('ev_new');
    await cal.create({ ...EV, attendees: ['anna@example.com'] }, 'idem_2');
    await cal.update('ev_new', { title: 'Late lunch' });
    await cal.remove('ev_new');
    const [c1, c2, up, del] = exec(f).map((r) => r.body!['arguments'] as Record<string, unknown>);
    expect(c1).toMatchObject({ calendar_id: 'primary', summary: 'Lunch', start_datetime: EV.start, end_datetime: EV.end, timezone: 'Asia/Almaty', send_updates: 'none', create_meeting_room: false, extended_properties: { private: { gora_idem: 'idem_1' } } });
    expect(c2).toMatchObject({ attendees: ['anna@example.com'], send_updates: 'all', create_meeting_room: false });
    expect(up).toEqual({ calendar_id: 'primary', event_id: 'ev_new', summary: 'Late lunch', send_updates: 'all' });
    expect(del).toEqual({ calendar_id: 'primary', event_id: 'ev_new', send_updates: 'all' });
    for (const a of [c1, c2, up, del]) expect(typeof a!['send_updates']).toBe('string');
  });

  it('respond → GOOGLECALENDAR_PATCH_EVENT with rsvp_response', async () => {
    const { f, cal } = setup();
    await cal.respond('ev_9', 'tentative');
    const [r] = exec(f);
    expect(slugOf(r!.path)).toBe('GOOGLECALENDAR_PATCH_EVENT');
    expect(r!.body!['arguments']).toEqual({ calendar_id: 'primary', event_id: 'ev_9', rsvp_response: 'tentative' });
  });

  it('Gmail: is_html false on drafts, format full on get, include_payload false on searches', async () => {
    const { f, mail } = setup();
    f.tools.set('GMAIL_CREATE_EMAIL_DRAFT', () => ({ data: { id: 'd_1' } }));
    await mail.createDraft({ to: ['a@example.com', 'b@example.com'], cc: [], subject: 'Hi', body: 'Hello', replyToThreadId: 't_1' }, 'idem');
    await mail.getDraft('d_1');
    await mail.findSent({ to: 'a@example.com', subject: 'Hi', afterMs: 1_000_000 });
    const [cd, gd, fs] = exec(f).map((r) => ({ slug: slugOf(r.path), args: r.body!['arguments'] as Record<string, unknown> }));
    expect(cd).toEqual({ slug: 'GMAIL_CREATE_EMAIL_DRAFT', args: { recipient_email: 'a@example.com', extra_recipients: ['b@example.com'], cc: [], subject: 'Hi', body: 'Hello', is_html: false, thread_id: 't_1' } });
    expect(gd).toEqual({ slug: 'GMAIL_GET_DRAFT', args: { draft_id: 'd_1', format: 'full' } });
    expect(fs!.slug).toBe('GMAIL_FETCH_EMAILS');
    expect(fs!.args['include_payload']).toBe(false);
  });

  it('a failed tool call is a clean error; "not found" maps to not found', async () => {
    const { f, cal } = setup();
    f.tools.set('GOOGLECALENDAR_DELETE_EVENT', () => ({ successful: false, error: 'Event not found (404)' }));
    f.tools.set('GOOGLECALENDAR_PATCH_EVENT', () => ({ successful: false, error: 'Rate limit' }));
    await expect(cal.remove('x')).rejects.toThrow('remove: not found');
    await expect(cal.update('x', { title: 'y' })).rejects.toThrow('update failed');
  });

  it('401 code 801 (a ck_ consumer key) → "integrations misconfigured"; the calendar tool says so cleanly', async () => {
    const f = createComposioFetch();
    const p = composioProvider(f, { apiKey: 'ck_consumer' });
    const cal = p.calendar('u_1', 'ca_1');
    const err = await cal.list({ fromIso: '2026-09-30T00:00:00Z', toIso: '2026-10-01T00:00:00Z', max: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComposioMisconfiguredError);
    expect(String((err as Error).message)).toMatch(/integrations misconfigured.*401 code 801/);
    await expect(p.connectLink('u_1', 'gcal', CB)).rejects.toThrow(/integrations misconfigured/);

    const env = createToolEnv();
    (env.s.integrations as { calendar: unknown }).calendar = () => cal;
    const listTool = CALENDAR_TOOLS.find((x) => x.name === 'calendar_list_events')!;
    const out = await env.run(listTool, { from_local: '2026-09-30T00:00', to_local: '2026-10-01T00:00' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('INTEGRATIONS_MISCONFIGURED');
  });
});
