// test/harness/s07-gr.ts (GR, spec 07 §C) — update builders updates.ts lacks: a group message_reaction, a group voice
// note, a group text replying to another member's message, a group text with an explicit message id / date, and a
// group /catchup that carries ephemeral_message_id. Plus small helpers over GR's tables for the tests.
import type { Update } from 'grammy/types';
import type { Services } from '../../src/contracts/index.ts';
import { TEST_BOT_INFO } from './fakeTelegram.ts';
import { nextMessageId, nextUpdateId, TEST_GROUP_ID, TEST_USER, type TestUser } from './updates.ts';

const chat = (id = TEST_GROUP_ID) => ({ id, type: 'supergroup' as const, title: 'Friends' });
const asUser = (u: TestUser) => ({ id: u.id, is_bot: false, first_name: u.first_name, ...(u.username ? { username: u.username } : {}), ...(u.language_code ? { language_code: u.language_code } : {}) });
const sec = (ms: number) => Math.floor(ms / 1000);

export interface GrMsgOpts { user?: TestUser; chatId?: number; messageId?: number; at?: number; threadId?: number }

function base(o: GrMsgOpts): Record<string, unknown> {
  const m: Record<string, unknown> = { message_id: o.messageId ?? nextMessageId(), date: sec(o.at ?? 0), chat: chat(o.chatId), from: asUser(o.user ?? TEST_USER) };
  if (o.threadId) {
    m['message_thread_id'] = o.threadId;
    m['is_topic_message'] = true;
  }
  return m;
}
const upd = (u: Omit<Update, 'update_id'>): Update => ({ update_id: nextUpdateId(), ...u }) as Update;

export const GR = {
  /** A plain group message at a given clock time (ms). */
  text(text: string, o: GrMsgOpts & { at: number }): Update {
    return upd({ message: { ...base(o), text } as never });
  },
  /** A group message that replies to another member's message. */
  replyToMember(text: string, to: { messageId: number; user: TestUser; text: string }, o: GrMsgOpts & { at: number }): Update {
    return upd({ message: { ...base(o), text, reply_to_message: { message_id: to.messageId, date: sec(o.at) - 5, chat: chat(o.chatId), from: asUser(to.user), text: to.text } } as never });
  },
  /** A reply to one of Gora's messages (engagement with a chime-in). */
  replyToBot(text: string, botMessageId: number, o: GrMsgOpts & { at: number }): Update {
    const bot = { id: TEST_BOT_INFO.id, is_bot: true, first_name: TEST_BOT_INFO.first_name, username: TEST_BOT_INFO.username };
    return upd({ message: { ...base(o), text, reply_to_message: { message_id: botMessageId, date: sec(o.at) - 5, chat: chat(o.chatId), from: bot, text: '…' } } as never });
  },
  /** A group voice note (file registered separately with t.tg.addFile). */
  voice(fileId: string, o: GrMsgOpts & { at: number; duration?: number }): Update {
    return upd({ message: { ...base(o), voice: { file_id: fileId, file_unique_id: `u_${fileId}`, duration: o.duration ?? 4, mime_type: 'audio/ogg' } } as never });
  },
  /** A group message_reaction (delivered to the bot only when it is an administrator). */
  reaction(messageId: number, emoji: string, o: { user?: TestUser; chatId?: number; at: number }): Update {
    const user = o.user ?? TEST_USER;
    return upd({ message_reaction: { chat: chat(o.chatId), message_id: messageId, user: asUser(user), date: sec(o.at), old_reaction: [], new_reaction: [{ type: 'emoji', emoji }] } as never });
  },
  /** `/catchup` registered with is_ephemeral (pass ephemeralMessageId null to omit it). */
  catchup(o: GrMsgOpts & { at: number; ephemeralMessageId?: number | null }): Update {
    const text = `/catchup@${TEST_BOT_INFO.username}`;
    const eph = o.ephemeralMessageId === null ? {} : { ephemeral_message_id: o.ephemeralMessageId ?? 91 };
    return upd({ message: { ...base(o), text, entities: [{ type: 'bot_command', offset: 0, length: text.length }], ...eph } as never });
  },
};

/** GR's tables, read directly (tests only). */
export const grRows = {
  messages: (s: Services, chatId = TEST_GROUP_ID) => Number(s.db.prepare('SELECT COUNT(*) AS n FROM group_messages WHERE chat_id = ?').get<{ n: number }>(chatId)!.n),
  summaries: (s: Services, chatId = TEST_GROUP_ID) => Number(s.db.prepare('SELECT COUNT(*) AS n FROM group_summaries WHERE chat_id = ?').get<{ n: number }>(chatId)!.n),
  policy: (s: Services, chatId = TEST_GROUP_ID) => s.db.prepare('SELECT * FROM group_policy WHERE chat_id = ?').get<Record<string, unknown>>(chatId),
  /** Seeds bandit evidence (α successes, β failures) for one kind — makes a Thompson draw effectively certain. */
  setArms(s: Services, arms: Record<string, [number, number]>, chatId = TEST_GROUP_ID) {
    const now = s.clock.now();
    s.db.prepare(`INSERT INTO group_policy (chat_id, arms_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET arms_json = excluded.arms_json`).run(chatId, JSON.stringify(arms), now);
  },
};
