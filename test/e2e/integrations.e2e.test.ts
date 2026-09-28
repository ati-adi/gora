// 01 §15.2 WP5 integrations e2e: not_connected → Connect card; fake connect callback → permission chips → first_look
// posts "I read: …" and exactly one card. Real WP5 service + FakeIntegrationProvider; the rest is whatever is built.
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplyChannel, UserRow } from '../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../src/integrations/fake.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { turn } from '../harness/scriptedTransport.ts';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

function addUser(app: TestApp): UserRow {
  const u = app.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
  app.s.repos.users.grantConsent({ userId: u.id, kind: 'terms', textVersion: 'v1', via: 'command' });
  return app.s.repos.users.getById(u.id)!;
}
const dm = (u: UserRow) => t.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: u.dmChatId! });
async function round(u: UserRow, name: string, input: unknown, id: string) {
  const conv = dm(u);
  const run = t.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: u.dmChatId!, triggerMessageId: 3 }, maxTokens: 1000 });
  return t.s.executor.processRound(run, conv, 1, [{ type: 'tool_use', id, name, input }], null as unknown as ReplyChannel, new AbortController().signal);
}
type Btn = { text: string; url?: string; callback_data?: string };
const keyboards = () =>
  t.tg.calls
    .filter((c) => ['sendMessage', 'sendRichMessage'].includes(c.method))
    .map((c) => ({ text: String(c.payload.text ?? c.payload.rich_message?.markdown ?? ''), buttons: ((c.payload.reply_markup?.inline_keyboard ?? []) as Btn[][]).flat(), id: (c.result as { message_id?: number } | undefined)?.message_id }));

describe('integrations e2e', () => {
  it('not_connected → Connect card → fake connect → chips → first_look "I read: …" and exactly one card', async () => {
    const provider = new FakeIntegrationProvider({ now: () => Date.UTC(2026, 8, 28, 9, 0) });
    t = await createTestApp({ integrations: provider });
    expect(t.s.integrations.provider).toBe(provider);
    const u = addUser(t);
    expect(t.s.integrations.status(u.id).gmail).toEqual({ connected: false, level: 'none' });

    // 1. a Gmail tool without a connection → Sentinel not_connected → the Connect card (url button)
    const r = await round(u, 'gmail_search', { query: 'invoice' }, 'toolu_ic1');
    expect(String(r.results[0]!.content)).toMatch(/not_connected|connect/i);
    await t.settle();
    const card = keyboards().find((k) => k.buttons.some((b) => b.url?.includes('/dev/fake-connect?state=')));
    expect(card, 'connect card').toBeDefined();
    const url = new URL(card!.buttons.find((b) => b.url)!.url!);
    expect(url.origin).toBe('https://gora.test');

    // 2. the fake consent screen completes the pending oauth state → "Connected ✓" + permission chips
    const res = await t.s.integrations.devConnect(url.searchParams.get('state')!);
    expect(res.status).toBe(200);
    expect((await t.s.integrations.devConnect(url.searchParams.get('state')!)).status).toBe(400); // single use
    await t.settle();
    expect(t.s.integrations.status(u.id).gmail).toEqual({ connected: true, level: 'draft' });
    const chips = keyboards().find((k) => k.text.startsWith('Connected ✓'))!;
    expect(chips.buttons.map((b) => b.text)).toEqual(['Read only', 'Read + drafts ✓', 'Can propose sends']);

    // 3. tap "Can propose sends" (cn:gmail:act)
    await t.tap(chips.buttons[2]!.callback_data!, { messageId: chips.id! });
    expect(t.s.integrations.status(u.id).gmail.level).toBe('act');
    expect(t.s.ledger.list(u.id, { limit: 20 }).map((e) => e.kind)).toEqual(expect.arrayContaining(['connection', 'permission_change']));

    // 4. first_look (≤ 60 s): "I read: …" then an event run that surfaces exactly one card
    const inbox = await provider.mail(u.id, 'x').search({ query: 'newer_than:2d', maxResults: 50 });
    t.llm.push(turn().toolUse('gmail_create_draft', { to: ['anna@example.com'], subject: 'Re: Contract review', body: 'Hi Anna, Thursday 15:00 works for me.' }, 'toolu_fl1'));
    t.llm.push(turn().text('I drafted a reply to Anna — want me to send it?'));
    await t.advance(60_000);
    const readLine = t.tg.calls.find((c) => String(c.payload.text ?? '').startsWith('🔎 I read:'));
    expect(readLine?.payload.text).toBe(`🔎 I read: ${inbox.length} email headers from the last 48 h — nothing else.`);
    const firstLookCards = keyboards().filter((k) => k.buttons.length > 0 && !k.text.startsWith('Connected') && !k.buttons.some((b) => b.url));
    expect(firstLookCards).toHaveLength(1);
    // the recipient came from an email (tainted first-look run) → an approval card, nothing written yet
    expect(firstLookCards[0]!.buttons.some((b) => b.callback_data?.startsWith('a1:'))).toBe(true);
    expect(provider.drafts(u.id)).toHaveLength(0);

    // 5. now connected: the same tool runs and its output is email-tainted
    const ok = await round(u, 'gmail_search', { query: 'invoice' }, 'toolu_ic2');
    expect(String(ok.results[0]!.content)).toContain('invoice');
  });

  it('the provider survives a restart; revoke disconnects and resets the level', async () => {
    const provider = new FakeIntegrationProvider({ now: () => Date.UTC(2026, 8, 28, 9, 0) });
    t = await createTestApp({ integrations: provider });
    const u = addUser(t);
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    const state = new URL(url).searchParams.get('state')!;
    expect((await t.s.integrations.oauthCallback({ state: 'bogus' })).status).toBe(400);
    expect((await t.s.integrations.oauthCallback({ state, status: 'success' })).status).toBe(200);
    t = await t.restart();
    expect(t.s.integrations.provider).toBe(provider);
    expect(t.s.integrations.status(u.id).gcal.connected).toBe(true);
    expect((await t.s.integrations.calendar(u.id)!.list({ fromIso: '2026-09-28T00:00:00Z', toIso: '2026-10-05T00:00:00Z', max: 10 })).length).toBe(3);
    await t.s.integrations.revoke(u.id, 'gcal');
    expect(t.s.integrations.status(u.id).gcal).toEqual({ connected: false, level: 'none' });
    expect(provider.revoked).toEqual([{ userId: u.id, kind: 'gcal' }]);
    expect(t.s.integrations.calendar(u.id)).toBeNull();
  });
});
