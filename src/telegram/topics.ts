// telegram/topics.ts (WP2) — private-chat topics (01 F10, §5.1; ⚠U13, ⚠U19; table `topics`).
//   - 📥 Inbox and ☀️ Today are created lazily, once per user (UNIQUE index topics_fixed + a per-user mutex);
//   - missions get '🎯 <title>' topics; the status prefix (⏳ ⏸ ✅ ⛔) is set with editForumTopic through the outbox;
//   - createForumTopic failing with "not a forum" switches topics off (kv.bot_flags.topics=false) and returns null, so
//     callers fall back to prefixes in the main DM (⚠U13);
//   - a user-created topic with is_name_implicit gets a `rename_topic` job (⚠U19: only when the flag is true), which asks
//     SideCalls.topicTitle for a title from the first message.
import { GrammyError, type Api } from 'grammy';
import type { BotFlags, Clock, CoreRepos, Crypto, Db, JobHandler, Logger, Outbox, Services, TopicManager, UserId } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import { KeyedMutex } from '../kernel/keyedMutex.ts';
import { rawOf } from './render/fallback.ts';

/** The six icon colors Telegram allows for createForumTopic. */
export const TOPIC_ICON_COLORS = Object.freeze({ blue: 7322096, yellow: 16766590, violet: 13338331, green: 9367192, rose: 16749490, red: 16478047 });
export const FIXED_TOPICS = Object.freeze({
  inbox: { en: '📥 Inbox', ru: '📥 Входящие', color: TOPIC_ICON_COLORS.blue },
  today: { en: '☀️ Today', ru: '☀️ Сегодня', color: TOPIC_ICON_COLORS.yellow },
});
export const MISSION_ICON_COLOR = TOPIC_ICON_COLORS.green;
export const STATUS_PREFIX: Readonly<Record<'working' | 'waiting' | 'done' | 'failed' | 'none', string>> = Object.freeze({ working: '⏳', waiting: '⏸', done: '✅', failed: '⛔', none: '' });
const NAME_MAX = 128;
const RENAME_DELAY_MS = 60_000;
const RENAME_MAX_TRIES = 30;

interface TopicRow { user_id: string; thread_id: number; kind: 'inbox' | 'today' | 'mission' | 'user'; base_name_enc: Uint8Array; status_prefix: string; conversation_id: string | null; mission_id: string | null }

export function isNotAForum(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /not a forum|forum.*(disabled|not enabled)|topics?_?(are )?(disabled|not enabled)|TOPIC.*DISABLED/i.test(e.description);
}

export function topicName(s: string): string {
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, NAME_MAX).join('');
}

export function createTopicManager(d: {
  db: Db; crypto: Crypto; clock: Clock; log: Logger; api: () => Api; flags: BotFlags & { disableTopics(now: number): void };
  outbox: () => Outbox; repos: () => CoreRepos; s: Services;
}): TopicManager & { renameJob: JobHandler } {
  const { db, crypto, clock, log } = d;
  const mutex = new KeyedMutex();
  let seq = 0;
  const aad = (userId: string, thread: number) => `topics|base_name_enc|${userId}:${thread}`;
  const row = (userId: UserId, threadId: number) =>
    db.prepare('SELECT user_id, thread_id, kind, base_name_enc, status_prefix, conversation_id, mission_id FROM topics WHERE user_id = ? AND thread_id = ?').get<TopicRow>(userId, threadId);
  const insert = (userId: UserId, threadId: number, kind: TopicRow['kind'], base: string, color: number | null, implicit: boolean, missionId: string | null) =>
    db
      .prepare(`INSERT OR IGNORE INTO topics (user_id, thread_id, kind, base_name_enc, status_prefix, icon_color, is_name_implicit, conversation_id, mission_id, created_at)
                VALUES (?, ?, ?, ?, '', ?, ?, NULL, ?, ?)`)
      .run(userId, threadId, kind, crypto.seal(`u:${userId}`, base, aad(userId, threadId)), color, implicit ? 1 : 0, missionId, clock.now());
  const baseName = (r: TopicRow) => {
    try {
      return crypto.openText(r.base_name_enc, aad(r.user_id, r.thread_id));
    } catch {
      return '';
    }
  };

  async function create(tgUserId: number, name: string, color: number): Promise<number | null> {
    if (!d.flags.topics) return null;
    try {
      const t = await rawOf(d.api())['createForumTopic']!({ chat_id: tgUserId, name: topicName(name), icon_color: color });
      const id = (t as { message_thread_id?: number }).message_thread_id;
      return typeof id === 'number' ? id : null;
    } catch (e) {
      if (isNotAForum(e)) {
        d.flags.disableTopics(clock.now());
        return null;
      }
      log.warn({ err: e instanceof GrammyError ? `${e.error_code}` : e instanceof Error ? e.name : 'error' }, 'createForumTopic failed');
      return null;
    }
  }

  const renameJob: JobHandler = async (job) => {
    const threadId = Number(job.payload['threadId']);
    const tgUserId = Number(job.payload['tgUserId']);
    const tries = Number(job.payload['tries'] ?? 0);
    const userId = job.userId;
    if (!userId || !Number.isSafeInteger(threadId) || !Number.isSafeInteger(tgUserId)) return { status: 'dead', error: 'bad payload' };
    const r = row(userId, threadId);
    if (!r || r.kind !== 'user') return { status: 'done' };
    const first = firstUserText(tgUserId, threadId);
    if (!first) {
      if (tries >= RENAME_MAX_TRIES) return { status: 'done' };
      d.s.scheduler.schedule({ kind: 'rename_topic', runAt: clock.now() + 2 * 60_000, userId, refId: String(threadId), payload: { threadId, tgUserId, tries: tries + 1 }, dedupeKey: `rename_topic:${userId}:${threadId}:${tries + 1}` });
      return { status: 'done' };
    }
    const user = d.repos().users.getById(userId);
    const title = await d.s.side.topicTitle(first.slice(0, 1000), user?.languageCode ?? 'en', { userId, priority: 'background' });
    if (!title) return { status: 'done' };
    const name = topicName(title);
    if (!name) return { status: 'done' };
    const prefix = r.status_prefix;
    await rawOf(d.api())['editForumTopic']!({ chat_id: tgUserId, message_thread_id: threadId, name: topicName(prefix ? `${prefix} ${name}` : name) });
    db.prepare('UPDATE topics SET base_name_enc = ?, is_name_implicit = 0 WHERE user_id = ? AND thread_id = ?').run(crypto.seal(`u:${userId}`, name, aad(userId, threadId)), userId, threadId);
    return { status: 'done' };
  };

  /** The first owner text typed in a user-created topic (the transcript's first user_input row). */
  function firstUserText(tgUserId: number, threadId: number): string | null {
    try {
      const key = d.s.conversations.scopeKeyOf({ kind: 'dm', tgUserId, threadId });
      const conv = d.repos().conversations.byScopeKey(key);
      if (!conv) return null;
      const pending = d.repos().inputs.pending(conv.id);
      for (let e = 1; e <= conv.epoch; e++) {
        for (const m of d.repos().messages.load(conv.id, e)) {
          if (m.kind !== 'user_input') continue;
          const t = textOf(m.content.content);
          if (t) return t;
        }
      }
      for (const i of pending) {
        const t = textOf(i.content);
        if (t) return t;
      }
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.name : 'error' }, 'rename_topic: could not read the first message');
    }
    return null;
  }

  return {
    renameJob,
    async ensureFixed(userId, tgUserId, kind) {
      if (!d.flags.topics) return null; // ⚠U13: prefixes in the main DM
      return mutex.run(`${userId}:${kind}`, async () => {
        const existing = db.prepare('SELECT thread_id FROM topics WHERE user_id = ? AND kind = ?').get<{ thread_id: number }>(userId, kind);
        if (existing) return Number(existing.thread_id);
        const lang = uiLang(d.repos().users.getById(userId)?.languageCode);
        const spec = FIXED_TOPICS[kind];
        const thread = await create(tgUserId, spec[lang], spec.color);
        if (thread === null) return null;
        insert(userId, thread, kind, spec[lang], spec.color, false, null);
        return thread;
      });
    },
    async createMission(userId, tgUserId, missionId, title) {
      const name = topicName(`🎯 ${title}`);
      const thread = await create(tgUserId, name, MISSION_ICON_COLOR);
      if (thread === null) return null;
      insert(userId, thread, 'mission', name, MISSION_ICON_COLOR, false, missionId);
      return thread;
    },
    async setStatus(tgUserId, threadId, s) {
      const user = d.repos().users.getByTg(tgUserId);
      if (!user) return;
      const r = row(user.id, threadId);
      if (!r) return;
      const prefix = STATUS_PREFIX[s];
      if (r.status_prefix === prefix) return;
      db.prepare('UPDATE topics SET status_prefix = ? WHERE user_id = ? AND thread_id = ?').run(prefix, user.id, threadId);
      const base = baseName(r);
      if (!base) return;
      d.outbox().enqueue({
        idempotencyKey: `topic:${user.id}:${threadId}:${clock.now()}:${++seq}`, userId: user.id, chatId: tgUserId, threadId,
        method: 'editForumTopic', payload: { name: topicName(prefix ? `${prefix} ${base}` : base) }, priority: 5,
      });
    },
    onUserTopicCreated(userId, tgUserId, threadId, isNameImplicit) {
      insert(userId, threadId, 'user', '', null, isNameImplicit, null);
      if (!isNameImplicit) return; // ⚠U19: rename only when Telegram says the name was implicit
      d.s.scheduler.schedule({
        kind: 'rename_topic', runAt: clock.now() + RENAME_DELAY_MS, userId, refId: String(threadId),
        payload: { threadId, tgUserId, tries: 0 }, dedupeKey: `rename_topic:${userId}:${threadId}`,
      });
    },
    kindOf(userId, threadId) {
      return row(userId, threadId)?.kind ?? null;
    },
    lookup(userId, threadId) {
      const r = row(userId, threadId);
      if (!r) return null;
      return { kind: r.kind, missionId: r.mission_id, conversationId: r.conversation_id };
    },
  };
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    const t = b.text.replace(/<gora_context>[\s\S]*?<\/gora_context>/g, '').replace(/<[^>]+>/g, '').trim();
    if (t) return t;
  }
  return null;
}
