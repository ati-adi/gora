// Review proof (surfaces/business privacy): drafting for chat B embeds the owner's messages from OTHER consented chats as
// style samples (drafting.ts:32-36, 01 §10.2 step 4), but business_drafts records only chat B's transcript ids
// (drafting.ts:63). So when the owner deletes that sample message in chat A (deleted_business_messages) — or revokes
// AI for chat A — chat B's drafting conversation, which holds chat A's text, is neither found nor shredded
// (pipeline.ts:105 draftsWithMessages(conn, chatA, ids); consent.ts:54 draftsOfChat(conn, chatA)).
// 01 F12: "On deleted_business_messages, Gora purges its stored copies … and shreds the drafting conversations that
// included them."
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { say, turn } from '../../harness/scriptedTransport.ts';
import { TEST_USER, U } from '../../harness/updates.ts';

const A = 'bc:bc_1:1002';
const B = 'bc:bc_1:2000';
const SECRET = 'SAMPLE-SECRET-A the new office door code is 4417';
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function draftTexts(a: TestApp): string {
  const out: string[] = [];
  for (const r of a.s.db.prepare("SELECT id, epoch, status FROM conversations WHERE kind = 'biz_draft'").all<{ id: string; epoch: number; status: string }>()) {
    for (let e = 1; e <= Number(r.epoch); e++) {
      try {
        out.push(JSON.stringify(a.s.repos.messages.load(r.id, e)));
      } catch {
        /* shredded */
      }
    }
  }
  return out.join('\n');
}

describe('style samples from chat A inside chat B drafts', () => {
  it('deleting the sample message in chat A shreds every drafting conversation that included it', async () => {
    t = await createTestApp();
    await t.send(U.businessConnection());
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    t.s.repos.users.update(u.id, { onboardingStep: 'done', memoryConsent: true });
    await t.send(U.businessMessage('hi', { messageId: 10 }));
    await t.send(U.businessMessage('hey', { chatId: 2000, messageId: 20 }));
    await t.s.business.setChatAi(u.id, A, true, 'miniapp');
    await t.s.business.setChatAi(u.id, B, true, 'miniapp');
    await t.s.business.updateChat(u.id, B, { mode: 'draft' }, 'miniapp');

    await t.send(U.businessMessage(SECRET, { messageId: 50, from: 'owner' })); // owner's own message in chat A
    t.llm.pushParse('triage', { needs_reply: false, urgency: 0, summary: 'owner note', category: 'other', commitment: null });
    await t.advance(46_000);

    await t.send(U.businessMessage('Can you call me back today? urgent', { chatId: 2000, messageId: 21 }));
    t.llm.pushParse('triage', { needs_reply: true, urgency: 3, summary: 'call back', category: 'request', commitment: null });
    t.llm.push(turn().toolUse('business_draft_reply', { chat_ref: B, text: 'Sure, calling in 10 min.' }, 'toolu_b1'));
    t.llm.push(say(''));
    await t.advance(46_000);
    expect(draftTexts(t)).toContain('SAMPLE-SECRET-A'); // chat A's text is inside chat B's drafting conversation

    await t.send(U.deletedBusinessMessages([50])); // the owner deletes it in chat A
    expect(t.s.db.prepare("SELECT COUNT(*) AS n FROM business_messages WHERE message_id = 50").get<{ n: number }>()!.n).toBe(0); // stored copy purged
    expect(draftTexts(t)).not.toContain('SAMPLE-SECRET-A'); // chat B's drafting conversation is shredded too
  });

  it("revoking AI for chat A shreds chat B's drafting conversation that embedded A's samples", async () => {
    t = await createTestApp();
    await t.send(U.businessConnection());
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    t.s.repos.users.update(u.id, { onboardingStep: 'done', memoryConsent: true });
    await t.send(U.businessMessage('hi', { messageId: 10 }));
    await t.send(U.businessMessage('hey', { chatId: 2000, messageId: 20 }));
    await t.s.business.setChatAi(u.id, A, true, 'miniapp');
    await t.s.business.setChatAi(u.id, B, true, 'miniapp');
    await t.s.business.updateChat(u.id, B, { mode: 'draft' }, 'miniapp');
    await t.send(U.businessMessage(SECRET, { messageId: 50, from: 'owner' }));
    t.llm.pushParse('triage', { needs_reply: false, urgency: 0, summary: 'owner note', category: 'other', commitment: null });
    await t.advance(46_000);
    await t.send(U.businessMessage('Can you call me back today? urgent', { chatId: 2000, messageId: 21 }));
    t.llm.pushParse('triage', { needs_reply: true, urgency: 3, summary: 'call back', category: 'request', commitment: null });
    t.llm.push(turn().toolUse('business_draft_reply', { chat_ref: B, text: 'Sure, calling in 10 min.' }, 'toolu_b1'));
    t.llm.push(say(''));
    await t.advance(46_000);
    expect(draftTexts(t)).toContain('SAMPLE-SECRET-A');

    await t.s.business.setChatAi(u.id, A, false, 'miniapp');
    expect(draftTexts(t)).not.toContain('SAMPLE-SECRET-A');
  });
});
