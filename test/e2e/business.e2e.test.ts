// WP7b e2e (01 §15.2): Secretary Mode through the whole app (FakeTelegram + ScriptedTransport, every other module real).
//  - no LLM request ever contains text from a non-consented chat;
//  - consent → triage → draft card → approve → sendMessage with business_connection_id;
//  - window closed → Sentinel denies, and the copy fallback (copy_text only when ≤ 256 chars);
//  - deleted_business_messages purges, voids and shreds;
//  - sender_business_bot messages are ignored.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/contracts/index.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { TEST_USER, U } from '../harness/updates.ts';

const REF = 'bc:bc_1:1002';
const HOUR = 3600_000;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const everyLlmPayload = (a: TestApp) => JSON.stringify([a.llm.requests, a.llm.parseRequests, a.llm.createRequests]);
const bizSends = (a: TestApp) => a.tg.callsOf('sendChatAction', 'sendMessage', 'sendRichMessage').filter((c) => c.payload['business_connection_id'] === 'bc_1');

async function consentedWorld(mode: 'triage' | 'draft' = 'draft'): Promise<{ t: TestApp; u: UserRow }> {
  t = await createTestApp();
  await t.send(U.businessConnection());
  const u = t.s.repos.users.getByTg(TEST_USER.id)!;
  t.s.repos.users.update(u.id, { onboardingStep: 'done', memoryConsent: true });
  await t.send(U.businessMessage('hello', { messageId: 100 })); // metadata only (before consent)
  await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
  await t.s.business.updateChat(u.id, REF, { mode }, 'miniapp');
  return { t, u };
}

/** A peer message → 45 s → triage (urgency 3) → single-shot drafting → the approval card in 📥 Inbox. Returns the card. */
async function draftCard(a: TestApp, draft: string, o: { messageId?: number; text?: string } = {}) {
  await a.send(U.businessMessage(o.text ?? 'Can you send me the contract today? It is urgent', { messageId: o.messageId ?? 101 }));
  a.llm.pushParse('triage', { needs_reply: true, urgency: 3, summary: 'Asks for the contract today', category: 'request', commitment: null });
  a.llm.push(turn().toolUse('business_draft_reply', { chat_ref: REF, text: draft }, `toolu_${o.messageId ?? 101}`));
  a.llm.push(say(''));
  await a.advance(46_000);
  const card = a.lastCard();
  expect(card.markdown).toContain('Approve: Reply to Anna');
  const approve = card.buttons.find((b) => b.callback_data?.startsWith('a1:') && b.callback_data.includes(':y:'))!;
  const id = approve.callback_data!.split(':')[1]!;
  return { card, approve: approve.callback_data!, id };
}

describe('Secretary Mode e2e (F12, §10.2)', () => {
  it('no LLM request ever contains text from a non-consented chat', async () => {
    const { t, u } = await consentedWorld('draft');
    // a second, NOT consented chat: peer and owner messages, edits
    await t.send(U.businessMessage('SECRET-NONCONSENT-peer-1 my card number is 4111', { chatId: 2000, messageId: 1 }));
    await t.send(U.businessMessage('SECRET-NONCONSENT-owner-2 call me later', { chatId: 2000, messageId: 2, from: 'owner' }));
    await t.send(U.editedBusinessMessage('SECRET-NONCONSENT-edit-3', 1, { chatId: 2000 }));
    // owner style samples are taken from consented chats only
    await t.send(U.businessMessage('consented owner sample', { messageId: 99, from: 'owner' }));
    await draftCard(t, 'Sure, sending it within the hour.');
    await t.advance(10 * 60_000);
    expect(t.llm.parseRequests.length).toBeGreaterThan(0);
    expect(t.llm.requests.length).toBeGreaterThan(0);
    const all = everyLlmPayload(t);
    expect(all).toContain('Can you send me the contract today');
    expect(all).toContain('consented owner sample');
    expect(all).not.toContain('SECRET-NONCONSENT');
    expect(all).not.toContain('4111');
    // and nothing of it was ever stored
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM business_messages WHERE chat_id = 2000').get<{ n: number }>()!.n).toBe(0);
    const ex = JSON.stringify(await t.s.privacyHooks.find((h) => h.name === 'business')!.exportUser!(u.id, TEST_USER.id));
    expect(ex).not.toContain('SECRET-NONCONSENT');
  });

  it('consent → triage → draft card in 📥 Inbox → approve → typing + sendMessage with business_connection_id', async () => {
    const { t, u } = await consentedWorld('draft');
    const { card, approve, id } = await draftCard(t, 'Sure, sending it within the hour.');
    expect(card.markdown).toContain('Their last message');
    expect(card.markdown).toContain('Sure, sending it within the hour.');
    expect(card.markdown).toContain('<tg-time'); // expiry countdown = the window end
    const cardMsg = t.tg.byMethod('sendRichMessage').find((p) => String(p.rich_message?.markdown).includes('Approve: Reply to Anna'))!;
    expect(cardMsg.message_thread_id).toBeTruthy();
    expect(card.buttons.some((b) => String(b.callback_data).includes(':d:'))).toBe(false); // never grantable
    const pending = t.s.approvals.get(id, u.id)!;
    expect(pending.status).toBe('pending');
    expect(pending.expiresAt).toBe(t.s.business.context(u.id, REF)!.windowExpiresAt);
    expect(bizSends(t)).toHaveLength(0); // nothing sent without the tap
    // the drafting conversation is single-shot and closed after its run
    const conv = t.s.db.prepare(`SELECT status FROM conversations WHERE kind = 'biz_draft'`).get<{ status: string }>();
    expect(conv?.status).toBe('closed');

    await t.tap(approve, { messageId: card.messageId });
    await t.settle();
    const sends = bizSends(t);
    expect(sends.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(sends[0]!.payload).toMatchObject({ chat_id: 1002, action: 'typing', business_connection_id: 'bc_1' });
    expect(sends[1]!.payload).toMatchObject({ chat_id: 1002, text: 'Sure, sending it within the hour.', business_connection_id: 'bc_1' });
    expect(t.s.approvals.get(id, u.id)!.status).toBe('executed');
    expect(t.s.ledger.list(u.id, { kinds: ['message_sent'], limit: 5 })).toHaveLength(1);
    expect(t.s.business.listChats(u.id, 'unanswered', 5)).toEqual([]);
    // a second tap does not send twice
    await t.tap(approve, { messageId: card.messageId });
    await t.settle();
    expect(bizSends(t).filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    t.llm.assertInvariants();
  });

  it('sender_business_bot messages (our own sends) are ignored: no triage, no LLM call, the chat stays answered', async () => {
    const { t, u } = await consentedWorld('draft');
    const { approve, card } = await draftCard(t, 'On it.');
    await t.tap(approve, { messageId: card.messageId });
    await t.settle();
    const parses = t.llm.parseRequests.length;
    const stored = t.s.db.prepare('SELECT COUNT(*) AS n FROM business_messages').get<{ n: number }>()!.n;
    await t.send(U.businessMessage('On it.', { from: 'bot', messageId: 555 }));
    await t.advance(60_000);
    expect(t.llm.parseRequests.length).toBe(parses);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM business_messages').get<{ n: number }>()!.n).toBe(stored);
    expect(t.s.business.listChats(u.id, 'unanswered', 5)).toEqual([]);
  });

  it('window closed: Sentinel denies the approve, and the owner gets the draft to copy ([📋 Copy] only when ≤ 256 chars)', { timeout: 60_000 }, async () => { // s07 gate: advances days; 12–13 s alone, slower under load
    const { t, u } = await consentedWorld('draft');
    const short = await draftCard(t, 'Short reply.');
    // the window ends; the owner taps Approve before any job ran
    await t.clock.advance(24 * HOUR + 1_000);
    await t.tap(short.approve, { messageId: short.card.messageId });
    await t.settle();
    expect(bizSends(t)).toHaveLength(0);
    expect(t.s.approvals.get(short.id, u.id)!.status).not.toBe('executed');
    expect(t.s.sentinel.decisionsFor(t.s.approvals.get(short.id, u.id)!.runId!).length).toBeGreaterThan(0);
    await t.advance(1_000); // business_window (and approval_expire) run
    // 01 §10.2 step 6: the card itself is edited into "⌛ window closed" + the draft (integration: PendingActionView.card)
    const fallback = t.tg.byMethod('editMessageText').filter((p) => String(p.rich_message?.markdown).includes('24 h reply window'));
    expect(fallback).toHaveLength(1);
    expect(fallback[0].message_id).toBe(short.card.messageId);
    expect(String(fallback[0].rich_message.markdown)).toContain('Short reply.');
    expect(fallback[0].reply_markup.inline_keyboard[0][0]).toMatchObject({ copy_text: { text: 'Short reply.' } });

    // a long draft: the window job closes the still-pending card; no copy button (> 256 chars)
    const long = 'L'.repeat(300);
    await t.send(U.businessMessage('new question, reopens the window', { messageId: 300 }));
    t.llm.pushParse('triage', { needs_reply: true, urgency: 3, summary: 'x', category: 'question', commitment: null });
    t.llm.push(turn().toolUse('business_draft_reply', { chat_ref: REF, text: long }, 'toolu_300'));
    t.llm.push(say(''));
    await t.advance(46_000);
    const card2 = t.lastCard();
    const id2 = card2.buttons.find((b) => b.callback_data?.startsWith('a1:'))!.callback_data!.split(':')[1]!;
    expect(t.s.approvals.get(id2, u.id)!.status).toBe('pending');
    await t.advance(24 * HOUR);
    expect(t.s.approvals.get(id2, u.id)!.status).not.toBe('pending');
    const fb2 = t.tg.byMethod('editMessageText').filter((p) => String(p.rich_message?.markdown).includes('24 h reply window') && String(p.rich_message.markdown).includes(long));
    expect(fb2).toHaveLength(1);
    expect(fb2[0].message_id).toBe(card2.messageId);
    expect(fb2[0].reply_markup?.inline_keyboard ?? []).toEqual([]);
    // the card can no longer be approved
    await t.tap(card2.buttons.find((b) => b.callback_data?.includes(':y:'))!.callback_data!, { messageId: card2.messageId });
    await t.settle();
    expect(bizSends(t)).toHaveLength(0);
  });

  it('deleted_business_messages purges the stored copies, voids the card quoting them and shreds the drafting conversation', async () => {
    const { t, u } = await consentedWorld('draft');
    const { id, approve, card } = await draftCard(t, 'Here it is.', { messageId: 101 });
    const conv = t.s.db.prepare(`SELECT id FROM conversations WHERE kind = 'biz_draft'`).get<{ id: string }>()!;
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get<{ n: number }>(conv.id)!.n).toBeGreaterThan(0);
    await t.send(U.deletedBusinessMessages([101]));
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM business_messages WHERE message_id = 101').get<{ n: number }>()!.n).toBe(0);
    expect(t.s.approvals.get(id, u.id)!.status).toBe('voided');
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get<{ n: number }>(conv.id)!.n).toBe(0);
    expect(t.s.db.prepare('SELECT COUNT(*) AS n FROM business_drafts').get<{ n: number }>()!.n).toBe(0);
    // the voided card can't send anything
    await t.tap(approve, { messageId: card.messageId });
    await t.settle();
    expect(bizSends(t)).toHaveLength(0);
    expect(t.s.ledger.list(u.id, { kinds: ['business_event'], limit: 20 }).some((e) => e.summary.includes('purged'))).toBe(true);
  });
});
