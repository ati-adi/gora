// WP2 — topics (01 §15.2): topic creation once per kind with the allowed icon colors; "not a forum" falls back (⚠U13);
// status prefixes; ⚠U19 renames only implicit names.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../../src/contracts/index.ts';
import { FIXED_TOPICS, MISSION_ICON_COLOR, TOPIC_ICON_COLORS } from '../../../src/telegram/topics.ts';
import { makeEnv, makeUser, type Env } from './helpers.ts';

let e: Env;
beforeEach(async () => {
  e = await makeEnv();
});
afterEach(async () => {
  await e.close();
});
const ALLOWED = new Set(Object.values(TOPIC_ICON_COLORS));

describe('topics', () => {
  it('creates 📥 Inbox and ☀️ Today once per user, even when asked concurrently, with allowed icon colors', async () => {
    const u = makeUser(e.s);
    const [a, b] = await Promise.all([e.s.telegram.topics.ensureFixed(u.id, 1001, 'inbox'), e.s.telegram.topics.ensureFixed(u.id, 1001, 'inbox')]);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    const today = await e.s.telegram.topics.ensureFixed(u.id, 1001, 'today');
    expect(today).not.toBe(a);
    expect(await e.s.telegram.topics.ensureFixed(u.id, 1001, 'inbox')).toBe(a);
    const created = e.tg.byMethod('createForumTopic');
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ chat_id: 1001, name: FIXED_TOPICS.inbox.en, icon_color: FIXED_TOPICS.inbox.color });
    expect(created[1]).toMatchObject({ name: FIXED_TOPICS.today.en, icon_color: FIXED_TOPICS.today.color });
    for (const c of created) expect(ALLOWED.has(c.icon_color)).toBe(true);
    expect(e.s.telegram.topics.kindOf(u.id, a!)).toBe('inbox');
    expect(e.s.telegram.topics.lookup(u.id, today!)).toEqual({ kind: 'today', missionId: null, conversationId: null });
  });

  it('uses Russian names for Russian speakers', async () => {
    const u = makeUser(e.s, { id: 1003, lang: 'ru' });
    await e.s.telegram.topics.ensureFixed(u.id, 1003, 'today');
    expect(e.tg.byMethod('createForumTopic')[0].name).toBe(FIXED_TOPICS.today.ru);
  });

  it('mission topics: 🎯 name, green icon, lookup by thread, status prefixes through editForumTopic', async () => {
    const u = makeUser(e.s);
    const t = await e.s.telegram.topics.createMission(u.id, 1001, 'ms_1', 'ALA→IST fares');
    expect(e.tg.byMethod('createForumTopic')[0]).toMatchObject({ name: '🎯 ALA→IST fares', icon_color: MISSION_ICON_COLOR });
    expect(e.s.telegram.topics.lookup(u.id, t!)).toEqual({ kind: 'mission', missionId: 'ms_1', conversationId: null });
    await e.s.telegram.topics.setStatus(1001, t!, 'working');
    await e.s.telegram.topics.setStatus(1001, t!, 'working'); // unchanged → no second edit
    await e.s.telegram.topics.setStatus(1001, t!, 'done');
    await e.s.telegram.outbox.flush();
    expect(e.tg.byMethod('editForumTopic').map((p) => p.name)).toEqual(['⏳ 🎯 ALA→IST fares', '✅ 🎯 ALA→IST fares']);
    expect(e.tg.byMethod('editForumTopic')[0]).toMatchObject({ chat_id: 1001, message_thread_id: t });
  });

  it('⚠U13: "chat is not a forum" switches topics off (kv.bot_flags) and every caller falls back to null', async () => {
    const u = makeUser(e.s);
    e.tg.failNext('createForumTopic', { error_code: 400, description: 'Bad Request: the chat is not a forum' });
    expect(await e.s.telegram.topics.ensureFixed(u.id, 1001, 'inbox')).toBeNull();
    expect(e.s.telegram.flags.topics).toBe(false);
    expect(e.s.repos.kv.get<{ topics: boolean }>('bot_flags')?.topics).toBe(false);
    expect(await e.s.telegram.topics.createMission(u.id, 1001, 'ms_2', 'x')).toBeNull();
    expect(await e.s.telegram.topics.ensureFixed(u.id, 1001, 'today')).toBeNull();
    expect(e.tg.byMethod('createForumTopic')).toHaveLength(1);
  });

  it('other createForumTopic errors return null without disabling topics', async () => {
    const u = makeUser(e.s);
    e.tg.failNext('createForumTopic', { error_code: 400, description: 'Bad Request: TOPIC_NAME_INVALID' });
    expect(await e.s.telegram.topics.ensureFixed(u.id, 1001, 'inbox')).toBeNull();
    expect(e.s.telegram.flags.topics).toBe(true);
    expect(await e.s.telegram.topics.ensureFixed(u.id, 1001, 'inbox')).toBeGreaterThan(0);
  });

  it('⚠U19: a user topic is renamed only when its name is implicit, from the first message', async () => {
    const u = makeUser(e.s);
    e.s.telegram.topics.onUserTopicCreated(u.id, 1001, 555, false);
    expect([...e.scheduler.jobs.values()].filter((j) => j.kind === 'rename_topic')).toHaveLength(0);
    e.s.telegram.topics.onUserTopicCreated(u.id, 1001, 556, true);
    const jobs = [...e.scheduler.jobs.values()].filter((j) => j.kind === 'rename_topic');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ threadId: 556, tgUserId: 1001, tries: 0 });
    expect(e.s.telegram.topics.kindOf(u.id, 556)).toBe('user');
    // the handler: no conversation yet → re-scheduled; with a first message → titled via side.topicTitle
    expect(e.scheduler.kinds()).toContain('rename_topic');
    const conv = e.s.repos.conversations.create({ scopeKey: 'dm:1001:t556', kind: 'topic', userId: u.id, tgChatId: 1001, threadId: 556, businessConnectionId: null, route: 'chat', model: 'm', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [], contextMode: 'system', singleShot: false });
    e.s.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'Plan our Istanbul trip' }], tgUpdateId: 9, tgChatId: 1001, tgMessageId: 9, fromTgUserId: 1001, replyToCardId: null });
    const renameJob = (e.s.telegram.topics as unknown as { renameJob: JobHandler }).renameJob;
    const res = await renameJob({ ...jobs[0]!, userId: u.id }, { now: e.clock.now(), signal: new AbortController().signal });
    expect(res).toEqual({ status: 'done' });
    expect(e.tg.byMethod('editForumTopic').at(-1)).toMatchObject({ chat_id: 1001, message_thread_id: 556, name: 'Trip planning' });
  });
});
