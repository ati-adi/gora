// 01 §15.2 WP5 integrations e2e, updated for spec 07 B2 (s07 CAL): not_connected → a one-line Connect card; fake connect
// callback → "Done ✓" (chips live in the Mini App) → the pending question resumes. Real service + FakeIntegrationProvider.
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplyChannel, UserRow } from '../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../src/integrations/fake.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { say } from '../harness/scriptedTransport.ts';

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
  // s07 (spec 07 B2): one-line Connect card, "Done ✓" without chips (they live in the Mini App), then the pending question
  // resumes (GoraEvent integration_connected) instead of first_look's "I read: …" + card.
  it('not_connected → one-line Connect card (deduped) → fake connect → "Done ✓" → the question resumes; legacy chips still work', async () => {
    const provider = new FakeIntegrationProvider({ now: () => Date.UTC(2026, 8, 28, 9, 0) });
    t = await createTestApp({ integrations: provider });
    expect(t.s.integrations.provider).toBe(provider);
    const u = addUser(t);
    expect(t.s.integrations.status(u.id).gmail).toEqual({ connected: false, level: 'none' });

    // 1. a Gmail tool without a connection → Sentinel not_connected → the Connect card (url button), one line
    const r = await round(u, 'gmail_search', { query: 'invoice' }, 'toolu_ic1');
    expect(String(r.results[0]!.content)).toMatch(/not_connected|connect/i);
    // the model then also calls integration_connect in the same breath: no second card
    await round(u, 'integration_connect', { integration: 'gmail', reason: 'to find the invoice' }, 'toolu_ic1b');
    await t.settle();
    const cards = keyboards().filter((k) => k.buttons.some((b) => b.url?.includes('/dev/fake-connect?state=')));
    expect(cards, 'connect card').toHaveLength(1);
    expect(cards[0]!.text).not.toContain('\n');
    expect(cards[0]!.buttons.map((b) => b.text)).toEqual(['Connect Gmail']);
    const url = new URL(cards[0]!.buttons[0]!.url!);
    expect(url.origin).toBe('https://gora.test');

    // 2. the fake consent screen completes the pending oauth state → "Done ✓" (no chips) → the pending question resumes
    t.llm.push(say('You have one invoice email from Kaspi.'));
    const res = await t.s.integrations.devConnect(url.searchParams.get('state')!);
    expect(res.status).toBe(200);
    const again = await t.s.integrations.devConnect(url.searchParams.get('state')!); // single use: nothing happens twice
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('already connected');
    await t.settle();
    expect(t.s.integrations.status(u.id).gmail).toEqual({ connected: true, level: 'draft' });
    const doneMsgs = keyboards().filter((k) => k.text.startsWith('Done ✓'));
    expect(doneMsgs.map((k) => k.text)).toEqual(['Done ✓ Gmail is connected.']);
    expect(doneMsgs[0]!.buttons).toHaveLength(0);
    expect(keyboards().some((k) => k.buttons.some((b) => b.callback_data?.startsWith('cn:')))).toBe(false);
    expect(JSON.stringify(t.llm.requests.at(-1)!.messages)).toContain('integration_connected');
    expect(keyboards().some((k) => k.text.includes('one invoice email'))).toBe(true);

    // 3. no first_look on top of the resumed answer
    await t.advance(60_000);
    expect(t.tg.calls.some((c) => /^(🔎|👀)/.test(String(c.payload.text ?? '')))).toBe(false);

    // 4. a chip tap from an older message (cn:gmail:act) still sets the level
    await t.tap(t.s.telegram.codec.encode('cn', ['gmail', 'act'], u.tgUserId));
    expect(t.s.integrations.status(u.id).gmail.level).toBe('act');
    expect(t.s.ledger.list(u.id, { limit: 20 }).map((e) => e.kind)).toEqual(expect.arrayContaining(['connection', 'permission_change']));

    // 5. now connected: the same tool runs
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
