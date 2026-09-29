// s07 CAL (spec 07 B2, plan 08 §4.1): the friend-mode connect UX at the tool and service level — calendar tools send
// the one-line card themselves (with the run's conversation as the resume target), cards are deduped per chat, and a
// resume target must be the owner's own DM/topic conversation.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../../src/integrations/fake.ts';
import { createLinksRepo } from '../../../src/integrations/links.ts';
import type { IntegrationService } from '../../../src/contracts/index.ts';
type ConnectChat = Parameters<IntegrationService['sendConnectCard']>[2];
import { CALENDAR_TOOLS } from '../../../src/tools/impl/calendar.ts';
import { connectTool } from '../../../src/tools/impl/connect.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { createToolEnv } from '../tools/env.ts';

const listTool = CALENDAR_TOOLS.find((x) => x.name === 'calendar_list_events')!;
const RANGE = { from_local: '2026-09-30T00:00', to_local: '2026-10-01T00:00' };

describe('calendar tools when Google Calendar is not connected', () => {
  it('DM: the tool sends the Connect card with this conversation as the resume target and asks for ONE short line', async () => {
    const env = createToolEnv({ connected: { gcal: false } });
    const got: Array<{ kind: string; chat: ConnectChat }> = [];
    env.s.integrations.sendConnectCard = async (_u, kind, chat) => void got.push({ kind, chat: chat as ConnectChat });
    const out = await env.run(listTool, RANGE);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('NOT_CONNECTED');
    expect(out.content).toMatch(/ONE short line/);
    expect(got).toEqual([{ kind: 'gcal', chat: { chatId: 1001, resumeConversationId: 'conv_1' } }]);
  });

  it('integration_connect passes the run conversation as the resume target too', async () => {
    const env = createToolEnv({ connected: { gcal: false } });
    const got: ConnectChat[] = [];
    env.s.integrations.sendConnectCard = async (_u, _k, chat) => void got.push(chat as ConnectChat);
    const out = await env.run(connectTool, { integration: 'gcal', reason: 'tomorrow' }, env.ctx({ chat: { chatId: 1001, threadId: 9 }, conversationId: 'conv_topic' }));
    expect(out.content).toMatch(/resumes automatically/);
    expect(got).toEqual([{ chatId: 1001, threadId: 9, resumeConversationId: 'conv_topic' }]);
  });

  it('outside the owner DM/topic (a mission) no card is sent; the model is told to call integration_connect', async () => {
    const env = createToolEnv({ connected: { gcal: false } });
    let cards = 0;
    env.s.integrations.sendConnectCard = async () => void cards++;
    const out = await env.run(listTool, RANGE, env.ctx({ surface: 'mission' }));
    expect(cards).toBe(0);
    expect(out.content).toMatch(/call integration_connect/);
  });
});

describe('IntegrationService.sendConnectCard', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });
  const NOW = Date.UTC(2026, 8, 29, 6, 0);
  function addUser(app: TestApp, tg: number): UserRow {
    const u = app.s.repos.users.upsertFromTelegram({ id: tg, first_name: 'U', language_code: 'en' }, { dmChatId: tg });
    app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
    return app.s.repos.users.getById(u.id)!;
  }
  const cards = (app: TestApp) => app.tg.calls.filter((c) => c.method === 'sendMessage' && JSON.stringify(c.payload.reply_markup ?? {}).includes('"url"'));

  it('one card per service and chat within 2 minutes; another chat or service gets its own; later a fresh one', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t, 1001);
    await t.s.integrations.sendConnectCard(u.id, 'gcal', { chatId: 1001 });
    await t.s.integrations.sendConnectCard(u.id, 'gcal', { chatId: 1001 }, 'again');
    await t.s.integrations.sendConnectCard(u.id, 'gmail', { chatId: 1001 });
    await t.s.integrations.sendConnectCard(u.id, 'gcal', { chatId: 1001, threadId: 5 });
    await t.settle();
    expect(cards(t)).toHaveLength(3);
    await t.advance(2 * 60_000 + 1);
    await t.s.integrations.sendConnectCard(u.id, 'gcal', { chatId: 1001 });
    await t.settle();
    expect(cards(t)).toHaveLength(4);
    const texts = cards(t).map((c) => String(c.payload.text));
    expect(texts.every((x) => !x.includes('\n'))).toBe(true);
  });

  it('the resume target: the explicit conversation when it is the owner\'s DM/topic, never another user\'s; else the chat\'s DM', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t, 1001);
    const other = addUser(t, 2002);
    const mine = t.s.conversations.resolve({ kind: 'dm', tgUserId: 1001 }, { userId: u.id, tgChatId: 1001 });
    const theirs = t.s.conversations.resolve({ kind: 'dm', tgUserId: 2002 }, { userId: other.id, tgChatId: 2002 });
    const links = createLinksRepo(t.s);
    const resumeOf = () => links.pendingFor(u.id, NOW).length && t!.s.db.prepare('SELECT resume_conversation_id AS r FROM integration_links ORDER BY rowid DESC LIMIT 1').get<{ r: string | null }>()!.r;

    await t.s.integrations.sendConnectCard(u.id, 'gcal', { chatId: 1001, resumeConversationId: theirs.id } as ConnectChat);
    expect(resumeOf()).toBeNull();
    await t.s.integrations.sendConnectCard(u.id, 'gmail', { chatId: 1001 });
    expect(resumeOf()).toBe(mine.id); // resolved from the chat (the executor's not_connected card)
    await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 }); // Mini App: nothing to resume
    expect(resumeOf()).toBeNull();
  });
});
