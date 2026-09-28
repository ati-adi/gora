// RED TEAM (friend mode, spec 05 B1: sensitive facts are "never used in proactive messages"). The morning scan's
// date_from_memory candidates (src/proactive/signals.ts "dates from memory") read every active 'date' fact and put its
// text into the nudge's details line — without looking at f.sensitivity. B's policy.prefetch filters
// `f.sensitivity !== 'normal'`, the nudge path does not. date_from_memory is an UNREQUESTED Gora-first kind.
import { afterEach, describe, expect, it } from 'vitest';
import { addUser, advanceTicks, createFriendApp, localAt, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';
const sentText = (t: FriendApp) =>
  t.tg.calls
    .filter((c) => (c.method === 'sendRichMessage' || c.method === 'sendMessage') && !c.error)
    .map((c) => String(c.payload.rich_message?.markdown ?? c.payload.text ?? '').replace(/\\/g, ''))
    .join('\n');

describe('date_from_memory nudge and sensitive facts', () => {
  it('control: a normal date fact for tomorrow produces a Gora-first nudge at the 09:30 scan', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const r = await t.s.memory.save({ kind: 'user', userId: u.id }, {
      text: 'Anna birthday on Oct 6', kind: 'date', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' },
    });
    expect('id' in r).toBe(true);
    await advanceTicks(t, localAt(t, TZ, 0, 10, 5) - t.clock.now());
    expect(sentText(t)).toContain('Anna birthday on Oct 6');
  }, 60_000);

  it('a SENSITIVE date fact (health) must never be written first to the owner', async () => {
    t = await createFriendApp();
    const u = addUser(t, { tz: TZ });
    const r = await t.s.memory.save({ kind: 'user', userId: u.id }, {
      text: 'Chemotherapy session on Oct 6', kind: 'date', sensitivity: 'sensitive', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' },
    });
    expect('id' in r).toBe(true);
    await advanceTicks(t, localAt(t, TZ, 0, 10, 5) - t.clock.now());
    expect(sentText(t)).not.toContain('Chemotherapy'); // FAILS: "💡 A date to remember is tomorrow / Tomorrow: Chemotherapy session on Oct 6"
  }, 60_000);
});
