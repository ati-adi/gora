// s07 CAL e2e (spec 07 B1/B2, plan 08 §4.5): the friend-mode connect UX with the fake provider.
//  1. a calendar question with nothing connected → exactly ONE short line + one url button [Подключить Google Календарь];
//  2. completed by POLLING (no callback) → "Готово ✓", then the answer to the original question in the same chat;
//  3. completed by CALLBACK → the same single "Готово ✓" + answer, and the poller stops;
//  4. calendar_respond_invite accepted → the provider's respond runs through the executor after the approval tap;
//  5. first_look (a connect without a pending question) = one friendly line, no model call.
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplyChannel, UserRow } from '../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../src/integrations/fake.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const NOW = Date.UTC(2026, 8, 29, 6, 0); // 11:00 in Almaty
const RU_USER = { id: 1001, first_name: 'Aigerim', username: 'aigerim', language_code: 'ru' };
type Btn = { text: string; url?: string; callback_data?: string };
type Sent = { method: string; text: string; buttons: Btn[] };

async function setup(): Promise<{ app: TestApp; provider: FakeIntegrationProvider; u: UserRow }> {
  const provider = new FakeIntegrationProvider({ now: () => NOW });
  const app = await createTestApp({ integrations: provider, now: NOW });
  const row = app.s.repos.users.upsertFromTelegram(RU_USER, { dmChatId: 1001 });
  app.s.repos.users.update(row.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
  app.s.repos.users.grantConsent({ userId: row.id, kind: 'terms', textVersion: 'v1', via: 'command' });
  return { app, provider, u: app.s.repos.users.getById(row.id)! };
}
const sent = (app: TestApp): Sent[] =>
  app.tg.calls
    .filter((c) => ['sendMessage', 'sendRichMessage', 'editMessageText', 'editRichMessage'].includes(c.method))
    .map((c) => ({ method: c.method, text: String(c.payload.text ?? c.payload.rich_message?.markdown ?? ''), buttons: ((c.payload.reply_markup?.inline_keyboard ?? []) as Btn[][]).flat() }));
const withUrl = (app: TestApp) => sent(app).filter((m) => m.buttons.some((b) => b.url));
const chips = (app: TestApp) => sent(app).filter((m) => m.buttons.some((b) => b.callback_data?.startsWith('cn:')));
const done = (app: TestApp) => sent(app).filter((m) => m.text.startsWith('Готово ✓'));
const TOMORROW = { from_local: '2026-09-30T00:00', to_local: '2026-10-01T00:00' };

/** The owner asks about tomorrow; the scripted model tries the calendar, is told it is not connected, says one line. */
async function askTomorrow(app: TestApp): Promise<void> {
  app.llm.push(turn().toolUse('calendar_list_events', TOMORROW, 'toolu_q1'));
  app.llm.push(say('Подключи календарь — и сразу скажу.'));
  await app.userSends('Что у меня завтра в календаре?', { user: RU_USER });
  await app.settle();
}
/** The resumed run: the scripted model lists tomorrow and answers. */
function scriptAnswer(app: TestApp): void {
  app.llm.push(turn().toolUse('calendar_list_events', TOMORROW, 'toolu_q2'));
  app.llm.push(say('Завтра: Team sync в 09:00 и стоматолог в 13:00.'));
}

describe('calendar connect (spec 07 B2)', () => {
  it('not connected → one line + [Подключить Google Календарь] → completed by polling → "Готово ✓" + the answer', async () => {
    const { app, provider, u } = await setup();
    t = app;
    await askTomorrow(app);

    // 1. exactly one short line with one url button; no chips, no "Зачем" paragraph
    const cards = withUrl(app);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).not.toContain('\n');
    expect(cards[0]!.text).not.toMatch(/Зачем|Why/);
    expect(cards[0]!.buttons).toHaveLength(1);
    expect(cards[0]!.buttons[0]!.text).toBe('Подключить Google Календарь');
    expect(chips(app)).toHaveLength(0);
    expect(app.s.integrations.pendingLinks?.(u.id)).toEqual([expect.objectContaining({ kind: 'gcal' })]);

    // 2. the owner finishes the consent screen, but the callback never arrives: the poller notices within 5 s
    const ref = provider.pendingRefs().at(-1)!;
    await app.advance(5_000);
    expect(done(app)).toHaveLength(0); // still pending
    provider.completeByPoll(ref);
    scriptAnswer(app);
    await app.advance(5_000);
    await app.settle();

    expect(app.s.integrations.status(u.id).gcal).toEqual({ connected: true, level: 'draft' });
    expect(done(app)).toHaveLength(1);
    expect(done(app)[0]!.buttons).toHaveLength(0);
    const resumed = app.llm.requests.at(-2)!;
    expect(JSON.stringify(resumed.messages)).toContain('integration_connected');
    expect(JSON.stringify(resumed.messages)).toContain('Что у меня завтра в календаре?'); // the pending question is in context
    expect(provider.calls).toContain(`cal.list:${u.id}`);
    const texts = sent(app).map((m) => m.text);
    const doneAt = texts.findIndex((x) => x.startsWith('Готово ✓'));
    expect(texts.slice(doneAt + 1).some((x) => x.includes('Team sync в 09:00'))).toBe(true);
    expect(texts.some((x) => x.startsWith('👀'))).toBe(false); // the resumed answer is the first look
    expect(chips(app)).toHaveLength(0);
    expect(app.s.integrations.pendingLinks?.(u.id)).toEqual([]);

    // the poller stopped: no further status checks
    const polls = provider.calls.filter((c) => c.startsWith('connectionStatus:')).length;
    await app.advance(60_000);
    expect(provider.calls.filter((c) => c.startsWith('connectionStatus:')).length).toBe(polls);
  });

  it('completed by callback → the same single "Готово ✓" + answer, the poller stops, a late poll/callback adds nothing', async () => {
    const { app, provider, u } = await setup();
    t = app;
    await askTomorrow(app);
    const url = new URL(withUrl(app)[0]!.buttons[0]!.url!);
    const state = url.searchParams.get('state')!;
    const ref = provider.pendingRefs().at(-1)!;

    scriptAnswer(app);
    const res = await app.s.integrations.oauthCallback({ state, status: 'success', connected_account_id: ref });
    expect(res.status).toBe(200);
    await app.settle();
    expect(done(app)).toHaveLength(1);
    expect(sent(app).some((m) => m.text.includes('Team sync в 09:00'))).toBe(true);

    // the provider now also reports active: the poller must not complete it a second time
    provider.completeByPoll(ref);
    const polls = provider.calls.filter((c) => c.startsWith('connectionStatus:')).length;
    await app.advance(30_000);
    expect(provider.calls.filter((c) => c.startsWith('connectionStatus:')).length).toBe(polls);
    // a repeated redirect shows the "already connected" page and sends nothing
    const again = await app.s.integrations.oauthCallback({ state, status: 'success', connected_account_id: ref });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('already connected');
    await app.settle();
    expect(done(app)).toHaveLength(1);
    expect(app.s.ledger.list(u.id, { limit: 50 }).filter((e) => e.kind === 'connection')).toHaveLength(1);
  });

  it('a callback for another connected account than the issued link is refused', async () => {
    const { app, provider, u } = await setup();
    t = app;
    await askTomorrow(app);
    const state = new URL(withUrl(app)[0]!.buttons[0]!.url!).searchParams.get('state')!;
    expect(provider.pendingRefs()).toHaveLength(1);
    const res = await app.s.integrations.oauthCallback({ state, status: 'success', connected_account_id: 'ca_someone_else' });
    expect(res.status).toBe(400);
    expect(app.s.integrations.status(u.id).gcal.connected).toBe(false);
  });

  it('calendar_respond_invite accepted → the provider respond runs through the executor after approval', async () => {
    const { app, provider, u } = await setup();
    t = app;
    const { url } = await app.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    await app.s.integrations.devConnect(new URL(url).searchParams.get('state')!);
    app.s.repos.users.setPermission(u.id, 'gcal', 'act', 'callback');
    await app.settle();

    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: 1001 });
    const run = app.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1001, triggerMessageId: 3 }, maxTokens: 1000 });
    const out = await app.s.executor.processRound(run, conv, 1, [{ type: 'tool_use', id: 'toolu_r1', name: 'calendar_respond_invite', input: { event_id: 'demo-e3', response: 'accepted' } }], null as unknown as ReplyChannel, new AbortController().signal);
    const approvalId = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    expect(approvalId).toBeTruthy();
    expect(provider.calls).not.toContain(`cal.respond:${u.id}`); // nothing before the tap
    await app.settle();
    const card = app.lastCard();
    await app.tap(card.buttons.find((b) => b.callback_data?.startsWith(`a1:${approvalId}:y`))!.callback_data!, { messageId: card.messageId });
    await app.settle();
    expect(provider.calls).toContain(`cal.respond:${u.id}`);
    expect(app.s.approvals.get(approvalId, u.id)?.status).toBe('executed');
  });

  it('first_look without a pending question = one friendly line (no model call, no card)', async () => {
    const { app, u } = await setup();
    t = app;
    const { url } = await app.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 }); // e.g. from the Mini App
    expect((await app.s.integrations.oauthCallback({ state: new URL(url).searchParams.get('state')!, status: 'success' })).status).toBe(200);
    await app.advance(5_000);
    await app.settle();
    expect(done(app).map((m) => m.text)).toEqual(['Готово ✓ Google Календарь подключён.']);
    const look = sent(app).filter((m) => m.text.startsWith('👀'));
    expect(look).toHaveLength(1);
    expect(look[0]!.text).toBe('👀 Одним глазком: на завтра 2 события, первое — «[Demo data] Team sync» в 09:00. Больше ничего не трогаю.');
    expect(look[0]!.buttons).toHaveLength(0);
    expect(app.llm.requests).toHaveLength(0);
    expect(sent(app)).toHaveLength(2);
  });
});
