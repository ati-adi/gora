// test/harness/updates.ts (WP0) — builders for every update in 01 §10.1 (Bot API 10.3 shapes, grammY 1.46 types).
import type { Chat, Message, MessageEntity, Update, User } from 'grammy/types';
import { TEST_BOT_INFO } from './fakeTelegram.ts';

export interface TestUser { id: number; first_name: string; username?: string; language_code?: string; last_name?: string }
/** The default owner in tests. */
export const TEST_USER: TestUser = { id: 1001, first_name: 'Aigerim', username: 'aigerim', language_code: 'en' };
export const OTHER_USER: TestUser = { id: 1002, first_name: 'Anna', username: 'anna_c', language_code: 'en' };
export const RU_USER: TestUser = { id: 1003, first_name: 'Дамир', language_code: 'ru' };
export const TEST_GROUP_ID = -1001234567890;
export const BOT_USERNAME = TEST_BOT_INFO.username;

let updateSeq = 100_000;
let messageSeq = 5_000;
let callbackSeq = 0;
/** Clock used for `date` fields (unix seconds); tests may point it at their FakeClock. */
let nowSec: () => number = () => Math.floor(Date.now() / 1000);
export function setUpdateClock(fn: () => number /* ms */): void {
  nowSec = () => Math.floor(fn() / 1000);
}
export const nextUpdateId = () => ++updateSeq;
export const nextMessageId = () => ++messageSeq;

const asUser = (u: TestUser): User => ({ id: u.id, is_bot: false, first_name: u.first_name, ...(u.username ? { username: u.username } : {}), ...(u.language_code ? { language_code: u.language_code } : {}), ...(u.last_name ? { last_name: u.last_name } : {}) });
const botUser = (): User => ({ id: TEST_BOT_INFO.id, is_bot: true, first_name: TEST_BOT_INFO.first_name, username: TEST_BOT_INFO.username });
const privateChat = (u: TestUser): Chat.PrivateChat => ({ id: u.id, type: 'private', first_name: u.first_name, ...(u.username ? { username: u.username } : {}) });
const groupChat = (id = TEST_GROUP_ID, title = 'Friends'): Chat.SupergroupChat => ({ id, type: 'supergroup', title });

interface MsgOpts { user?: TestUser; threadId?: number; replyTo?: number | Message; messageId?: number; date?: number }

function baseMsg(chat: Chat, from: User, o: MsgOpts): Record<string, unknown> {
  const m: Record<string, unknown> = { message_id: o.messageId ?? nextMessageId(), date: o.date ?? nowSec(), chat, from };
  if (o.threadId) {
    m['message_thread_id'] = o.threadId;
    m['is_topic_message'] = true;
  }
  if (o.replyTo !== undefined) {
    m['reply_to_message'] = typeof o.replyTo === 'number' ? { message_id: o.replyTo, date: nowSec(), chat, from: botUser(), text: '…' } : o.replyTo;
  }
  return m;
}
const upd = (u: Omit<Update, 'update_id'>): Update => ({ update_id: nextUpdateId(), ...u }) as Update;
type Msg = NonNullable<Update['message']>;
type BizMsg = NonNullable<Update['business_message']>;
type EditedMsg = NonNullable<Update['edited_message']>;
type EditedBizMsg = NonNullable<Update['edited_business_message']>;
const privateMsg = (o: MsgOpts, extra: Record<string, unknown>): Msg => {
  const user = o.user ?? TEST_USER;
  return { ...baseMsg(privateChat(user), asUser(user), o), ...extra } as unknown as Msg;
};

function commandEntities(text: string): MessageEntity[] {
  const m = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/.exec(text);
  return m ? [{ type: 'bot_command', offset: 0, length: m[0].length }] : [];
}

export const U = {
  // ── private chat
  privateText(text: string, o: MsgOpts & { entities?: MessageEntity[] } = {}): Update {
    return upd({ message: privateMsg(o, { text, ...(o.entities ? { entities: o.entities } : {}) }) });
  },
  command(cmd: string, args = '', o: MsgOpts = {}): Update {
    const text = `/${cmd}${args ? ' ' + args : ''}`;
    return upd({ message: privateMsg(o, { text, entities: commandEntities(text) }) });
  },
  start(payload?: string, o: MsgOpts = {}): Update {
    return U.command('start', payload ?? '', o);
  },
  voice(o: MsgOpts & { fileId?: string; duration?: number; mime?: string; size?: number } = {}): Update {
    return upd({ message: privateMsg(o, { voice: { file_id: o.fileId ?? 'voice_file_1', file_unique_id: 'uv1', duration: o.duration ?? 14, mime_type: o.mime ?? 'audio/ogg', file_size: o.size ?? 20_000 } }) });
  },
  videoNote(o: MsgOpts & { fileId?: string; duration?: number; size?: number } = {}): Update {
    return upd({ message: privateMsg(o, { video_note: { file_id: o.fileId ?? 'vnote_file_1', file_unique_id: 'uvn1', length: 240, duration: o.duration ?? 8, file_size: o.size ?? 300_000 } }) });
  },
  audio(o: MsgOpts & { fileId?: string; fileName?: string; mime?: string; duration?: number; size?: number } = {}): Update {
    return upd({ message: privateMsg(o, { audio: { file_id: o.fileId ?? 'audio_file_1', file_unique_id: 'ua1', duration: o.duration ?? 30, file_name: o.fileName ?? 'memo.mp3', mime_type: o.mime ?? 'audio/mpeg', file_size: o.size ?? 400_000 } }) });
  },
  photo(o: MsgOpts & { fileId?: string; caption?: string; size?: number } = {}): Update {
    const id = o.fileId ?? 'photo_file_1';
    return upd({
      message: privateMsg(o, {
        photo: [
          { file_id: `${id}_s`, file_unique_id: 'ups', width: 90, height: 90, file_size: 1_000 },
          { file_id: id, file_unique_id: 'upl', width: 1280, height: 960, file_size: o.size ?? 120_000 },
        ],
        ...(o.caption ? { caption: o.caption } : {}),
      }),
    });
  },
  document(o: MsgOpts & { fileId?: string; fileName?: string; mime?: string; size?: number; caption?: string } = {}): Update {
    return upd({ message: privateMsg(o, { document: { file_id: o.fileId ?? 'doc_file_1', file_unique_id: 'ud1', file_name: o.fileName ?? 'report.pdf', mime_type: o.mime ?? 'application/pdf', file_size: o.size ?? 50_000 }, ...(o.caption ? { caption: o.caption } : {}) }) });
  },
  forward(text: string, o: MsgOpts & { fromName?: string; fromUser?: TestUser } = {}): Update {
    const origin = o.fromUser ? { type: 'user', date: nowSec() - 3600, sender_user: asUser(o.fromUser) } : { type: 'hidden_user', date: nowSec() - 3600, sender_user_name: o.fromName ?? 'Someone' };
    return upd({ message: privateMsg(o, { text, forward_origin: origin }) });
  },
  replyToCard(text: string, cardMessageId: number, o: MsgOpts = {}): Update {
    return U.privateText(text, { ...o, replyTo: cardMessageId });
  },
  location(lat: number, lon: number, o: MsgOpts & { livePeriod?: number } = {}): Update {
    return upd({ message: privateMsg(o, { location: { latitude: lat, longitude: lon, ...(o.livePeriod ? { live_period: o.livePeriod } : {}) } }) });
  },
  liveLocationEdit(lat: number, lon: number, messageId: number, o: MsgOpts = {}): Update {
    return upd({ edited_message: privateMsg({ ...o, messageId }, { location: { latitude: lat, longitude: lon, live_period: 3600 }, edit_date: nowSec() }) as EditedMsg });
  },
  editedText(text: string, messageId: number, o: MsgOpts = {}): Update {
    return upd({ edited_message: privateMsg({ ...o, messageId }, { text, edit_date: nowSec() }) as EditedMsg });
  },
  topicMessage(text: string, threadId: number, o: MsgOpts = {}): Update {
    return U.privateText(text, { ...o, threadId });
  },
  forumTopicCreated(threadId: number, name = 'New topic', o: MsgOpts & { implicit?: boolean } = {}): Update {
    return upd({ message: privateMsg({ ...o, threadId, messageId: threadId }, { forum_topic_created: { name, icon_color: 7322096, ...(o.implicit !== false ? { is_name_implicit: true } : {}) } }) });
  },
  successfulPayment(o: { user?: TestUser; payload: string; amount: number; chargeId: string; recurring?: 'first' | 'renewal'; expiresSec?: number }): Update {
    return upd({
      message: privateMsg({ user: o.user }, {
        successful_payment: {
          currency: 'XTR',
          total_amount: o.amount,
          invoice_payload: o.payload,
          telegram_payment_charge_id: o.chargeId,
          provider_payment_charge_id: '',
          ...(o.recurring ? { is_recurring: true, subscription_expiration_date: o.expiresSec ?? nowSec() + 2_592_000 } : {}),
          ...(o.recurring === 'first' ? { is_first_recurring: true } : {}),
        },
      }),
    });
  },

  // ── groups
  groupMention(text: string, o: MsgOpts & { chatId?: number } = {}): Update {
    const full = text.includes(`@${BOT_USERNAME}`) ? text : `@${BOT_USERNAME} ${text}`;
    const at = full.indexOf(`@${BOT_USERNAME}`);
    const user = o.user ?? TEST_USER;
    return upd({ message: { ...baseMsg(groupChat(o.chatId), asUser(user), o), text: full, entities: [{ type: 'mention', offset: at, length: BOT_USERNAME.length + 1 }] } as unknown as Msg });
  },
  groupReply(text: string, botMessageId: number, o: MsgOpts & { chatId?: number } = {}): Update {
    const user = o.user ?? TEST_USER;
    const chat = groupChat(o.chatId);
    return upd({ message: { ...baseMsg(chat, asUser(user), o), text, reply_to_message: { message_id: botMessageId, date: nowSec(), chat, from: botUser(), text: 'Earlier answer' } } as unknown as Msg });
  },
  groupText(text: string, o: MsgOpts & { chatId?: number } = {}): Update {
    const user = o.user ?? TEST_USER;
    return upd({ message: { ...baseMsg(groupChat(o.chatId), asUser(user), o), text } as unknown as Msg });
  },
  groupCommand(cmd: string, args = '', o: MsgOpts & { chatId?: number; withBotName?: boolean } = {}): Update {
    const text = `/${cmd}${o.withBotName === false ? '' : '@' + BOT_USERNAME}${args ? ' ' + args : ''}`;
    const user = o.user ?? TEST_USER;
    return upd({ message: { ...baseMsg(groupChat(o.chatId), asUser(user), o), text, entities: commandEntities(text) } as unknown as Msg });
  },
  /** Group `/me <question>` registered with is_ephemeral: carries ephemeral_message_id (⚠U5: pass null to omit it). */
  ephemeralMe(question: string, o: MsgOpts & { chatId?: number; ephemeralMessageId?: number | null } = {}): Update {
    const text = `/me${question ? ' ' + question : ''}`;
    const user = o.user ?? TEST_USER;
    const eph = o.ephemeralMessageId === null ? {} : { ephemeral_message_id: o.ephemeralMessageId ?? 77 };
    return upd({ message: { ...baseMsg(groupChat(o.chatId), asUser(user), o), text, entities: commandEntities(text), ...eph } as unknown as Msg });
  },

  // ── guest mode
  guestMessage(text: string, o: { user?: TestUser; guestQueryId?: string; chat?: Chat; replyToText?: string; replyToUser?: TestUser } = {}): Update {
    const user = o.user ?? TEST_USER;
    const chat: Chat = o.chat ?? { id: -100555, type: 'supergroup', title: 'Some chat' };
    const full = text.includes(`@${BOT_USERNAME}`) ? text : `@${BOT_USERNAME} ${text}`;
    const msg: Record<string, unknown> = {
      message_id: nextMessageId(), date: nowSec(), chat, from: asUser(user), text: full,
      entities: [{ type: 'mention', offset: full.indexOf('@'), length: BOT_USERNAME.length + 1 }],
      guest_query_id: o.guestQueryId ?? `gq_${nextUpdateId()}`,
    };
    if (o.replyToText) msg['reply_to_message'] = { message_id: nextMessageId(), date: nowSec() - 60, chat, from: asUser(o.replyToUser ?? OTHER_USER), text: o.replyToText };
    return upd({ guest_message: msg as unknown as Update['guest_message'] });
  },

  // ── business (Chat Automation)
  businessConnection(o: { id?: string; user?: TestUser; userChatId?: number; isEnabled?: boolean; canReply?: boolean; date?: number } = {}): Update {
    const user = o.user ?? TEST_USER;
    return upd({
      business_connection: { id: o.id ?? 'bc_1', user: asUser(user), user_chat_id: o.userChatId ?? user.id, date: o.date ?? nowSec(), is_enabled: o.isEnabled ?? true, rights: o.canReply === false ? {} : { can_reply: true } },
    });
  },
  businessMessage(text: string, o: { connectionId?: string; chatId?: number; from?: 'peer' | 'owner' | 'bot'; owner?: TestUser; peer?: TestUser; messageId?: number; edited?: boolean } = {}): Update {
    const owner = o.owner ?? TEST_USER;
    const peer = o.peer ?? OTHER_USER;
    const chatId = o.chatId ?? peer.id;
    const chat: Chat.PrivateChat = { id: chatId, type: 'private', first_name: peer.first_name };
    const from = o.from === 'owner' || o.from === 'bot' ? asUser(owner) : asUser(peer);
    const msg: Record<string, unknown> = { message_id: o.messageId ?? nextMessageId(), date: nowSec(), chat, from, text, business_connection_id: o.connectionId ?? 'bc_1' };
    if (o.from === 'bot') msg['sender_business_bot'] = botUser();
    if (o.edited) msg['edit_date'] = nowSec();
    return upd(o.edited ? { edited_business_message: msg as unknown as EditedBizMsg } : { business_message: msg as unknown as BizMsg });
  },
  editedBusinessMessage(text: string, messageId: number, o: { connectionId?: string; chatId?: number; peer?: TestUser } = {}): Update {
    return U.businessMessage(text, { ...o, messageId, edited: true });
  },
  deletedBusinessMessages(messageIds: number[], o: { connectionId?: string; chatId?: number; peer?: TestUser } = {}): Update {
    const peer = o.peer ?? OTHER_USER;
    return upd({ deleted_business_messages: { business_connection_id: o.connectionId ?? 'bc_1', chat: { id: o.chatId ?? peer.id, type: 'private', first_name: peer.first_name }, message_ids: messageIds } });
  },

  // ── control lane
  callbackQuery(data: string, o: { user?: TestUser; messageId?: number; chatId?: number; threadId?: number; inlineMessageId?: string } = {}): Update {
    const user = o.user ?? TEST_USER;
    const cq: Record<string, unknown> = { id: `cq_${++callbackSeq}`, from: asUser(user), chat_instance: 'ci_1', data };
    if (o.inlineMessageId) cq['inline_message_id'] = o.inlineMessageId;
    else {
      const chat: Chat = (o.chatId ?? user.id) > 0 ? privateChat(user) : groupChat(o.chatId);
      cq['message'] = { message_id: o.messageId ?? 1, date: nowSec(), chat, from: botUser(), text: 'card', ...(o.threadId ? { message_thread_id: o.threadId } : {}) };
    }
    return upd({ callback_query: cq as unknown as Update['callback_query'] });
  },
  stoppedGeneration(draftId: number, o: { user?: TestUser; threadId?: number } = {}): Update {
    const user = o.user ?? TEST_USER;
    return upd({ stopped_message_generation: { chat: privateChat(user), draft_id: draftId, ...(o.threadId ? { message_thread_id: o.threadId } : {}) } });
  },
  preCheckoutQuery(o: { user?: TestUser; payload: string; amount: number; id?: string }): Update {
    return upd({ pre_checkout_query: { id: o.id ?? `pcq_${nextUpdateId()}`, from: asUser(o.user ?? TEST_USER), currency: 'XTR', total_amount: o.amount, invoice_payload: o.payload } });
  },
  subscription(state: 'active' | 'canceled' | 'failed', o: { user?: TestUser; payload: string }): Update {
    return upd({ subscription: { user: asUser(o.user ?? TEST_USER), invoice_payload: o.payload, state } });
  },
  messageReaction(messageId: number, emoji: '👍' | '👎', o: { user?: TestUser; chatId?: number; removed?: boolean } = {}): Update {
    const user = o.user ?? TEST_USER;
    const r = [{ type: 'emoji' as const, emoji }];
    return upd({ message_reaction: { chat: privateChat(user), message_id: messageId, user: asUser(user), date: nowSec(), old_reaction: o.removed ? r : [], new_reaction: o.removed ? [] : r } });
  },
  myChatMember(status: 'member' | 'administrator' | 'left' | 'kicked', o: { user?: TestUser; chatId?: number; private?: boolean; title?: string } = {}): Update {
    const user = o.user ?? TEST_USER;
    const chat: Chat = o.private ? privateChat(user) : groupChat(o.chatId, o.title);
    const bot = botUser();
    const member = (s: typeof status) =>
      s === 'administrator'
        ? { status: 'administrator', user: bot, can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: false, can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: true, can_post_stories: false, can_edit_stories: false, can_delete_stories: false }
        : s === 'kicked'
          ? { status: 'kicked', user: bot, until_date: 0 }
          : { status: s, user: bot };
    const old = status === 'member' || status === 'administrator' ? member('left') : member('member');
    return upd({ my_chat_member: { chat, from: asUser(user), date: nowSec(), old_chat_member: old, new_chat_member: member(status) } as unknown as Update['my_chat_member'] });
  },
};
