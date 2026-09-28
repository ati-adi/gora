// Review proof (surfaces/onboarding × business): originally `/start bizChat<id>` from a user who had not consented was
// kept and replayed after the M1 tap with update_id 0 / message_id 0, so only the FIRST user got the per-chat card.
// Friend mode (spec 05 A2/A3) removed the consent card: the payload is passed straight on to WP7b with the real update,
// so every new owner gets their own per-chat card (01 §10.2 step 8).
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { OTHER_USER, RU_USER, TEST_USER, U, type TestUser } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const cardsTo = (a: TestApp, chatId: number) =>
  a.tg.calls.filter((c) => c.method === 'sendRichMessage' && Number(c.payload.chat_id) === chatId && String(c.payload.rich_message?.markdown ?? '').includes('Secretary'));

async function newOwnerOpensChatSettings(a: TestApp, owner: TestUser, connId: string, peerChatId: number) {
  await a.send(U.businessConnection({ id: connId, user: owner }));
  await a.send(U.start(`bizChat${peerChatId}`, { user: owner })); // no consent gate any more: straight to WP7b
}

describe('bizChat payload on first contact', () => {
  it('every new owner gets their per-chat card', async () => {
    t = await createTestApp();
    await newOwnerOpensChatSettings(t, TEST_USER, 'bc_1', OTHER_USER.id);
    expect(cardsTo(t, TEST_USER.id)).toHaveLength(1); // the first user is fine

    await newOwnerOpensChatSettings(t, RU_USER, 'bc_2', 5555);
    expect(t.tg.byMethod('sendRichMessage').some((p) => Number(p.chat_id) === RU_USER.id)).toBe(true);
    expect(cardsTo(t, RU_USER.id).length + t.tg.calls.filter((c) => c.method === 'sendRichMessage' && Number(c.payload.chat_id) === RU_USER.id && String(c.payload.rich_message?.markdown ?? '').includes('Секретарь')).length).toBe(1);
  });
});
