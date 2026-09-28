// test/harness/fakeTelegram.ts (WP0) — a recording grammY transformer with realistic canned results (01 §15.1).
// Install it FIRST (innermost): bot.api.config.use(fake.transformer); the limiter and autoRetry installed after wrap it.
import { Bot, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { NetworkDisabledError } from '../../src/kernel/errors.ts';

export const TEST_TOKEN = 'TEST_TOKEN';
export const TEST_BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'Gora',
  username: 'gora_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  supports_guest_queries: true,
  can_connect_to_business: true,
  has_main_web_app: true,
  has_topics_enabled: true,
  allows_users_to_create_topics: true,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface TgCall { method: string; payload: any; at: number; result?: unknown; error?: { error_code: number; description: string } }
export interface TgError { error_code: number; description: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } }

export interface FakeTelegram {
  transformer: Transformer; // install FIRST (innermost); the limiter and autoRetry wrap it
  calls: TgCall[];
  byMethod(m: string): any[];
  /** Calls of any of the given methods, in order. */
  callsOf(...methods: string[]): TgCall[];
  failNext(method: string, err: TgError, times?: number): void;
  setResult(method: string, fn: (payload: any) => unknown): void;
  fileBytes: Map<string /* file_path */, Uint8Array>; // served by `fetch` for downloads
  /** Registers a downloadable file: getFile(fileId) → file_path, and fetch serves the bytes. */
  addFile(fileId: string, bytes: Uint8Array, filePath?: string): string;
  /** fetch for adapters: serves <apiRoot>/file/bot<token>/<file_path> from fileBytes; everything else throws NetworkDisabledError. */
  fetch: typeof fetch;
  /** Last draft_id sent with sendRichMessageDraft / sendMessageDraft (for pressStop). */
  lastDraftId(): number | null;
  reset(): void;
}

export function createFakeTelegram(o: { now?: () => number } = {}): FakeTelegram {
  const now = o.now ?? (() => Date.now());
  const calls: TgCall[] = [];
  const failures = new Map<string, TgError[]>();
  const custom = new Map<string, (payload: any) => unknown>();
  const fileBytes = new Map<string, Uint8Array>();
  const filePaths = new Map<string, string>();
  const n = { msg: 0, eph: 0, thread: 1000, inline: 0, file: 0, invoice: 0 };

  const chatOf = (payload: any) => {
    const id = payload?.chat_id;
    if (typeof id === 'number' && id > 0) return { id, type: 'private' as const, first_name: 'User' };
    if (typeof id === 'string') return { id: -1, type: 'channel' as const, title: id };
    return { id: id ?? 0, type: 'supergroup' as const, title: 'Group', is_forum: false };
  };
  const sentMessage = (method: string, payload: any) => {
    const date = Math.floor(now() / 1000);
    const base: Record<string, unknown> = { date, chat: chatOf(payload) };
    if (payload?.message_thread_id) base['message_thread_id'] = payload.message_thread_id;
    if (payload?.business_connection_id) base['business_connection_id'] = payload.business_connection_id;
    if (payload?.reply_markup) base['reply_markup'] = payload.reply_markup;
    if (payload?.ephemeral_message_parameters) return { ...base, message_id: 0, ephemeral_message_id: ++n.eph, text: payload.text ?? '' };
    const message_id = ++n.msg;
    switch (method) {
      case 'sendMessage':
        return { ...base, message_id, text: payload.text ?? '', ...(payload.entities ? { entities: payload.entities } : {}) };
      case 'sendRichMessage':
        return { ...base, message_id, text: payload.rich_message?.markdown ?? '' };
      case 'sendVenue':
        return { ...base, message_id, venue: { location: { latitude: payload.latitude, longitude: payload.longitude }, title: payload.title, address: payload.address } };
      case 'sendPoll':
        return { ...base, message_id, poll: { id: `poll_${message_id}`, question: payload.question, options: [], total_voter_count: 0, is_closed: false, is_anonymous: true, type: 'regular', allows_multiple_answers: !!payload.allows_multiple_answers } };
      case 'sendDocument':
        return { ...base, message_id, document: { file_id: `doc_${message_id}`, file_unique_id: `udoc_${message_id}` } };
      case 'sendPhoto':
        return { ...base, message_id, photo: [{ file_id: `photo_${message_id}`, file_unique_id: `uphoto_${message_id}`, width: 1, height: 1 }] };
      case 'sendVoice':
        return { ...base, message_id, voice: { file_id: `voice_${message_id}`, file_unique_id: `uvoice_${message_id}`, duration: payload.duration ?? 1 } };
      default:
        return { ...base, message_id };
    }
  };

  const canned = (method: string, payload: any): unknown => {
    const c = custom.get(method);
    if (c) return c(payload);
    switch (method) {
      case 'sendMessage':
      case 'sendRichMessage':
      case 'sendVenue':
      case 'sendPoll':
      case 'sendDocument':
      case 'sendPhoto':
      case 'sendVoice':
      case 'sendAudio':
      case 'sendLocation':
      case 'copyMessage':
        return sentMessage(method, payload);
      case 'createForumTopic':
        return { message_thread_id: ++n.thread, name: payload.name, icon_color: payload.icon_color ?? 7322096 };
      case 'answerGuestQuery':
        return { inline_message_id: `im_${++n.inline}` };
      case 'getFile': {
        const path = filePaths.get(payload.file_id) ?? `voice/file_${++n.file}.oga`;
        const bytes = fileBytes.get(path);
        return { file_id: payload.file_id, file_unique_id: `u_${payload.file_id}`, file_size: bytes?.length ?? 1024, file_path: path };
      }
      case 'createInvoiceLink':
        return `https://t.me/$inv_${++n.invoice}`;
      case 'getChatMember':
        return { status: 'member', user: { id: payload.user_id, is_bot: false, first_name: 'Member' } };
      case 'getMe':
        return TEST_BOT_INFO;
      case 'getUpdates':
        return [];
      case 'getWebhookInfo':
        return { url: '', has_custom_certificate: false, pending_update_count: 0 };
      default:
        return true;
    }
  };

  const transformer: Transformer = async (_prev, method, payload) => {
    const call: TgCall = { method, payload: payload ?? {}, at: now() };
    calls.push(call);
    const q = failures.get(method);
    if (q && q.length) {
      const err = q.shift()!;
      call.error = { error_code: err.error_code, description: err.description };
      return { ok: false, error_code: err.error_code, description: err.description, ...(err.parameters ? { parameters: err.parameters } : {}) } as any;
    }
    const result = canned(method, payload);
    call.result = result;
    return { ok: true, result } as any;
  };

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = /\/file\/bot[^/]+\/(.+)$/.exec(new URL(url).pathname);
    if (m) {
      const bytes = fileBytes.get(decodeURIComponent(m[1]!));
      if (!bytes) return new Response('Not Found', { status: 404 });
      return new Response(bytes.slice().buffer, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    throw new NetworkDisabledError(url);
  }) as typeof fetch;

  return {
    transformer,
    calls,
    byMethod: (m) => calls.filter((c) => c.method === m).map((c) => c.payload),
    callsOf: (...methods) => calls.filter((c) => methods.includes(c.method)),
    failNext(method, err, times = 1) {
      const q = failures.get(method) ?? [];
      for (let i = 0; i < times; i++) q.push(err);
      failures.set(method, q);
    },
    setResult(method, fn) {
      custom.set(method, fn);
    },
    fileBytes,
    addFile(fileId, bytes, filePath) {
      const p = filePath ?? `documents/file_${++n.file}`;
      filePaths.set(fileId, p);
      fileBytes.set(p, bytes);
      return p;
    },
    fetch: fetchImpl,
    lastDraftId() {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i]!;
        if ((c.method === 'sendRichMessageDraft' || c.method === 'sendMessageDraft') && typeof c.payload.draft_id === 'number') return c.payload.draft_id;
      }
      return null;
    },
    reset() {
      calls.length = 0;
      failures.clear();
      custom.clear();
    },
  };
}

/** A grammY Bot wired to a FakeTelegram (no getMe; no network). */
export function createTestBot(fake: FakeTelegram, botInfo: UserFromGetMe = TEST_BOT_INFO): Bot {
  const bot = new Bot(TEST_TOKEN, { botInfo });
  bot.api.config.use(fake.transformer);
  return bot;
}
