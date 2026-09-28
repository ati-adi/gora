// telegram/limiter.ts (WP2) — outgoing rate limits and retries as grammY transformers (01 §4.1 "limiter transformer and
// auto-retry"; transformer order fake → limiter → autoRetry, the last installed runs first).
//
// Limiter (per 01 §15.2 outbox test and the Bot API FAQ):
//   - private chat: ≥ 1 s spacing with a burst of 3 (token bucket, capacity 3, 1 token/s);
//   - group/supergroup: ≤ 20 messages per rolling minute;
//   - global: ≤ 30 messages per rolling second;
//   - a 429 `retry_after` blocks that chat until it expires.
// Only message-producing methods count (drafts and chat actions have their own throttle in the channels).
// `enforce=false` (NODE_ENV=test, see 04 notes) keeps the bookkeeping but never waits, so FakeClock e2e tests cannot stall.
//
// autoRetry: a Clock-based equivalent of @grammyjs/auto-retry (which sleeps on real timers and would bypass the Clock):
// 429 → sleep retry_after (≤ maxDelaySec) and retry; 5xx / network → exponential backoff from 3 s; ≤ maxRetries attempts.
// Drafts, chat actions and callback / pre-checkout answers are never retried (⚠U3 must see the 429; answers are time-bound).
import { HttpError, type Transformer } from 'grammy';
import type { Clock, Logger } from '../contracts/index.ts';

export const COUNTED_METHODS: ReadonlySet<string> = new Set([
  'sendMessage', 'sendRichMessage', 'sendVenue', 'sendPoll', 'sendDocument', 'sendPhoto', 'sendVoice', 'sendAudio', 'sendVideo',
  'sendAnimation', 'sendVideoNote', 'sendSticker', 'sendLocation', 'sendContact', 'sendDice', 'sendMediaGroup', 'sendInvoice',
  'copyMessage', 'forwardMessage', 'sendChecklist',
]);
export const NO_RETRY_METHODS: ReadonlySet<string> = new Set([
  'sendMessageDraft', 'sendRichMessageDraft', 'sendChatAction', 'answerCallbackQuery', 'answerPreCheckoutQuery', 'getUpdates',
]);

export interface Limiter {
  transformer: Transformer;
  /** ms until a counted send to this chat may go out (0 = now). Always 0 when not enforcing. */
  waitMs(chatId: number, businessConnectionId?: string): number;
  /** Records a 429 for the chat: nothing more is sent there before retry_after elapses. */
  block(chatId: number, retryAfterSec: number, businessConnectionId?: string): void;
  readonly enforce: boolean;
}

interface ChatState { tokens: number; at: number; recent: number[]; blockedUntil: number }

export function createLimiter(o: { clock: Clock; enforce: boolean; log?: Logger }): Limiter {
  const { clock } = o;
  const chats = new Map<string, ChatState>();
  const global: number[] = [];
  const keyOf = (chatId: number, bc?: string) => (bc ? `b:${bc}:${chatId}` : String(chatId));
  const state = (k: string): ChatState => {
    let s = chats.get(k);
    if (!s) {
      s = { tokens: 3, at: clock.now(), recent: [], blockedUntil: 0 };
      chats.set(k, s);
      if (chats.size > 50_000) chats.delete(chats.keys().next().value!); // bounded memory
    }
    return s;
  };
  const prune = (arr: number[], windowMs: number, now: number) => {
    while (arr.length && arr[0]! <= now - windowMs) arr.shift();
  };

  const computeWait = (chatId: number, bc: string | undefined): number => {
    const now = clock.now();
    const s = state(keyOf(chatId, bc));
    let wait = Math.max(0, s.blockedUntil - now);
    if (chatId > 0) {
      const tokens = Math.min(3, s.tokens + (now - s.at) / 1000);
      if (tokens < 1) wait = Math.max(wait, Math.ceil((1 - tokens) * 1000));
    } else {
      prune(s.recent, 60_000, now);
      if (s.recent.length >= 20) wait = Math.max(wait, s.recent[0]! + 60_000 - now);
    }
    prune(global, 1000, now);
    if (global.length >= 30) wait = Math.max(wait, global[0]! + 1000 - now);
    return wait;
  };
  const take = (chatId: number, bc: string | undefined) => {
    const now = clock.now();
    const s = state(keyOf(chatId, bc));
    if (chatId > 0) {
      s.tokens = Math.min(3, s.tokens + (now - s.at) / 1000) - 1;
      s.at = now;
    } else s.recent.push(now);
    global.push(now);
  };

  const limiter: Limiter = {
    enforce: o.enforce,
    waitMs: (chatId, bc) => (o.enforce ? computeWait(chatId, bc) : 0),
    block(chatId, retryAfterSec, bc) {
      const s = state(keyOf(chatId, bc));
      s.blockedUntil = Math.max(s.blockedUntil, clock.now() + Math.max(1, retryAfterSec) * 1000);
    },
    transformer: async (prev, method, payload, signal) => {
      const p = (payload ?? {}) as { chat_id?: unknown; business_connection_id?: unknown };
      const chatId = typeof p.chat_id === 'number' ? p.chat_id : null;
      const bc = typeof p.business_connection_id === 'string' ? p.business_connection_id : undefined;
      if (chatId !== null && COUNTED_METHODS.has(method)) {
        if (o.enforce) {
          for (let w = computeWait(chatId, bc); w > 0; w = computeWait(chatId, bc)) await clock.sleep(w, signal as unknown as AbortSignal | undefined);
        }
        take(chatId, bc);
      }
      const res = await prev(method, payload, signal);
      if (chatId !== null && !res.ok && res.error_code === 429) {
        limiter.block(chatId, res.parameters?.retry_after ?? 1, bc);
        o.log?.warn({ method, retryAfter: res.parameters?.retry_after ?? null }, 'telegram 429');
      }
      return res;
    },
  };
  return limiter;
}

export function createAutoRetry(o: { clock: Clock; maxRetries?: number; maxDelaySec?: number; log?: Logger }): Transformer {
  const maxRetries = o.maxRetries ?? 3;
  const maxDelaySec = o.maxDelaySec ?? 30;
  return async (prev, method, payload, signal) => {
    let backoff = 3;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await prev(method, payload, signal);
      } catch (e) {
        if (!(e instanceof HttpError) || NO_RETRY_METHODS.has(method) || attempt >= maxRetries || signal?.aborted) throw e;
        o.log?.warn({ method, attempt }, 'telegram network error; retrying');
        await o.clock.sleep(backoff * 1000, signal as unknown as AbortSignal | undefined);
        backoff = Math.min(backoff * 2, 60);
        continue;
      }
      if (res.ok || NO_RETRY_METHODS.has(method) || attempt >= maxRetries) return res;
      if (res.error_code === 429) {
        const after = res.parameters?.retry_after ?? 1;
        if (after > maxDelaySec) return res; // the caller (outbox) reschedules instead of blocking
        await o.clock.sleep(after * 1000, signal as unknown as AbortSignal | undefined);
        continue;
      }
      if (res.error_code >= 500) {
        await o.clock.sleep(backoff * 1000, signal as unknown as AbortSignal | undefined);
        backoff = Math.min(backoff * 2, 60);
        continue;
      }
      return res;
    }
  };
}
