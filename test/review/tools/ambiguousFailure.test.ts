// REVIEW (tools): calendar_*/gmail_* wrap every provider error in withApi()/withMail() and RETURN is_error instead of
// throwing. The executor only calls spec.reconcile() when execute() THROWS (trust/executor.ts:412-420), so an
// ambiguous failure (Composio/HTTP timeout after Google already created the event and emailed the invites) is recorded
// as a definite "Failed", the card says Failed, and a retry proposes a NEW approval with a new idemKey (pa:<newId>),
// which findByIdem cannot match -> duplicate event and a second round of invitation emails to every attendee.
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarApi, ReplyChannel, UserId, UserRow } from '../../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../../src/integrations/fake.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

class FlakyCalendar extends FakeIntegrationProvider {
  override calendar(userId: UserId, ref: string): CalendarApi {
    const api = super.calendar(userId, ref);
    return {
      ...api,
      async create(e, idemKey) {
        await api.create(e, idemKey); // Google did it...
        throw new Error('composio /api/v3.1/tools/execute HTTP 504'); // ...but the response was lost
      },
    };
  }
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function addUser(app: TestApp): UserRow {
  const u = app.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
  app.s.repos.users.grantConsent({ userId: u.id, kind: 'terms', textVersion: 'v1', via: 'command' });
  return app.s.repos.users.getById(u.id)!;
}

describe('ambiguous provider failures', () => {
  it('an approved calendar_create_event whose response is lost is not reported as a definite failure', async () => {
    const provider = new FlakyCalendar({ now: () => Date.UTC(2026, 8, 28, 9, 0) });
    t = await createTestApp({ integrations: provider, now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = addUser(t);
    const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
    await t.s.integrations.devConnect(new URL(url).searchParams.get('state')!);
    t.s.repos.users.setPermission(u.id, 'gcal', 'act', 'callback');
    await t.settle();

    const conv = t.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: 1001 });
    const run = t.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1001, triggerMessageId: 3 }, maxTokens: 1000 });
    const input = { title: 'Contract review', start_local: '2026-10-01T15:00', attendees: ['anna@example.com'] };
    const out = await t.s.executor.processRound(run, conv, 1, [{ type: 'tool_use', id: 'toolu_c1', name: 'calendar_create_event', input }], null as unknown as ReplyChannel, new AbortController().signal);
    const approvalId = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    expect(approvalId).toBeTruthy();

    const res = await t.s.executor.executeApproved((await (async () => {
      // move pending -> approved the way a tap does
      await t!.settle();
      const card = t!.lastCard();
      const yes = card.buttons.find((b) => b.callback_data?.startsWith(`a1:${approvalId}:y`))!;
      await t!.tap(yes.callback_data!, { messageId: card.messageId });
      return approvalId;
    })()));

    const created = provider.events(u.id).filter((e) => e.title === 'Contract review');
    expect(created).toHaveLength(1); // the event and its invites exist
    // The executor must not claim a definite failure (reconcile via findByIdem would have said 'done').
    expect(res.status).not.toBe('failed');
    expect(t.s.approvals.get(approvalId, u.id)?.status).not.toBe('failed');
  });
});
