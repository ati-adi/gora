// Review (platform): the Mini App "Change time" action on a reminder can never succeed.
// webapp/src/screens/Tasks.tsx saveTime() sends `atLocal: '<YYYY-MM-DDTHH:mm>:00'` (it appends seconds to the 16-char
// <input type="datetime-local"> value). src/http/routes/tasks.ts accepts the seconds in its zod regex and forwards the
// string unchanged to reminders.manage(…'reschedule', {atLocal}), whose parseLocal() only accepts 'YYYY-MM-DDTHH:mm' →
// ReminderError('bad_time'). isNotFoundish() does not match it, so guarded() rethrows and the user gets HTTP 500
// ("internal") — every time, for every reminder. Invalid input (a past time, a bad cron) also surfaces as 500, not 4xx.
// FIXED: the route drops seconds, Tasks.tsx sends the 16-char value, and coded ReminderErrors map to 422/409/429.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('PATCH /api/reminders/:id from the Mini App', () => {
  it('reschedules with the exact payload the Tasks screen sends', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    const scope = { kind: 'user' as const, userId: u.id };
    const r = t.s.reminders.create({ scope, userId: u.id, kind: 'reminder', text: 'Pay rent', atLocal: '2026-09-30T10:00', tz: u.tz, chatId: u.dmChatId ?? u.tgUserId });

    // Tasks.tsx: editing.at = '2026-10-01T09:30' (datetime-local) → atLocal: `${editing.at}:00`
    const res = await t.api('PATCH', `/api/reminders/${r.id}`, { atLocal: '2026-10-01T09:30:00' });
    expect(res.status).toBe(200);
    expect(t.s.reminders.list(scope, false).find((x) => x.id === r.id)?.display).toContain('1 Oct, 09:30');
  });

  it('a past time is a client error (4xx), not an internal server error', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    const scope = { kind: 'user' as const, userId: u.id };
    const r = t.s.reminders.create({ scope, userId: u.id, kind: 'reminder', text: 'Pay rent', atLocal: '2026-09-30T10:00', tz: u.tz, chatId: u.dmChatId ?? u.tgUserId });
    const res = await t.api('PATCH', `/api/reminders/${r.id}`, { atLocal: '2020-01-01T09:30' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'past' });
  });
});
