// RED TEAM (friend mode, spec 05 B4 + 01 §9 forget). A Gora-first message is written FROM memory ("How did the Kaspi
// interview go?"). Its text is stored in proactive_log.judge_reason_enc, sealed under the per-user DEK 'u:<userId>'
// (not the memory generation), so "forget the Kaspi interview" neither shreds nor scrubs it: the text stays for 90 days,
// is in the data export, and is re-sent to the LLM as one of the "recent_messages_sent_first" of every later friend
// check (policy.ts sendJob → repo.recentSent(u.id, 5) → judgeUser).
import { afterEach, describe, expect, it } from 'vitest';
import { createBehaviourRepo } from '../../../src/behaviour/repo.ts';
import { addUser, advanceTicks, createFriendApp, DAY, HOUR, scriptSends, seedHistory, type FriendApp } from '../../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const TZ = 'Asia/Almaty';

describe('forget vs proactive_log', () => {
  it('after "forget the Kaspi interview" the fact text never reaches an LLM again (friend check included)', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const u = addUser(t, { tz: TZ });
    seedHistory(t, u, { days: 14, hour: 20 });
    const sc = { kind: 'user' as const, userId: u.id };
    const r = await t.s.memory.save(sc, { text: 'Has a job interview at Kaspi on Oct 2', kind: 'date', sensitivity: 'normal', explicit: true, authorUserId: u.id, source: { kind: 'tool_explicit' } });
    if (!('id' in r)) throw new Error('save denied');
    // three days ago Gora wrote first about it and the owner answered
    const repo = createBehaviourRepo(() => t!.s.db, () => t!.s.crypto);
    const sentAt = t.clock.now() - 3 * DAY;
    repo.insertLog({ id: 'pl_old', userId: u.id, arm: 'follow_up|1-2d', contentType: 'follow_up', gapBucket: '1-2d', score: 0.5, sent: true, reason: 'ok', text: 'Hey, how did the Kaspi interview go?', now: sentAt });
    t.s.signals.goraSent(u.id, { at: sentAt, source: 'proactive', refId: 'pl_old' });
    t.s.signals.inbound(u.id, { at: sentAt + HOUR, text: 'went well!' });
    // the owner: "forget the Kaspi interview"
    const gone = await t.s.memory.forget(sc, { ids: [r.id] }, { tgUserId: u.tgUserId });
    expect(JSON.stringify(gone)).toContain(r.id);
    // the export after the forget
    const hook = t.s.privacyHooks.find((h) => h.name === 'behaviour')!;
    const ex = JSON.stringify(await hook.exportUser!(u.id, u.tgUserId));
    // the next Gora-first message goes through compose + friend check
    scriptSends(t, 4);
    let guard = 0;
    while (!t.llm.parseRequests.some((x) => x.purpose === 'judge') && guard++ < 6 * 48) await advanceTicks(t, 30 * 60_000);
    const judge = t.llm.parseRequests.find((x) => x.purpose === 'judge');
    expect(judge).toBeDefined();
    expect({ judgeSeesForgotten: judge!.user.includes('Kaspi'), exportHasForgotten: ex.includes('Kaspi') }).toEqual({ judgeSeesForgotten: false, exportHasForgotten: false });
    // FAILS: { judgeSeesForgotten: true, exportHasForgotten: true }
  }, 120_000);
});
