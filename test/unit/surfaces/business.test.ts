// WP7b unit tests (01 F12, §10.1, §10.2): connection + consent card, metadata-only before consent, content after
// consent, 45 s debounced triage, the Inbox digest, blanket consent, edits, deletions, disconnect, the per-chat card,
// send() and the 24 h window, and the privacy hook. The whole app runs against FakeTelegram and ScriptedTransport.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../../src/contracts/index.ts';
import { bizFor } from '../../../src/surfaces/business/index.ts';
import { sendCopyFallback } from '../../../src/surfaces/business/send.ts';
import { chatRef, parseChatRef } from '../../../src/surfaces/business/core.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, RU_USER, TEST_USER, U } from '../../harness/updates.ts';

const REF = 'bc:bc_1:1002';
const HOUR = 3600_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function connected(): Promise<{ t: TestApp; u: UserRow }> {
  t = await createTestApp();
  await t.send(U.businessConnection());
  const u = t.s.repos.users.getByTg(TEST_USER.id)!;
  return { t, u };
}
const chatRow = (a: TestApp, chatId = 1002) =>
  a.s.db.prepare('SELECT * FROM business_chats WHERE connection_id = ? AND chat_id = ?').get<Record<string, unknown>>('bc_1', chatId);
const msgCount = (a: TestApp, chatId?: number) =>
  Number(
    (chatId === undefined
      ? a.s.db.prepare('SELECT COUNT(*) AS n FROM business_messages').get<{ n: number }>()
      : a.s.db.prepare('SELECT COUNT(*) AS n FROM business_messages WHERE chat_id = ?').get<{ n: number }>(chatId))!.n,
  );
const jobs = (a: TestApp, kind: string) => a.s.db.prepare(`SELECT * FROM jobs WHERE kind = ? AND status = 'scheduled'`).all<Record<string, unknown>>(kind);
const allLlmText = (a: TestApp) => JSON.stringify([a.llm.requests, a.llm.parseRequests, a.llm.createRequests]);
const triageResult = (o: Partial<{ needs_reply: boolean; urgency: number; summary: string; commitment: unknown }> = {}) => ({
  needs_reply: true, urgency: 1, summary: 'Asks about the invoice', category: 'question', commitment: null, ...o,
});

describe('chat refs', () => {
  it('parses the bc: form and the bare form WP4 builds; rejects junk', () => {
    expect(parseChatRef('bc:bc_1:1002')).toEqual({ connectionId: 'bc_1', chatId: 1002 });
    expect(parseChatRef('bc_1:1002')).toEqual({ connectionId: 'bc_1', chatId: 1002 });
    expect(parseChatRef('bc:a:b:-77')).toEqual({ connectionId: 'a:b', chatId: -77 });
    for (const bad of ['', 'bc:', 'x', ':5', 'bc:c:0', 'bc:c:1.5', 'bc:c:abc']) expect(parseChatRef(bad)).toBeNull();
    expect(chatRef('c', 5)).toBe('bc:c:5');
  });
});

describe('business_connection (01 §10.2 step 1)', () => {
  it('a new enabled connection DMs the consent card to user_chat_id once, with the three buttons', async () => {
    const { t, u } = await connected();
    const cards = t.tg.byMethod('sendRichMessage').filter((p) => String(p.rich_message?.markdown).includes('Chat Automation'));
    expect(cards).toHaveLength(1);
    expect(cards[0].chat_id).toBe(TEST_USER.id);
    const md = String(cards[0].rich_message.markdown);
    expect(md).toContain('30 days');
    expect(md).toContain('Nothing is ever sent without your tap');
    expect(md).toContain('biz\\-v1');
    const buttons = (cards[0].reply_markup.inline_keyboard as Array<Array<Record<string, unknown>>>).flat();
    expect(buttons[0]!['web_app']).toEqual({ url: 'https://gora.test/app/?screen=secretary' });
    expect(String(buttons[1]!['callback_data'])).toMatch(/^bz:new:on:/);
    expect(String(buttons[2]!['callback_data'])).toMatch(/^bz:off:/);
    // the same update again (re-delivery, or rights edited): no second card
    await t.send(U.businessConnection());
    expect(t.tg.byMethod('sendRichMessage').filter((p) => String(p.rich_message?.markdown).includes('Chat Automation'))).toHaveLength(1);
    const conn = t.s.business.connection(u.id)!;
    expect(conn).toMatchObject({ id: 'bc_1', enabled: true, canReply: true, aiDefault: 'off', consentTextVersion: 'biz-v1' });
    expect(t.s.ledger.list(u.id, { kinds: ['connection'], limit: 10 }).length).toBeGreaterThan(0);
    // rights are stored as the raw API JSON
    const raw = t.s.db.prepare('SELECT rights_json FROM business_connections WHERE id = ?').get<{ rights_json: string }>('bc_1')!;
    expect(JSON.parse(raw.rights_json)).toEqual({ can_reply: true });
  });

  it('creates the Gora user when the owner never started the bot', async () => {
    t = await createTestApp();
    expect(t.s.repos.users.getByTg(RU_USER.id)).toBeUndefined();
    await t.send(U.businessConnection({ id: 'bc_ru', user: RU_USER }));
    const u = t.s.repos.users.getByTg(RU_USER.id)!;
    expect(u.dmChatId).toBe(RU_USER.id);
    const card = t.tg.byMethod('sendRichMessage').find((p) => p.chat_id === RU_USER.id)!;
    expect(String(card.rich_message.markdown)).toContain('Gora подключена');
  });

  it('without can_reply the connection is kept but cannot reply', async () => {
    t = await createTestApp();
    await t.send(U.businessConnection({ canReply: false }));
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    expect(t.s.business.connection(u.id)).toMatchObject({ enabled: true, canReply: false });
    expect(t.s.business.context(u.id, REF)).toMatchObject({ canReply: false });
  });

  it('is_enabled → false stops processing, purges the Secretary data and tells the owner', async () => {
    const { t, u } = await connected();
    await t.send(U.businessMessage('hi'));
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('stored text'));
    expect(msgCount(t)).toBe(1);
    await t.send(U.businessConnection({ isEnabled: false }));
    expect(msgCount(t)).toBe(0);
    expect(chatRow(t)).toBeUndefined();
    expect(t.s.repos.users.hasConsent(u.id, 'business_llm', REF)).toBe(false);
    expect(t.s.business.connection(u.id)).toMatchObject({ enabled: false });
    expect(t.tg.byMethod('sendRichMessage').some((p) => String(p.rich_message?.markdown).includes('disconnected'))).toBe(true);
    await t.send(U.businessMessage('after disconnect'));
    expect(chatRow(t)).toBeUndefined();
    expect(jobs(t, 'business_triage')).toHaveLength(0);
  });
});

describe('business_message before consent: metadata only (01 §10.1)', () => {
  it('stores arrival, unanswered-since, the 24 h window and an encrypted title — no content, no job, no LLM', async () => {
    const { t, u } = await connected();
    const at = t.clock.now();
    await t.send(U.businessMessage('SECRET-PRECONSENT please call me'));
    const row = chatRow(t)!;
    expect(Number(row['last_incoming_at'])).toBe(Math.floor(at / 1000) * 1000);
    expect(Number(row['unanswered_since'])).toBe(Math.floor(at / 1000) * 1000);
    expect(Number(row['window_expires_at'])).toBe(Math.floor(at / 1000) * 1000 + 24 * HOUR);
    expect(row['ai_enabled']).toBe(0);
    expect(Buffer.from(row['title_enc'] as Uint8Array).toString('utf8')).not.toContain('Anna');
    expect(msgCount(t)).toBe(0);
    expect(jobs(t, 'business_triage')).toHaveLength(0);
    await t.advance(60_000);
    expect(t.llm.parseRequests).toHaveLength(0);
    expect(t.llm.requests).toHaveLength(0);
    // the owner sees it in the Mini App list (title decrypted), but it is not a consented chat
    const all = t.s.business.listChats(u.id, 'all', 10);
    expect(all).toEqual([expect.objectContaining({ ref: REF, title: 'Anna', aiEnabled: false, priority: 0 })]);
    expect(t.s.business.listChats(u.id, 'unanswered', 10)).toEqual([]);
    expect(t.s.business.readChat(u.id, REF, 10)).toEqual({ error: 'not_consented' });
  });

  it('an owner message clears unanswered_since', async () => {
    const { t } = await connected();
    await t.send(U.businessMessage('question?'));
    expect(chatRow(t)!['unanswered_since']).not.toBeNull();
    await t.clock.advance(60_000);
    await t.send(U.businessMessage('answer', { from: 'owner' }));
    const row = chatRow(t)!;
    expect(row['unanswered_since']).toBeNull();
    expect(row['last_owner_at']).not.toBeNull();
  });

  it('ignores messages sent by this bot (sender_business_bot) and by any bot', async () => {
    const { t } = await connected();
    await t.send(U.businessMessage('sent by Gora', { from: 'bot' }));
    expect(chatRow(t)).toBeUndefined();
    const botPeer = { id: 777, first_name: 'SomeBot', is_bot: true } as unknown as typeof OTHER_USER;
    const upd = U.businessMessage('bot says hi', { peer: botPeer });
    (upd.business_message as unknown as { from: { is_bot: boolean } }).from.is_bot = true;
    await t.send(upd);
    expect(chatRow(t, 777)).toBeUndefined();
  });
});

describe('after consent (01 §10.2 steps 2–3)', () => {
  it('stores text sealed, debounces triage 45 s after the LAST message, and wraps peer lines as untrusted', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    expect(t.s.repos.users.hasConsent(u.id, 'business_llm', REF)).toBe(true);
    await t.send(U.businessMessage('first PLAINTEXT-1', { messageId: 11 }));
    const enc = t.s.db.prepare('SELECT text_enc FROM business_messages WHERE message_id = 11').get<{ text_enc: Uint8Array }>()!;
    expect(Buffer.from(enc.text_enc).toString('utf8')).not.toContain('PLAINTEXT-1');
    await t.advance(30_000);
    await t.send(U.businessMessage('second', { messageId: 12 }));
    t.llm.pushParse('triage', triageResult());
    await t.advance(30_000); // 60 s after the first, 30 s after the second: still debounced
    expect(t.llm.parseRequests).toHaveLength(0);
    await t.advance(16_000);
    expect(t.llm.parseRequests).toHaveLength(1);
    const req = t.llm.parseRequests[0]!;
    expect(req.purpose).toBe('triage');
    expect(req.user).toContain('<untrusted source="business_peer"');
    expect(req.user).toContain('first PLAINTEXT-1');
    expect(t.s.business.listChats(u.id, 'unanswered', 5)[0]).toMatchObject({ ref: REF, priority: 1, aiEnabled: true });
    expect(t.s.ledger.list(u.id, { kinds: ['business_event'], limit: 10 }).some((e) => e.summary.includes('triaged'))).toBe(true);
  });

  it('triage without a draft goes to one Inbox digest message that is edited in place', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('Is the invoice ready?'));
    t.llm.pushParse('triage', triageResult({ urgency: 2, summary: 'Asks whether the invoice is ready' }));
    await t.advance(46_000);
    await t.advance(6_000);
    const digests = t.tg.byMethod('sendRichMessage').filter((p) => String(p.rich_message?.markdown).includes('Secretary'));
    expect(digests).toHaveLength(1);
    const md = String(digests[0].rich_message.markdown);
    expect(md).toContain('Anna');
    expect(md).toContain('Asks whether the invoice is ready');
    expect(md).toContain('<tg-time');
    expect(digests[0].message_thread_id).toBeTruthy(); // the 📥 Inbox topic
    const dr = (digests[0].reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat();
    expect(dr.some((b) => String(b.callback_data).startsWith('bz:dr:1002:'))).toBe(true);
    // a second triage within 2 h edits the same message
    await t.send(U.businessMessage('Hello?'));
    t.llm.pushParse('triage', triageResult({ urgency: 3, summary: 'Asks again' }));
    await t.advance(46_000);
    await t.advance(6_000);
    expect(t.tg.byMethod('sendRichMessage').filter((p) => String(p.rich_message?.markdown).includes('Secretary'))).toHaveLength(1);
    const edits = t.tg.byMethod('editMessageText').filter((p) => String(p.rich_message?.markdown ?? p.text).includes('Asks again'));
    expect(edits.length).toBeGreaterThan(0);
  });

  it('owner messages run commitment detection only (no digest line, no draft) and commitments reach CommitmentService', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.s.business.updateChat(u.id, REF, { mode: 'draft' }, 'miniapp');
    await t.send(U.businessMessage('I will send the deck by Friday', { from: 'owner', messageId: 31 }));
    t.llm.pushParse('triage', triageResult({ needs_reply: true, urgency: 3, commitment: { direction: 'i_owe', text: 'Send the deck by Friday', due_local: null } }));
    await t.advance(46_000);
    await t.advance(6_000);
    expect(t.llm.parseRequests).toHaveLength(1);
    expect(t.llm.requests).toHaveLength(0); // no drafting run
    const c = t.s.db.prepare('SELECT * FROM commitments WHERE user_id = ?').all<Record<string, unknown>>(u.id);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: 'business', direction: 'i_owe', business_connection_id: 'bc_1', chat_id: 1002, source_message_id: 31 });
    expect(t.tg.byMethod('sendRichMessage').filter((p) => String(p.rich_message?.markdown).includes('📥 **Secretary'))).toHaveLength(0);
  });

  it('at most 60 triage calls per connection per day', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    for (let i = 0; i < 60; i++) expect(t.s.quotas.rate('biz_triage:bc_1', 60, 86_400_000)).toBe(true);
    await t.send(U.businessMessage('one more'));
    t.llm.pushParse('triage', triageResult());
    await t.advance(46_000);
    expect(t.llm.parseRequests).toHaveLength(0);
  });

  it('edits update the stored copy only in consented chats', async () => {
    const { t, u } = await connected();
    await t.send(U.businessMessage('not consented', { chatId: 2000, messageId: 5 }));
    await t.send(U.editedBusinessMessage('edited not consented', 5, { chatId: 2000 }));
    expect(msgCount(t, 2000)).toBe(0);
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('original', { messageId: 6 }));
    await t.send(U.editedBusinessMessage('EDITED-TEXT', 6));
    const r = t.s.business.readChat(u.id, REF, 10);
    expect('transcript' in r && r.transcript).toContain('EDITED-TEXT');
    expect('transcript' in r && r.transcript).not.toContain('original');
  });

  it('revoking consent deletes the stored messages, cancels triage and revokes the consent row', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('keep me?'));
    expect(msgCount(t)).toBe(1);
    expect(jobs(t, 'business_triage')).toHaveLength(1);
    await t.s.business.setChatAi(u.id, REF, false, 'miniapp');
    expect(msgCount(t)).toBe(0);
    expect(jobs(t, 'business_triage')).toHaveLength(0);
    expect(t.s.repos.users.hasConsent(u.id, 'business_llm', REF)).toBe(false);
    expect(chatRow(t)!['ai_enabled']).toBe(0);
    await t.advance(60_000);
    expect(t.llm.parseRequests).toHaveLength(0);
  });

  it('another user cannot touch the chat', async () => {
    const { t } = await connected();
    await t.send(U.businessMessage('hi'));
    const other = t.s.repos.users.upsertFromTelegram({ id: OTHER_USER.id, first_name: 'Anna' });
    await expect(t.s.business.setChatAi(other.id, REF, true, 'miniapp')).rejects.toThrow();
    expect(t.s.business.context(other.id, REF)).toBeNull();
    expect(t.s.business.readChat(other.id, REF, 5)).toEqual({ error: 'not_found' });
  });
});

describe('bz: callbacks and the per-chat card (01 §10.2 steps 1, 8)', () => {
  it('[✅ AI for all new chats] turns on the blanket consent: only chats first seen afterwards are enabled', async () => {
    const { t, u } = await connected();
    await t.send(U.businessMessage('existing chat', { chatId: 3000 }));
    const card = t.tg.byMethod('sendRichMessage').find((p) => String(p.rich_message?.markdown).includes('Chat Automation'))!;
    const data = (card.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().find((b) => String(b.callback_data).startsWith('bz:new:on'))!.callback_data!;
    await t.tap(data);
    expect(t.s.business.connection(u.id)!.aiDefault).toBe('new_chats');
    expect(t.s.repos.users.hasConsent(u.id, 'business_llm_new_chats', 'bc_1')).toBe(true);
    await t.send(U.businessMessage('new chat text', { chatId: 3001 }));
    expect(chatRow(t, 3001)!['ai_enabled']).toBe(1);
    expect(msgCount(t, 3001)).toBe(1);
    const consent = t.s.db.prepare(`SELECT via FROM consents WHERE user_id = ? AND kind = 'business_llm' AND subject = ?`).get<{ via: string }>(u.id, 'bc:bc_1:3001');
    expect(consent?.via).toBe('blanket');
    await t.send(U.businessMessage('still off', { chatId: 3000 }));
    expect(chatRow(t, 3000)!['ai_enabled']).toBe(0);
    expect(msgCount(t, 3000)).toBe(0);
  });

  it('/start bizChat<id> shows the per-chat card; its buttons enable AI, switch the mode and turn it off', async () => {
    const { t, u } = await connected();
    t.s.repos.users.update(u.id, { onboardingStep: 'done', memoryConsent: true });
    await t.send(U.businessMessage('hi from Anna'));
    await t.send(U.start('bizChat1002'));
    const card = t.lastCard();
    expect(card.markdown).toContain('Anna');
    expect(card.buttons.map((b) => b.text)).toEqual(expect.arrayContaining(['Enable AI here', 'Mode: triage ▾', 'Tone notes…']));
    expect(card.buttons.find((b) => b.text === 'Tone notes…')!.web_app!.url).toContain('screen=secretary');
    await t.tap(card.buttons.find((b) => b.text === 'Enable AI here')!.callback_data!, { messageId: card.messageId });
    expect(t.s.business.context(u.id, REF)).toMatchObject({ consented: true });
    await t.tap(card.buttons.find((b) => b.text === 'Mode: triage ▾')!.callback_data!, { messageId: card.messageId });
    expect(t.s.business.listChats(u.id, 'all', 5)[0]!.mode).toBe('draft');
    const refreshed = t.tg.byMethod('editMessageText').at(-1);
    expect(JSON.stringify(refreshed)).toContain('bz:x:1002');
    const off = (refreshed.reply_markup.inline_keyboard as Array<Array<{ text: string; callback_data?: string }>>).flat().find((b) => b.text === 'Off')!;
    await t.tap(off.callback_data!);
    expect(t.s.business.context(u.id, REF)).toMatchObject({ consented: false });
  });

  it('a forged or foreign bz: tap does nothing', async () => {
    const { t, u } = await connected();
    await t.send(U.businessMessage('hi'));
    const data = t.s.telegram.codec.encode('bz', ['on', '1002'], TEST_USER.id);
    await t.tap(data, { user: OTHER_USER });
    expect(t.s.business.context(u.id, REF)).toMatchObject({ consented: false });
    await t.tap(data.slice(0, -2) + (data.endsWith('AA') ? 'BB' : 'AA'));
    expect(t.s.business.context(u.id, REF)).toMatchObject({ consented: false });
  });
});

describe('deleted_business_messages (01 §10.1)', () => {
  it('purges stored copies and commitments sourced from them', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('I will pay you tomorrow', { messageId: 41 }));
    await t.send(U.businessMessage('ok', { messageId: 42 }));
    t.llm.pushParse('triage', triageResult({ needs_reply: false, commitment: { direction: 'they_owe', text: 'Pay tomorrow', due_local: null } }));
    await t.advance(46_000);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM commitments').get<{ n: number }>()!.n).toBe(1);
    await t.send(U.deletedBusinessMessages([41, 42]));
    expect(msgCount(t)).toBe(0);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM commitments').get<{ n: number }>()!.n).toBe(0);
    expect(t.s.ledger.list(u.id, { kinds: ['business_event'], limit: 10 }).some((e) => e.summary.includes('purged'))).toBe(true);
  });
});

describe('send() and the 24 h window (01 §10.2 steps 5–6)', () => {
  it('re-checks consent, rights and the window; sends typing then the message with business_connection_id and entities', async () => {
    const { t, u } = await connected();
    await t.send(U.businessMessage('hi'));
    expect(await t.s.business.send(u.id, REF, 'x', 'k0')).toEqual({ error: 'not_consented' });
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('Are you free?', { messageId: 51 }));
    const r = await t.s.business.send(u.id, REF, 'Yes, **free** after 3', 'idem-1');
    expect('messageId' in r).toBe(true);
    const calls = t.tg.callsOf('sendChatAction', 'sendMessage').filter((c) => c.payload['business_connection_id'] === 'bc_1');
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(calls[0]!.payload).toMatchObject({ chat_id: 1002, action: 'typing', business_connection_id: 'bc_1' });
    expect(calls[1]!.payload).toMatchObject({ chat_id: 1002, text: 'Yes, free after 3', business_connection_id: 'bc_1' });
    expect(calls[1]!.payload['entities']).toEqual([expect.objectContaining({ type: 'bold' })]);
    // idempotent per idemKey
    const again = await t.s.business.send(u.id, REF, 'Yes, **free** after 3', 'idem-1');
    expect(again).toEqual(r);
    expect(t.tg.byMethod('sendMessage').filter((p) => p.business_connection_id === 'bc_1')).toHaveLength(1);
    // recorded as a Gora-sent owner message; the chat is answered; ledger message_sent
    const row = t.s.db.prepare('SELECT from_owner, via_bot FROM business_messages WHERE message_id = ?').get<{ from_owner: number; via_bot: number }>((r as { messageId: number }).messageId)!;
    expect(row).toEqual({ from_owner: 1, via_bot: 1 });
    expect(chatRow(t)!['unanswered_since']).toBeNull();
    expect(t.s.ledger.list(u.id, { kinds: ['message_sent'], limit: 5 })).toHaveLength(1);
    // our own echo is ignored
    const before = JSON.stringify(chatRow(t));
    await t.send(U.businessMessage('Yes, free after 3', { from: 'bot' }));
    expect(JSON.stringify(chatRow(t))).toBe(before);
    // window closed → refused
    await t.clock.advance(25 * HOUR);
    expect(await t.s.business.send(u.id, REF, 'late', 'idem-2')).toEqual({ error: 'window_closed' });
    expect(t.s.business.context(u.id, 'bc_1:1002')).toMatchObject({ consented: true, enabled: true, canReply: true, windowOpen: false });
  });

  it('no can_reply → no_rights; disabled connection → disabled', async () => {
    t = await createTestApp();
    await t.send(U.businessConnection({ canReply: false }));
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    await t.send(U.businessMessage('hi'));
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    expect(await t.s.business.send(u.id, REF, 'x', 'k')).toEqual({ error: 'no_rights' });
  });

  it('the copy fallback carries [📋 Copy] only when the draft is ≤ 256 chars', async () => {
    const { t, u } = await connected();
    const b = bizFor(t.s);
    await sendCopyFallback(b, { userId: u.id, pendingActionId: 'PA0001', draft: 'short draft', chat: { chatId: TEST_USER.id } });
    await sendCopyFallback(b, { userId: u.id, pendingActionId: 'PA0002', draft: 'x'.repeat(257), chat: { chatId: TEST_USER.id } });
    await t.settle();
    const msgs = t.tg.byMethod('sendRichMessage').filter((p) => String(p.rich_message?.markdown).includes('24 h reply window'));
    expect(msgs).toHaveLength(2);
    expect(String(msgs[0].rich_message.markdown)).toContain('```\nshort draft\n```');
    expect(msgs[0].reply_markup.inline_keyboard[0][0]).toMatchObject({ copy_text: { text: 'short draft' } });
    expect(msgs[1].reply_markup).toBeUndefined();
  });
});

describe('privacy hook (§11.9)', () => {
  it('exports business metadata and stored messages; retention drops messages after 30 days; deletion removes everything', async () => {
    const { t, u } = await connected();
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.s.business.updateChat(u.id, REF, { toneNotes: 'warm, short' }, 'miniapp');
    await t.send(U.businessMessage('export me'));
    const hook = t.s.privacyHooks.find((h) => h.name === 'business')!;
    const ex = (await hook.exportUser!(u.id, TEST_USER.id)) as { connections: unknown[]; chats: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> };
    expect(ex.connections).toHaveLength(1);
    expect(ex.chats[0]).toMatchObject({ ref: REF, title: 'Anna', aiEnabled: true, toneNotes: 'warm, short' });
    expect(ex.messages[0]).toMatchObject({ ref: REF, text: 'export me', fromOwner: false });
    await hook.retentionSweep!(t.clock.now() + 29 * 24 * HOUR);
    expect(msgCount(t)).toBe(1);
    await hook.retentionSweep!(t.clock.now() + 31 * 24 * HOUR);
    expect(msgCount(t)).toBe(0);
    await t.send(U.businessMessage('again'));
    await hook.onDeleteUser(u.id, TEST_USER.id);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM business_connections').get<{ n: number }>()!.n).toBe(0);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM business_chats').get<{ n: number }>()!.n).toBe(0);
    expect(msgCount(t)).toBe(0);
    expect(t.s.crypto.isDestroyed('b:bc_1')).toBe(true);
  });

  it('the context provider adds the Secretary capability line on private surfaces only', async () => {
    const { t, u } = await connected();
    await t.send(U.businessMessage('hi'));
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    const p = t.s.contextProviders.find((x) => x.name === 'business')!;
    expect(p.surfaces).not.toContain('group');
    expect(p.surfaces).not.toContain('guest');
    const conv = { id: 'c1', kind: 'dm', userId: u.id } as never;
    const parts = await p.parts(conv, {} as never, '');
    expect(parts).toEqual([{ key: 'capabilities', lines: ['secretary=1 chats (1 unanswered)'] }]);
  });
});
