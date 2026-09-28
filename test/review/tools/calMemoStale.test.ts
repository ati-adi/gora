// REVIEW (tools): calendar_update_event.classify() decides write_self (auto-run, Undo) vs send_external (approval card)
// from a per-process memo (calMemo.ts) that never expires and is never refreshed before execution. execute() also takes
// `prev` from the same memo. If guests were added to the event after it was listed (e.g. in the Google UI, hours or days
// earlier — the memo has no TTL), moving it is auto-executed with no card although it now changes other people's
// calendars. The memo is also never cleared on gcal revoke or /deletemydata (clearEventMemo has no caller in src).
import { describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../../src/contracts/index.ts';
import { knownEvent } from '../../../src/tools/impl/calMemo.ts';
import { CALENDAR_TOOLS } from '../../../src/tools/impl/calendar.ts';
import { createToolEnv } from '../../unit/tools/env.ts';

const T = (n: string) => CALENDAR_TOOLS.find((t) => t.name === n) as ToolSpec;

describe('calendar classification from a stale memo', () => {
  it('an event that gained attendees after it was listed is not classified write_self', async () => {
    const env = createToolEnv();
    await env.run(T('calendar_list_events'), { from_local: '2026-09-28T00:00', to_local: '2026-10-05T00:00' });
    // Two days later the owner invites a colleague to "Dentist" from the Google Calendar UI.
    await env.clock.advance(2 * 86_400_000);
    await env.provider.calendar(env.user.id, 'ref').update('demo-e2', { attendees: ['colleague@example.com'] });
    const u = T('calendar_update_event');
    const input = u.input.parse({ event_id: 'demo-e2', patch: { start_local: '2026-10-01T16:00' } });
    const cls = u.classify(input, env.ctx());
    expect(cls.actionClass, 'moving an event with guests must ask').toBe('send_external');
  });

  it('guests added a minute after listing: the auto-run edit is refused at execution and the next classify asks', async () => {
    const env = createToolEnv();
    await env.run(T('calendar_list_events'), { from_local: '2026-09-28T00:00', to_local: '2026-10-05T00:00' });
    await env.clock.advance(60_000);
    await env.provider.calendar(env.user.id, 'ref').update('demo-e2', { attendees: ['colleague@example.com'] });
    const u = T('calendar_update_event');
    const input = u.input.parse({ event_id: 'demo-e2', patch: { start_local: '2026-10-01T16:00' } });
    expect(u.classify(input, env.ctx()).actionClass).toBe('write_self'); // the memo is still fresh
    const out = await u.execute(input, env.ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain('NEEDS_APPROVAL');
    const ev = (await env.provider.calendar(env.user.id, 'ref').list({ fromIso: '2026-09-01T00:00:00Z', toIso: '2026-11-01T00:00:00Z', max: 50 })).find((e) => e.id === 'demo-e2');
    expect(ev?.start).not.toContain('16:00'); // not moved
    expect(u.classify(input, env.ctx()).actionClass).toBe('send_external');
    // An approved execution (idemKey pa:…) of the same change goes through.
    const approved = await u.execute(input, env.ctx({ idemKey: 'pa:ok1' }));
    expect(approved.isError).toBeFalsy();
  });

  it('the memo is cleared when Google Calendar is disconnected', async () => {
    const { createTestApp } = await import('../../harness/testApp.ts');
    const { FakeIntegrationProvider } = await import('../../../src/integrations/fake.ts');
    const { rememberEvents } = await import('../../../src/tools/impl/calMemo.ts');
    const provider = new FakeIntegrationProvider({ now: () => Date.UTC(2026, 8, 28, 9, 0) });
    const t = await createTestApp({ integrations: provider, now: Date.UTC(2026, 8, 28, 9, 0) });
    try {
      const u = t.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'A', language_code: 'en' }, { dmChatId: 1001 });
      const { url } = await t.s.integrations.startConnect(u.id, 'gcal', { chatId: 1001 });
      await t.s.integrations.devConnect(new URL(url).searchParams.get('state')!);
      const now = t.s.clock.now();
      rememberEvents(u.id, [{ id: 'e1', title: 'Dentist', start: '2026-10-01T10:00:00+05:00', end: '2026-10-01T11:00:00+05:00', tz: 'Asia/Almaty', attendees: [], organizerSelf: true }], now);
      expect(knownEvent(u.id, 'e1', now)).toBeDefined();
      await t.s.integrations.revoke(u.id, 'gcal');
      expect(knownEvent(u.id, 'e1', now)).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});
