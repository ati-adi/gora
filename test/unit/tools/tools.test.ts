// WP5 — utility tools (01 §6, F4; 03 R3/R4): fx, weather, share_place, react, offer_choices, location_request, use_toolkit,
// web_search/web_fetch (Groq client tools), settings_update, ledger_query, integration_connect, make_file.
import { describe, expect, it } from 'vitest';
import { PROVIDER_PROFILES } from '../../../src/config.ts';
import type { ProviderProfile } from '../../../src/contracts/index.ts';
import { choicesTool } from '../../../src/tools/impl/choices.ts';
import { connectTool } from '../../../src/tools/impl/connect.ts';
import { fxTool } from '../../../src/tools/impl/fx.ts';
import { ledgerTool } from '../../../src/tools/impl/ledger.ts';
import { locationTool } from '../../../src/tools/impl/location.ts';
import { makeFileTool, NOT_AVAILABLE_ON_GROQ, safeFilename } from '../../../src/tools/impl/makeFile.ts';
import { placeTool } from '../../../src/tools/impl/place.ts';
import { reactTool } from '../../../src/tools/impl/react.ts';
import { settingsTool } from '../../../src/tools/impl/settings.ts';
import { useToolkitTool } from '../../../src/tools/impl/useToolkit.ts';
import { weatherTool } from '../../../src/tools/impl/weather.ts';
import { formatSearchResult, precheckUrl, webFetchTool, webSearchTool } from '../../../src/tools/impl/web.ts';
import { TOOLKITS } from '../../../src/tools/toolkits.ts';
import { createToolEnv } from './env.ts';

describe('utility tools', () => {
  it('fx_convert returns rate, result, date and source; bad codes are rejected by the schema', async () => {
    const env = createToolEnv();
    const out = await env.run(fxTool, { amount: 100, from: 'USD', to: 'KZT' });
    expect(out.data).toMatchObject({ rate: 480, result: 48000, asOf: '2026-09-28', source: 'fake-fx' });
    expect(() => fxTool.input.parse({ amount: 1, from: 'usd', to: 'KZT' })).toThrow();
    expect((await env.run(fxTool, { amount: 1, from: 'USD', to: 'XYZ' })).isError).toBe(true);
  });

  it('weather_get: a place is geocoded; no place → shared location, then home city; coordinates rounded to 0.1°', async () => {
    const env = createToolEnv();
    await env.run(weatherTool, { place: 'Almaty', days: 3 });
    expect(env.s.caps.weather.calls.at(-1)).toEqual({ lat: 43.2, lon: 77, days: 3 });
    const none = await env.run(weatherTool, {});
    expect(none.isError).toBe(true);
    env.s.repos.users.updateSettings(env.user.id, { homeCity: { name: 'Kyiv', lat: 50.45, lon: 30.52 } });
    await env.run(weatherTool, {});
    expect(env.s.caps.weather.calls.at(-1)).toMatchObject({ lat: 50.5, lon: 30.5, days: 2 });
    env.s.location.set(env.user.id, { lat: 41.0123, lon: 28.9765 });
    await env.run(weatherTool, {});
    expect(env.s.caps.weather.calls.at(-1)).toMatchObject({ lat: 41, lon: 29 });
    // guests never get the owner's location or home city
    expect((await env.run(weatherTool, {}, env.ctx({ surface: 'guest', userId: null, scope: null }))).isError).toBe(true);
    expect((await env.run(weatherTool, { place: 'Atlantis' })).content).toContain('PLACE_NOT_FOUND');
  });

  it('share_place pushes a venue effect; nothing found → no pin', async () => {
    const env = createToolEnv();
    const out = await env.run(placeTool, { name: 'Ramen Bar' });
    expect(out.isError).toBeFalsy();
    expect(env.effects).toEqual([{ kind: 'venue', lat: 43.238, lon: 76.945, title: 'Ramen Bar', address: 'Abay Ave 10, Almaty' }]);
    expect((await env.run(placeTool, { name: 'Nowhere Cafe' })).isError).toBe(true);
    expect(env.effects).toHaveLength(1);
  });

  it('react enqueues one setMessageReaction on the trigger message', async () => {
    const env = createToolEnv();
    await env.run(reactTool, { emoji: '👍' });
    expect(env.outbox).toHaveLength(1);
    expect(env.outbox[0]).toMatchObject({ method: 'setMessageReaction', chatId: 1001, payload: { message_id: 55, reaction: [{ type: 'emoji', emoji: '👍' }] } });
    expect(() => reactTool.input.parse({ emoji: '💩' })).toThrow();
  });

  it('offer_choices creates a choice set and ch: buttons; location_request pushes the keyboard effect', async () => {
    const env = createToolEnv();
    await env.run(choicesTool, { options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }] });
    const eff = env.effects[0] as { kind: string; rows: Array<Array<{ text: string; callback_data: string }>> };
    expect(eff.kind).toBe('buttons');
    expect(eff.rows.flat().map((b) => b.text)).toEqual(['Yes', 'No', 'Later']);
    expect(eff.rows.flat().every((b) => b.callback_data.startsWith('ch'))).toBe(true);
    expect([...(env.s.choices as unknown as { sets: Map<string, { options: string[] }> }).sets.values()][0]?.options).toEqual(['Yes', 'No', 'Later']);
    expect(() => choicesTool.input.parse({ options: [{ label: 'only one' }] })).toThrow();
    await env.run(locationTool, { reason: 'to find places near you' });
    expect(env.effects[1]).toEqual({ kind: 'location_request', text: '📍 to find places near you' });
  });

  it('use_toolkit loads the kit for the conversation and lists its tools', async () => {
    const env = createToolEnv();
    const out = await env.run(useToolkitTool, { name: 'calendar', reason: 'user asked about meetings' });
    expect(out.content).toBe(`Loaded calendar: ${TOOLKITS.calendar.join(', ')}`);
    expect(env.s.toolkits.active('conv_1')).toContain('calendar');
    expect(() => useToolkitTool.input.parse({ name: 'core', reason: '' })).toThrow();
  });

  it('integration_connect sends the Connect card, or says it is already connected', async () => {
    const env = createToolEnv({ connected: { gmail: false } });
    const out = await env.run(connectTool, { integration: 'gmail', reason: 'to find the invoice' });
    expect(out.content).toContain('Connect card');
    expect(env.connectCards).toEqual([{ kind: 'gmail', reason: 'to find the invoice' }]);
    expect((await env.run(connectTool, { integration: 'gcal', reason: 'x' })).content).toContain('already connected');
  });
});

describe('web tools on Groq (03 R4)', () => {
  it('prechecks: http(s) only, no IP literals, no local names, no blocked domains', () => {
    for (const bad of ['ftp://example.com', 'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1', 'http://localhost:80/', 'http://printer.local/', 'http://db.internal/', 'https://bit.ly/x', 'https://sub.ngrok-free.app/', 'http://2130706433/', 'https://user:pw@example.com/']) {
      expect(precheckUrl(bad).ok, bad).toBe(false);
    }
    expect(precheckUrl('https://example.com/menu?x=1').ok).toBe(true);
  });

  it('web_search calls the search capability with the run priority; output capped and marked untrusted web', async () => {
    const env = createToolEnv();
    const out = await env.run(webSearchTool, { query: 'ramen near Abay', freshness: 'week' }, env.ctx({ priority: 'background' }));
    expect(env.s.caps.search.calls[0]).toEqual({ kind: 'search', q: 'ramen near Abay', priority: 'background' });
    expect(out.untrusted?.source).toBe('web');
    expect(out.content).toContain('[1] Ramen Bar — hours — https://example.com/ramen');
    expect(webSearchTool.classify({ query: 'x' }, env.ctx())).toMatchObject({ actionClass: 'read_public', quotaKind: 'web_search' });
    const long = formatSearchResult({ answer: 'x'.repeat(20_000), sources: [{ title: 't', url: 'https://e.com' }] });
    expect(long.length).toBeLessThanOrEqual(4800);
    expect(long).toContain('https://e.com');
  });

  it('web_fetch rejects private targets before any call and opens public URLs', async () => {
    const env = createToolEnv();
    const bad = await env.run(webFetchTool, { url: 'http://169.254.169.254/latest/meta-data' });
    expect(bad.isError).toBe(true);
    expect(env.s.caps.search.calls).toHaveLength(0);
    const ok = await env.run(webFetchTool, { url: 'https://example.com/menu', question: 'open late?' });
    expect(ok.isError).toBeFalsy();
    expect(env.s.caps.search.calls[0]).toMatchObject({ kind: 'open', q: 'https://example.com/menu' });
  });
});

describe('settings_update and ledger_query', () => {
  it('updates settings with Undo restoring the previous values; tz change reschedules; plan cap enforced', async () => {
    const env = createToolEnv();
    let rescheduled = '';
    (env.s.reminders as unknown as { rescheduleForTz: (u: string, tz: string) => number }).rescheduleForTz = (_u, tz) => ((rescheduled = tz), 1);
    const before = env.s.repos.users.settings(env.user.id);
    const out = await env.run(settingsTool, { tz: 'Europe/Moscow', quiet_start: '23:30', persona_name: 'Gora' });
    expect(out.isError).toBeFalsy();
    expect(env.s.repos.users.getById(env.user.id)?.tz).toBe('Europe/Moscow');
    expect(env.s.repos.users.settings(env.user.id).quietStart).toBe('23:30');
    expect(rescheduled).toBe('Europe/Moscow');
    expect(out.ledger?.[0]?.kind).toBe('settings');
    await settingsTool.undo!(out.undo!.payload, env.ctx());
    expect(env.s.repos.users.getById(env.user.id)?.tz).toBe('Asia/Almaty');
    expect(env.s.repos.users.settings(env.user.id).quietStart).toBe(before.quietStart);
    expect(rescheduled).toBe('Asia/Almaty');
    expect((await env.run(settingsTool, { nudge_budget: 9 })).content).toContain('PLAN_LIMIT');
    expect((await env.run(settingsTool, {})).isError).toBe(true);
    expect((await env.run(settingsTool, { permissions: 'act' })).isError).toBe(true); // unknown keys are dropped: nothing to change
  });

  it('ledger_query returns the owner summaries only in a private scope', async () => {
    const env = createToolEnv();
    env.s.ledger.append({ userId: env.user.id, actor: 'agent', kind: 'email_sent', summary: 'email sent to 1 recipient(s)' });
    env.s.ledger.append({ userId: env.user.id, actor: 'agent', kind: 'data_read', summary: 'read 3 emails' });
    const out = await env.run(ledgerTool, { kind: 'email_sent' });
    const entries = JSON.parse(out.content).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'email_sent', summary: 'email sent to 1 recipient(s)' });
    expect((await env.run(ledgerTool, {}, env.ctx({ scope: { kind: 'group', chatId: -100 } }))).isError).toBe(true);
  });
});

describe('make_file', () => {
  it('sanitizes the filename and pushes a document (or photo for png); quota file', async () => {
    const env = createToolEnv();
    const tool = makeFileTool(PROVIDER_PROFILES.anthropic as ProviderProfile);
    expect(tool.classify({ file_type: 'csv', filename: 'x', instructions: 'y' }, env.ctx())).toMatchObject({ actionClass: 'compute', quotaKind: 'file' });
    await env.run(tool, { file_type: 'xlsx', filename: '../../etc/passwd.sh', instructions: 'a table' });
    expect(env.effects[0]).toMatchObject({ kind: 'document', filename: 'passwd.xlsx' });
    await env.run(tool, { file_type: 'png', filename: 'chart', instructions: 'a chart' });
    expect(env.effects[1]).toMatchObject({ kind: 'photo', filename: 'chart.png' });
    expect(safeFilename('a\u0000b<c>.CSV', 'csv')).toBe('abc.csv');
  });

  it('on Groq the enum is csv|md|txt|json|png', () => {
    const tool = makeFileTool(PROVIDER_PROFILES['groq-free'] as ProviderProfile);
    expect(tool.input.safeParse({ file_type: 'xlsx', filename: 'x', instructions: 'y' }).success).toBe(false);
    expect(tool.input.safeParse({ file_type: 'md', filename: 'x', instructions: 'y' }).success).toBe(true);
    expect(NOT_AVAILABLE_ON_GROQ).toMatch(/CSV instead/);
  });

  it('attachments must belong to the conversation', async () => {
    const env = createToolEnv();
    const tool = makeFileTool(PROVIDER_PROFILES.anthropic as ProviderProfile);
    const out = await env.run(tool, { file_type: 'csv', filename: 'x', instructions: 'y', attachment_input_ids: ['in_missing'] });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('ATTACHMENT');
  });
});
