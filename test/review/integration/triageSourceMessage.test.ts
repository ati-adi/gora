// INTEGRATION (F5): triage returns commitment.source_message_id (the transcript '#id' of the promise); business triage
// prefers it over the word-overlap heuristic when it names a message of the owing side, so deleting that message deletes
// the commitment even when the commitment text shares no words with it.
import { afterEach, describe, expect, it } from 'vitest';
import { TriageSchema } from '../../../src/agent/side.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER, U } from '../../harness/updates.ts';

const REF = 'bc:bc_1:1002';
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('triage source_message_id (F5)', () => {
  it('the schema accepts it (nullable, optional for older outputs)', () => {
    const base = { needs_reply: false, urgency: 0, summary: 's', category: 'other' as const };
    expect(TriageSchema.parse({ ...base, commitment: { direction: 'i_owe', text: 'x', due_local: null, source_message_id: 102 } }).commitment?.source_message_id).toBe(102);
    expect(TriageSchema.parse({ ...base, commitment: { direction: 'i_owe', text: 'x', due_local: null } }).commitment).toBeTruthy();
  });

  it('a cited owner message wins over the heuristic; deleting it deletes the commitment', async () => {
    t = await createTestApp();
    await t.send(U.businessConnection());
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    t.s.repos.users.update(u.id, { onboardingStep: 'done', memoryConsent: true });
    await t.send(U.businessMessage('hello', { messageId: 100 }));
    await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
    await t.send(U.businessMessage('Can you get it to me?', { messageId: 101 }));
    await t.send(U.businessMessage('Sure, Friday', { messageId: 102, from: 'owner' })); // the promise (no overlap with the text)
    await t.send(U.businessMessage('ok talk later', { messageId: 103, from: 'owner' }));
    t.llm.pushParse('triage', { needs_reply: false, urgency: 0, summary: 'Owner promised the contract', category: 'other', commitment: { direction: 'i_owe', text: 'Deliver signed contract', due_local: null, source_message_id: 102 } });
    await t.advance(46_000);
    const count = () => Number(t!.s.db.prepare("SELECT COUNT(*) AS n FROM commitments WHERE business_connection_id = 'bc_1' AND chat_id = 1002").get<{ n: number }>()!.n);
    expect(count()).toBe(1);
    await t.send(U.deletedBusinessMessages([102]));
    expect(count()).toBe(0);
  });
});
