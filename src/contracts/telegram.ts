// ── contracts/telegram.ts (WP0, frozen) — 01 §4.4 + 03 R4 ('vo' callback)
import type { Api, Bot } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup, MessageEntity, UserFromGetMe } from 'grammy/types';
import type { ChannelKind, Ms, UserId } from './common.ts';
import type { ConversationRow, RunRow, UserRow } from './storage.ts';
import type { Effect } from './tools.ts';

export interface BotFlags { topics: boolean; guest: boolean; business: boolean; mainWebApp: boolean; usersCanCreateTopics: boolean }
export interface SentRef { chatId: number; messageId: number; kind: 'rich' | 'entities' | 'plain' | 'inline' | 'ephemeral' }
/**
 * Bot API methods the outbox may queue. WP0 additions: sendDocument / sendPhoto (make_file effects on notify runs),
 * sendVoice (03 R4 voice replies), editForumTopic (the rename_topic job, mission status prefixes), deleteMessage
 * (placeholders, superseded helpers). Inline (guest) messages are edited with 'editMessageText' / 'editMessageReplyMarkup'
 * and `payload.inline_message_id` (chatId is then ignored; use 0) — there is no separate method name.
 */
export type OutboxMethod =
  | 'sendRichMessage' | 'sendMessage' | 'sendVenue' | 'sendPoll' | 'editMessageText' | 'editMessageReplyMarkup' | 'setMessageReaction' | 'sendChatAction'
  | 'sendDocument' | 'sendPhoto' | 'sendVoice' | 'editForumTopic' | 'deleteMessage';
/**
 * `payload` is the Bot API parameter object minus chat_id / message_thread_id / business_connection_id (taken from the
 * request fields). It is stored encrypted and must be JSON: binary payloads (sendDocument/sendPhoto/sendVoice) carry
 * `payload.blob_id` (a MessagesRepo.putBlob id, owner = the user) plus `payload.filename`; WP2 loads the blob and sends an
 * InputFile under the document/photo/voice field. Never put bytes or base64 in a payload.
 */
export interface OutboxRequest {
  idempotencyKey: string; userId?: UserId; chatId: number; threadId?: number; businessConnectionId?: string;
  method: OutboxMethod; payload: Record<string, unknown>;
  markdown?: string; /* rich → entities → plain chain when set */
  priority?: 0 | 1 | 5 | 9; notBefore?: Ms; disableNotification?: boolean; refKind?: string; refId?: string;
}
export interface Outbox {
  enqueue(r: OutboxRequest): string;
  sendNow(r: OutboxRequest): Promise<SentRef[]>;
  onSent(refKind: string, hook: (refId: string, sent: SentRef[]) => void): void;
  start(): void;
  stop(): Promise<void>;
  /** WP0 addition (tests, shutdown drain): send every row that is due now, respecting the limiter; resolves with the number sent. */
  flush(): Promise<number>;
}
export interface CardSpec {
  icon: '🔐' | '📥' | '💡' | '⏰' | '🎯' | '🔗' | '🧠' | '⭐' | '⚠️' | '👋' | '☀️' | '🕒';
  title: string; rows?: Array<[string, string]>; body?: { label: string; text: string }; lines?: string[]; warnings?: string[];
  footerMarkdown?: string; /* trusted, code-built */
  buttons: InlineKeyboardButton[][];
}
export interface Renderer {
  sanitize(md: string, ctx: { allowedLinkHosts: ReadonlySet<string>; allowedEmails: ReadonlySet<string> }): string; // §11.4
  hygiene(partialMd: string): string; // drafts: close fences/$$, drop partial tags
  split(md: string): string[]; // ≤30000 chars, ≤450 blocks
  toEntities(md: string): Array<{ text: string; entities: MessageEntity[] }>;
  card(spec: CardSpec): { markdown: string; replyMarkup: InlineKeyboardMarkup };
  escape(text: string): string;
  tgTime(unixSec: number, format: 'wDT' | 'DT' | 'dt' | 't' | 'r' | 'wd', text: string): string;
  sendMarkdown(t: { chatId: number; threadId?: number; businessConnectionId?: string; replyTo?: number }, md: string, o?: { replyMarkup?: InlineKeyboardMarkup; silent?: boolean; allowRich?: boolean }): Promise<SentRef[]>;
}
export type CallbackKind = 'a1' | 'ud' | 'ob' | 'ch' | 'td' | 'rm' | 'ng' | 'mm' | 'ms' | 'wt' | 'bz' | 'cn' | 'pl' | 'ct' | 'tz' | 'dl' | 'vo';
export interface CallbackCodec {
  encode(kind: CallbackKind, parts: string[], ownerTgId: number /* 0 = any group member */): string; /* throws if >64 bytes */
  decode(data: string, fromTgId: number): { kind: CallbackKind; parts: string[] } | { error: 'malformed' | 'bad_mac' | 'not_owner' };
}
export interface CallbackCtx { kind: CallbackKind; parts: string[]; fromTgId: number; user: UserRow | undefined; callbackQueryId: string; message?: { chatId: number; messageId: number; threadId?: number }; inlineMessageId?: string }
export type CallbackAnswer = { text?: string; alert?: boolean } | void;
export interface CallbackRegistry {
  register(kind: CallbackKind, h: (c: CallbackCtx) => Promise<CallbackAnswer>): void;
  dispatch(c: CallbackCtx): Promise<CallbackAnswer>;
}
export interface TopicManager {
  ensureFixed(userId: UserId, tgUserId: number, kind: 'inbox' | 'today'): Promise<number | null>;
  createMission(userId: UserId, tgUserId: number, missionId: string, title: string): Promise<number | null>;
  setStatus(tgUserId: number, threadId: number, s: 'working' | 'waiting' | 'done' | 'failed' | 'none'): Promise<void>;
  onUserTopicCreated(userId: UserId, tgUserId: number, threadId: number, isNameImplicit: boolean): void;
  kindOf(userId: UserId, threadId: number): 'inbox' | 'today' | 'mission' | 'user' | null;
  /** WP0 addition (§5.1 routing): a message typed in a mission topic goes to conversation 'mission:<missionId>'. */
  lookup(userId: UserId, threadId: number): { kind: 'inbox' | 'today' | 'mission' | 'user'; missionId: string | null; conversationId: string | null } | null;
}
export interface TelegramFiles { download(fileId: string, maxBytes: number): Promise<{ bytes: Uint8Array; size: number; ext: string }> } // the only holder of file URLs
export interface TgLinkRow {
  space: string; chatId: number; messageId: number; kind: string; userId: UserId | null; conversationId: string | null; epoch: number | null;
  seq: number | null; runId: string | null; pendingActionId: string | null; nudgeId: string | null; jobId: string | null;
  /** DDL tg_links.part: index of the message within a split send (0-based). */
  part: number;
}
export interface TgLinks {
  record(l: Partial<TgLinkRow> & { chatId: number; messageId: number; kind: string }): void;
  lookup(chatId: number, messageId: number, space?: string): TgLinkRow | undefined;
  /** WP0 addition (§5.11 recovery, §9 extraction notice): links of a run ordered by (created_at, part); index tg_links_run. */
  byRun(runId: string): TgLinkRow[];
}
export interface TelegramGateway {
  readonly api: Api; readonly botInfo: UserFromGetMe; readonly flags: BotFlags; readonly outbox: Outbox; readonly files: TelegramFiles;
  readonly topics: TopicManager; readonly render: Renderer; readonly codec: CallbackCodec; readonly callbacks: CallbackRegistry; readonly links: TgLinks;
}
export interface ReplyChannel {
  readonly kind: ChannelKind;
  begin(): Promise<void>;
  text(delta: string): void;
  status(label: string | null): void;
  resetIteration(): void; // discard text from a model call that was not persisted (also on the 03 R1 'retry' block-start)
  commitIteration(): void; // that call's assistant row is persisted
  checkpoint(): Promise<void>; // flush visible text as real message(s); later text uses a new draft_id
  finalize(o: { footerLines: string[]; effects: Effect[]; allowedLinkHosts: ReadonlySet<string>; allowedEmails: ReadonlySet<string> }): Promise<SentRef[]>;
  stopped(): Promise<void>; // Stop: send partial + "⏹ Stopped"
  fail(message: string, retryButton: boolean): Promise<void>;
  /**
   * WP0 addition (03 R1/R6, R8 → WP2): the engine forwards every transport `onBlockStart` signal here.
   *  - {index:-1, type:'retry'}            → discard the partial text of the current model call (same as resetIteration())
   *  - {index:-1, type:'busy', name:'<s>'} → show "⏳ Busy — retrying in <s>s" (strings key 'busy_retrying') as the status
   *  - index ≥ 0 (a content block starts)  → e.g. type 'thinking' may show <tg-thinking>; others may be ignored
   */
  blockStart(b: { index: number; type: string; name?: string }): void;
  readonly visibleText: string;
}
export interface ChannelFactory { forRun(run: RunRow, conv: ConversationRow, onDraft: (draftId: number) => void): ReplyChannel }
export interface TelegramModule {
  gateway: TelegramGateway; bot: Bot; channels: ChannelFactory;
  webhookHandler(req: Request): Promise<Response>;
  startIngress(): Promise<void>;
  stopIngress(): Promise<void>;
  /** `lagMs()` (WP0 addition, /healthz): age of the oldest queued tg_updates row, 0 when the inbox is empty. */
  dispatcher: { start(): void; stop(): Promise<void>; drain(): Promise<void>; lagMs(): number };
}

/** 01 §4.5 ALLOWED_UPDATES, in the spec's order (WP0 addition: exported here so WP2 ingress and WP1's admin `set-webhook` share it). */
export const ALLOWED_UPDATES_ALL: readonly string[] = Object.freeze([
  'message', 'edited_message', 'callback_query', 'guest_message', 'stopped_message_generation', 'business_connection', 'business_message',
  'edited_business_message', 'deleted_business_messages', 'my_chat_member', 'pre_checkout_query', 'subscription', 'message_reaction',
]);
/** The feature-filtered list passed to setWebhook / getUpdates: business_* dropped when FEATURE_BUSINESS=false, guest_message when FEATURE_GUEST=false. */
export function allowedUpdates(f: { business: boolean; guest: boolean }): string[] {
  return ALLOWED_UPDATES_ALL.filter((u) => (f.business || !u.includes('business')) && (f.guest || u !== 'guest_message'));
}
