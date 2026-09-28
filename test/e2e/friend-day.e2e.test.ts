// Integration "friend day" e2e (docs/spec/06 §6.3, spec 05 end to end): the real modules wired by app.ts (memory,
// profile card, behaviour, proactive, scheduler, surfaces, trust) on a FakeClock; the model is scripted (turns, and the
// extract / consolidate / compose / judge parses). No real LLM, no network.
//   /start → five messages over three days with a plan ("interview on Thursday") → batched extraction with a ✍
//   reaction → the nightly card has an open thread → silence → on Friday, at a learned hour, ONE follow_up message →
//   the reply rewards it and the model sees the message as its own → «что ты обо мне знаешь?» → memory_search
//   about_me with the Mini App link → forget the interview → the card is rebuilt without it, and the earlier
//   Gora-first text is scrubbed → "don't text me first" (a scripted settings_update) → nothing more, ever.
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileCard } from '../../src/contracts/index.ts';
import { createBehaviourRepo } from '../../src/behaviour/repo.ts';
import { wallTimeOf } from '../../src/kernel/timeMath.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { U } from '../harness/updates.ts';
import { advanceTicks, createFriendApp, DAY, localAt, proactiveSends, type FriendApp } from '../harness/friend-B.ts';

let t: FriendApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TZ = 'Asia/Almaty';
const OWNER = { id: 4242, first_name: 'Aidana', language_code: 'en' };
const MIN = 60_000;

const CARD: ProfileCard = {
  summary: 'Aidana is a backend developer in Almaty; she has a job interview at Kaspi this week and is a bit nervous.',
  people: [],
  goals: ['get the backend job at Kaspi'],
  preferences: ['short answers'],
  style: { length: 'short', formality: 'informal', emoji: 'light', language: 'en', humor: null },
  current_context: [],
  open_threads: [{ what: 'job interview at Kaspi', when_local: '2026-10-08T15:00', follow_up_after_local: '2026-10-08T19:00' }],
};

describe('friend day (integration e2e)', () => {
  it('first contact → learning → one well-timed follow_up → reply → "what do you know" → forget → "don\'t text me first"', async () => {
    t = await createFriendApp({ tau: 0.001 });
    const app = t;
    const s = app.s;
    const sendsAt = (h: number, m = 0, day = 0) => advanceTicks(app, localAt(app, TZ, day, h, m) - app.clock.now());
    const chat = async (text: string, reply: string) => {
      app.llm.push(say(reply));
      await app.userSends(text, { user: OWNER });
      await app.settle();
    };

    // ── /start: exactly one line, no buttons (A2)
    await app.send(U.start(undefined, { user: OWNER }));
    await app.settle();
    const first = app.tg.calls.filter((c) => ['sendRichMessage', 'sendMessage'].includes(c.method));
    expect(first).toHaveLength(1);
    expect(first[0]!.payload.reply_markup).toBeUndefined();
    const u = s.repos.users.getByTg(OWNER.id)!;
    expect(u.onboardingStep).toBe('done');

    // ── Monday: three messages (the zone is confirmed silently from "I live in Almaty")
    await sendsAt(10);
    await chat('Hi! I live in Almaty, just moved here', 'Welcome! How do you like it so far?');
    expect(s.repos.users.getById(u.id)).toMatchObject({ tz: TZ, tzSource: 'city' });
    await app.clock.set(app.clock.now() + 5 * MIN);
    await chat('I have a job interview at Kaspi on Thursday at 15:00, a bit nervous', 'You will do great. Want to rehearse?');
    const planInput = s.db
      .prepare(`SELECT id, tg_message_id AS mid FROM conversation_inputs WHERE author = 'owner' ORDER BY created_at DESC LIMIT 1`)
      .get<{ id: string; mid: number }>()!;
    await app.clock.set(app.clock.now() + 5 * MIN);
    // three exchanges → the extraction batch is due now (B1); no consent card anywhere
    app.llm.pushParse('extract', {
      facts: [
        { text: 'Has a job interview at Kaspi on Thursday at 15:00', kind: 'date', subject: null, sensitivity: 'normal', confidence: 0.95, source_input_id: planInput.id, supersedes_id: null, explicit: false, importance: 0.9, ttl_days: null },
        { text: 'Is a backend developer', kind: 'profile', subject: null, sensitivity: 'normal', confidence: 0.9, source_input_id: planInput.id, supersedes_id: null, explicit: false, importance: 0.7, ttl_days: null },
      ],
      commitments: [],
    });
    await chat('Any tips for a backend interview?', 'Know your system design basics and ask them questions too.');
    await advanceTicks(app, 20 * MIN);
    expect(app.llm.parseRequests.filter((r) => r.purpose === 'extract')).toHaveLength(1);
    const facts = (await s.memory.list({ kind: 'user', userId: u.id }, { limit: 20 })).items.map((f) => f.text);
    expect(facts).toContain('Has a job interview at Kaspi on Thursday at 15:00');
    // A5: a ✍ reaction on the message the fact came from, never a "Remembered · Review" card
    const react = app.tg.calls.filter((c) => c.method === 'setMessageReaction' && c.payload.message_id === planInput.mid);
    expect(JSON.stringify(react)).toContain('✍');
    expect(app.tg.calls.some((c) => JSON.stringify(c.payload?.reply_markup ?? '').includes('mem'))).toBe(false);

    // ── the nightly consolidation (≈ 04:00 local) writes the card with the open thread
    app.llm.pushParse('consolidate', CARD);
    await sendsAt(19, 0, 1); // Tuesday evening
    expect(app.llm.parseRequests.filter((r) => r.purpose === 'consolidate')).toHaveLength(1);
    expect(s.userProfile.get(u.id)?.card.open_threads.map((x) => x.what)).toEqual(['job interview at Kaspi']);
    await chat('Rehearsed with a friend today', 'Nice, that helps a lot.');
    await sendsAt(20, 0, 1);
    await chat('Feeling better about Thursday now', 'Good! You have got this.');

    // ── silence. The owner ignores check-ins (the bandit already learned it): the follow-up is what should come
    const beh = createBehaviourRepo(() => s.db, () => s.crypto);
    beh.bumpArm(u.id, 'type:checkin', 0, 50, app.clock.now());
    const before = proactiveSends(app, u).length;
    expect(before).toBe(0);
    // nothing composed can be sent before Friday (no scripted drafts): Wednesday and Thursday stay quiet
    await sendsAt(0, 0, 3); // Friday 00:00
    expect(proactiveSends(app, u)).toHaveLength(0);
    app.llm.pushParse('compose', { text: 'Hey! How did the Kaspi interview go?' });
    app.llm.pushParse('judge', { send: true, reason: 'a natural follow-up' });
    await sendsAt(23, 50, 0); // through Friday
    const sent = proactiveSends(app, u);
    expect(sent).toHaveLength(1);
    const hour = wallTimeOf(sent[0]!.at, TZ).hour;
    expect(hour).toBeGreaterThanOrEqual(8);
    expect(hour).toBeLessThan(22); // never in quiet hours
    expect(s.signals.pActive(u.id, sent[0]!.at)).toBeGreaterThan(0);
    const row = s.db.prepare(`SELECT id, content_type AS type, reward FROM proactive_log WHERE user_id = ? AND sent = 1`).get<{ id: string; type: string; reward: number | null }>(u.id)!;
    expect(row.type).toBe('follow_up');
    const raw = app.tg.calls.find((c) => c.method === 'sendMessage' && String(c.payload.text).includes('Kaspi interview'))!;
    expect(raw.payload.reply_markup).toBeUndefined(); // no buttons, no "Why now:"
    expect(String(raw.payload.text)).not.toMatch(/why now/i);

    // ── the owner answers: reward 1; the next run sees the message as its own
    const reqBefore = app.llm.requests.length;
    await chat('It went great, they liked me!', 'Congrats!! Tell me everything.');
    expect(s.db.prepare(`SELECT reward FROM proactive_log WHERE id = ?`).get<{ reward: number }>(row.id)!.reward).toBe(1);
    expect(JSON.stringify(app.llm.requests.slice(reqBefore))).toContain('You messaged the owner first (follow_up)');

    // ── «что ты обо мне знаешь?» → memory_search about_me → the card, the facts and the Mini App link
    app.llm.push(turn().toolUse('memory_search', { query: '', about_me: true }, 'toolu_about').build());
    app.llm.push(say('You are a backend developer in Almaty… see everything in /memory.'));
    await app.userSends('что ты обо мне знаешь?', { user: OWNER });
    await app.settle();
    const toolReq = JSON.stringify(app.llm.requests.at(-1));
    expect(toolReq).toContain('backend developer in Almaty');
    expect(toolReq).toContain('/app/');

    // ── forget the interview → the card is rebuilt without it; the Gora-first text about it is scrubbed
    app.llm.push(turn().toolUse('memory_forget', { query: 'Kaspi interview' }, 'toolu_forget').build());
    app.llm.push(say('Done — forgotten.'));
    app.llm.pushParse('consolidate', { ...CARD, summary: 'Aidana is a backend developer in Almaty.', goals: [], open_threads: [] });
    await app.userSends('forget the Kaspi interview please', { user: OWNER });
    await app.settle();
    await advanceTicks(app, 20 * MIN);
    expect((await s.memory.list({ kind: 'user', userId: u.id }, { limit: 20 })).items.map((f) => f.text).join('\n')).not.toContain('Kaspi');
    const rebuild = app.llm.parseRequests.filter((r) => r.purpose === 'consolidate').at(-1)!;
    expect(rebuild.user).not.toContain('Kaspi');
    expect(JSON.stringify(s.userProfile.get(u.id)?.card ?? null)).not.toContain('Kaspi');
    const hook = s.privacyHooks.find((h) => h.name === 'behaviour')!;
    expect(JSON.stringify(await hook.exportUser!(u.id, u.tgUserId))).not.toContain('Kaspi');

    // ── "don't text me first" (a scripted settings_update, C5) → proactive off → nothing more, ever
    app.llm.push(turn().toolUse('settings_update', { proactive: 'off' }, 'toolu_off').build());
    app.llm.push(say('Got it — I won’t write first.'));
    await app.userSends('please don’t text me first', { user: OWNER });
    await app.settle();
    expect(s.repos.users.getById(u.id)!.proactiveLevel).toBe('off');
    const composed = app.llm.parseRequests.filter((r) => r.purpose === 'compose').length;
    for (let i = 0; i < 4; i++) {
      app.llm.pushParse('compose', { text: `Hey! ${i}` });
      app.llm.pushParse('judge', { send: true, reason: 'ok' });
    }
    await advanceTicks(app, 5 * DAY);
    expect(proactiveSends(app, u)).toHaveLength(1);
    expect(app.llm.parseRequests.filter((r) => r.purpose === 'compose')).toHaveLength(composed);
  }, 180_000);
});
