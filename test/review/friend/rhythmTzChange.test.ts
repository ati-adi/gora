// Skeptic proof (spec 05 C2 "a per-user 7×24 activity histogram of inbound messages in the user's LOCAL time" + A6
// lazy time zone): signals.inbound bins each message by the zone users.tz holds at that moment and the stored
// histogram is never re-binned. With A6 most users start on a guessed zone (UTC for 'en', Moscow for 'ru') and only
// later confirm the real one (location share, "I live in X", Mini App), after which weeks of history (21-day half-life)
// are read in the new zone: the learned peak moves by the zone difference and Gora writes first at the wrong hours.
import { afterEach, describe, expect, it } from 'vitest';
import { addUser, createFriendApp, DAY, HOUR, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('skeptic: rhythm histogram vs a time zone change', () => {
  it('after the owner confirms their real zone, P(active) still peaks at the old-zone wall hour', async () => {
    t = await createFriendApp();
    const u = addUser(t, { lang: 'en' });
    // A6: a new English-speaking user runs on the language default (UTC) until they confirm
    t.s.repos.users.update(u.id, { tz: 'UTC', tzSource: 'default' });
    const day0 = Date.UTC(2026, 8, 21); // three weeks of history before the FakeClock's "now" (5 Oct 2026)
    // the owner (really in Almaty, UTC+5) writes every day at 14:00 Almaty = 09:00 UTC
    for (let d = 0; d < 14; d++) t.s.signals.inbound(u.id, { at: day0 + d * DAY + 9 * HOUR, text: 'hey, what do you think?' });
    // they share a location / say "I live in Almaty": the zone is confirmed
    t.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'location' });
    const today = Date.UTC(2026, 9, 5);
    const realPeak = today + 9 * HOUR; // 14:00 Almaty — when they actually write
    const ghostPeak = today + 4 * HOUR; // 09:00 Almaty — 04:00 UTC, when they never wrote
    const pReal = t.s.signals.pActive(u.id, realPeak);
    const pGhost = t.s.signals.pActive(u.id, ghostPeak);
    expect(pReal).toBeGreaterThan(pGhost);
  });
});
