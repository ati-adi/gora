// Review proof (surfaces/business, 01 F12 / §10.1 deleted_business_messages → "deletes commitments with those
// sources"): triage.ts:71 attributes a detected commitment to the LAST message of the owing side, not to the message
// that contains the promise. When the owner deletes the message with the promise, pipeline.ts onDeleted →
// commitments.deleteBySourceMessages(ids) misses it, and the LLM-derived text of the deleted message survives (and is
// later fed into DM context / follow-up nudges).
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER, U } from '../../harness/updates.ts';
import { commitmentSource } from '../../../src/surfaces/business/triage.ts';
import type { MsgRow } from '../../../src/surfaces/business/repo.ts';

const REF = 'bc:bc_1:1002';
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('deleted_business_messages purges commitments derived from them', () => {
  it('deleting the message that holds the promise deletes the commitment', async () => {
    t = await createTestApp();
    await t.send(U.businessConnection());
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    t.s.repos.users.update(u.id, { onboardingStep: 'done', memoryConsent: true });
    await t.send(U.businessMessage('hello', { messageId: 100 }));
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');

    await t.send(U.businessMessage('Can you send the signed contract?', { messageId: 101 }));
    await t.send(U.businessMessage('I will send you the signed contract on Friday', { messageId: 102, from: 'owner' })); // the promise
    await t.send(U.businessMessage('ok talk later', { messageId: 103, from: 'owner' }));
    t.llm.pushParse('triage', { needs_reply: false, urgency: 0, summary: 'Owner promised the contract', category: 'other', commitment: { direction: 'i_owe', text: 'Send the signed contract on Friday', due_local: null } });
    await t.advance(46_000);
    const count = () => Number(t!.s.db.prepare("SELECT COUNT(*) AS n FROM commitments WHERE business_connection_id = 'bc_1' AND chat_id = 1002").get<{ n: number }>()!.n);
    expect(count()).toBe(1);

    await t.send(U.deletedBusinessMessages([102])); // the owner deletes the promise
    const stored = t.s.db.prepare("SELECT message_id FROM business_messages WHERE connection_id = 'bc_1' AND chat_id = 1002").all<{ message_id: number }>().map((r) => Number(r.message_id));
    expect(stored).not.toContain(102); // the stored copy is purged…
    expect(count()).toBe(0); // the commitment is attributed to #102 (the promise), so it goes with it
  });
});

describe('commitmentSource', () => {
  const m = (messageId: number, fromOwner: boolean, text: string): MsgRow => ({ connectionId: 'c', chatId: 1, messageId, fromOwner, viaBot: false, date: messageId, text, mediaKind: null, editedAt: null });
  const msgs = [m(1, false, 'Could you send the invoice?'), m(2, true, 'Sure, I will send the invoice tomorrow'), m(3, true, 'bye'), m(4, false, 'I will pay by Monday')];
  it('picks the owing side message that carries the promise', () => {
    expect(commitmentSource(msgs, true, 'Send the invoice tomorrow').messageId).toBe(2);
    expect(commitmentSource(msgs, false, 'Pay by Monday').messageId).toBe(4);
  });
  it("falls back to the owing side's last message when nothing overlaps", () => {
    expect(commitmentSource(msgs, true, 'xyz').messageId).toBe(3);
  });
});
