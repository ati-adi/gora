// telegram/outbox.ts (WP2) — the durable sender (01 §4.1, §4.4 Outbox; table `outbox`).
//   - enqueue() is idempotent per idempotencyKey (UNIQUE); the payload (+ markdown) is sealed under 'u:<userId>' or 'sys'
//     with AAD 'outbox|payload_enc|<id>';
//   - each chat (chat_id + business connection) is a FIFO queue: a row goes out only when no earlier row of that chat is
//     still being sent, due, or waiting for a retry (review F4; a never-tried row scheduled for later does not hold the
//     chat). sendNow() respects the same order: it sends a due predecessor first, waits for one in flight, and throws
//     OutboxPendingError when a predecessor waits for a retry (the worker sends both, in order);
//   - different chats are sent CONCURRENTLY, one worker per chat (review F5), so a chat whose send sleeps inside autoRetry
//     (429 retry_after, 5xx backoff) never holds up another chat; a chat that the limiter says must wait is skipped until
//     then; heads are picked by (priority ASC, not_before, insertion order);
//   - a markdown row that produces several messages records each one as it goes (sent_message_ids) and a retry resumes
//     after them (review F3);
//   - `markdown` rows use the rich → entities → plain chain (sends and edits); binary methods load `payload.blob_id`;
//   - 429 → re-queued at retry_after; "message is not modified" → sent; other 400/403 → dead (403 in the user's own DM
//     chat, not a business-connection send, marks users.bot_blocked — review F11); 5xx / network → exponential backoff,
//     dead after 8 attempts;
//   - ⚠U7: a 400 from editMessageReplyMarkup sets a ✍ reaction on `payload.fallback_reaction_to` (or the message) instead;
//   - onSent(refKind) hooks run after every successful send.
import { GrammyError, HttpError, InputFile, type Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Clock, CoreRepos, Crypto, Db, Logger, Ms, Outbox, OutboxMethod, OutboxRequest, SentRef } from '../contracts/index.ts';
import { newId } from '../kernel/ids.ts';
import type { Limiter } from './limiter.ts';
import { editMarkdownChain, errInfo, isBadRequest, isNotModified, rawOf, sendMarkdownChain } from './render/fallback.ts';

const MAX_ATTEMPTS = 8;

/** sendNow(): the row is still queued (a transient failure, or an earlier row of the chat waits for a retry); the worker sends it. */
export class OutboxPendingError extends Error {
  override name = 'OutboxPendingError';
  readonly idempotencyKey: string;
  readonly reason: unknown;
  constructor(idempotencyKey: string, reason?: unknown) {
    super('outbox row queued for a later retry');
    this.idempotencyKey = idempotencyKey;
    this.reason = reason;
  }
}
export function isOutboxPending(e: unknown): boolean {
  return e instanceof OutboxPendingError || (e instanceof Error && e.name === 'OutboxPendingError');
}
const BINARY_FIELD: Partial<Record<OutboxMethod, string>> = { sendDocument: 'document', sendPhoto: 'photo', sendVoice: 'voice' };
const THREADED: ReadonlySet<OutboxMethod> = new Set(['sendRichMessage', 'sendMessage', 'sendVenue', 'sendPoll', 'sendChatAction', 'sendDocument', 'sendPhoto', 'sendVoice', 'editForumTopic']);

interface Row {
  id: string; idempotency_key: string; user_id: string | null; chat_id: number; thread_id: number | null; business_connection_id: string | null;
  method: string; payload_enc: Uint8Array | null; priority: number; disable_notification: number; not_before: number; ref_kind: string | null;
  ref_id: string | null; status: string; attempts: number; sent_message_ids: string | null;
}
interface Body { payload: Record<string, unknown>; markdown?: string }

export interface OutboxImpl extends Outbox {
  /** §11.9 retention: payloads nulled after 24 h (stale queued rows cancelled), rows deleted after 7 days. */
  retention(now: Ms): void;
  /** Status of a row by idempotency key (tests, recovery). */
  statusOf(idempotencyKey: string): string | null;
}

export function createOutbox(d: {
  db: Db; crypto: Crypto; clock: Clock; log: Logger; api: () => Api; limiter: Limiter; repos: () => CoreRepos; businessRich: boolean; tickMs?: number;
  /** Spec 05 C1 (friend foundation): the owner blocked Gora (403 in their own DM) → SignalsService.blocked. */
  onBlocked?: (userId: string) => void;
}): OutboxImpl {
  const { db, crypto, clock, log } = d;
  const hooks = new Map<string, Array<(refId: string, sent: SentRef[]) => void>>();
  const inflight = new Map<string, Promise<SentRef[]>>();
  const tickMs = d.tickMs ?? 5000;
  let running = false;
  let timer: unknown = null;
  let timerAt = Infinity;
  let pumping: Promise<number> | null = null;
  let again = false;

  const aad = (id: string) => `outbox|payload_enc|${id}`;
  const selectCols = 'id, idempotency_key, user_id, chat_id, thread_id, business_connection_id, method, payload_enc, priority, disable_notification, not_before, ref_kind, ref_id, status, attempts, sent_message_ids';
  const byKey = (k: string) => db.prepare(`SELECT ${selectCols} FROM outbox WHERE idempotency_key = ?`).get<Row>(k);
  const byId = (id: string) => db.prepare(`SELECT ${selectCols} FROM outbox WHERE id = ?`).get<Row>(id);
  const parseSent = (r: Row): SentRef[] => {
    try {
      return r.sent_message_ids ? (JSON.parse(r.sent_message_ids) as SentRef[]) : [];
    } catch {
      return [];
    }
  };

  function enqueue(r: OutboxRequest): string {
    const existing = byKey(r.idempotencyKey);
    if (existing) return existing.id;
    const now = clock.now();
    const id = newId('ob', now);
    const body: Body = { payload: r.payload ?? {}, ...(r.markdown !== undefined ? { markdown: r.markdown } : {}) };
    const enc = crypto.sealJson(r.userId ? `u:${r.userId}` : 'sys', body, aad(id));
    const res = db
      .prepare(`INSERT OR IGNORE INTO outbox (id, idempotency_key, user_id, chat_id, thread_id, business_connection_id, method, payload_enc, priority,
                disable_notification, not_before, ref_kind, ref_id, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`)
      .run(id, r.idempotencyKey, r.userId ?? null, r.chatId, r.threadId ?? null, r.businessConnectionId ?? null, r.method, enc, r.priority ?? 5,
        r.disableNotification ? 1 : 0, r.notBefore ?? now, r.refKind ?? null, r.refId ?? null, now);
    if (Number(res.changes) === 0) return byKey(r.idempotencyKey)!.id;
    wake(r.notBefore ?? now);
    return id;
  }

  /** CAS queued → sending, then sends. Resolves with the refs; rejects on a failed attempt (the row keeps its new state). */
  function sendRow(id: string): Promise<SentRef[]> {
    const cur = inflight.get(id);
    if (cur) return cur;
    const p = (async () => {
      const claimed = db.prepare(`UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).run(id);
      const row = byId(id);
      if (!row) throw new Error('outbox row vanished');
      if (Number(claimed.changes) !== 1) {
        if (row.status === 'sent') return parseSent(row);
        throw new Error(`outbox row not sendable (${row.status})`);
      }
      return deliver(row);
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  async function deliver(row: Row): Promise<SentRef[]> {
    const now = clock.now();
    let body: Body;
    try {
      if (!row.payload_enc) throw new Error('payload expired');
      body = crypto.openJson<Body>(row.payload_enc, aad(row.id));
    } catch (e) {
      markDead(row, `payload: ${e instanceof Error ? e.name : 'error'}`);
      throw e;
    }
    try {
      const sent = await callTelegram(row, body, parseSent(row));
      db.prepare(`UPDATE outbox SET status = 'sent', sent_at = ?, sent_message_ids = ?, last_error = NULL WHERE id = ?`).run(now, JSON.stringify(sent), row.id);
      if (row.ref_kind && row.ref_id) {
        for (const h of hooks.get(row.ref_kind) ?? []) {
          try {
            h(row.ref_id, sent);
          } catch (e) {
            log.error({ refKind: row.ref_kind, err: e instanceof Error ? e.name : 'error' }, 'outbox onSent hook failed');
          }
        }
      }
      return sent;
    } catch (e) {
      handleError(row, e);
      throw e;
    }
  }

  function markDead(row: Row, why: string) {
    db.prepare(`UPDATE outbox SET status = 'dead', last_error = ? WHERE id = ?`).run(why.slice(0, 300), row.id);
    log.warn({ outboxId: row.id, method: row.method, why: why.slice(0, 120) }, 'outbox row dead');
  }

  function handleError(row: Row, e: unknown) {
    const now = clock.now();
    if (e instanceof GrammyError) {
      if (e.error_code === 429) {
        const after = e.parameters.retry_after ?? 5;
        d.limiter.block(row.chat_id, after, row.business_connection_id ?? undefined);
        db.prepare(`UPDATE outbox SET status = 'queued', not_before = ?, last_error = ? WHERE id = ?`).run(now + after * 1000, `429 retry_after=${after}`, row.id);
        wake(now + after * 1000);
        return;
      }
      if (e.error_code === 403) {
        markDead(row, `403 ${e.description}`);
        // only a 403 in the user's OWN private chat means they blocked Gora (not a Secretary send to a peer, not a group)
        if (row.chat_id > 0 && row.user_id && !row.business_connection_id) {
          try {
            const u = d.repos().users.getById(row.user_id);
            if (u && (u.dmChatId === row.chat_id || u.tgUserId === row.chat_id)) {
              d.repos().users.update(row.user_id, { botBlocked: true });
              d.onBlocked?.(row.user_id);
            }
          } catch {
            /* best effort */
          }
        }
        return;
      }
      if (e.error_code >= 400 && e.error_code < 500) {
        markDead(row, `${e.error_code} ${e.description}`);
        return;
      }
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      markDead(row, errInfo(e));
      return;
    }
    const delay = Math.min(2000 * 2 ** Math.max(0, row.attempts - 1), 5 * 60_000);
    const why = e instanceof HttpError ? 'network' : e instanceof GrammyError ? `${e.error_code}` : e instanceof Error ? e.name : 'error';
    db.prepare(`UPDATE outbox SET status = 'queued', not_before = ?, last_error = ? WHERE id = ?`).run(now + delay, why, row.id);
    wake(now + delay);
  }

  async function callTelegram(row: Row, body: Body, done: SentRef[]): Promise<SentRef[]> {
    const api = d.api();
    const raw = rawOf(api);
    const method = row.method as OutboxMethod;
    const p = { ...body.payload };
    const inlineId = typeof p['inline_message_id'] === 'string' ? (p['inline_message_id'] as string) : null;
    const bc = row.business_connection_id ?? undefined;
    const replyMarkup = p['reply_markup'] as InlineKeyboardMarkup | undefined;
    const silent = row.disable_notification === 1;

    if (body.markdown !== undefined && (method === 'sendRichMessage' || method === 'sendMessage')) {
      const rp = p['reply_parameters'] as { message_id?: number } | undefined;
      return sendMarkdownChain(
        api,
        { chatId: row.chat_id, ...(row.thread_id ? { threadId: row.thread_id } : {}), ...(bc ? { businessConnectionId: bc } : {}), ...(rp?.message_id ? { replyTo: rp.message_id } : {}) },
        body.markdown,
        { ...(replyMarkup ? { replyMarkup } : {}), silent, allowRich: method === 'sendRichMessage' && (!bc || d.businessRich) },
        {
          done,
          // persist every message as it goes out, so a retry after a transient failure never re-sends it (review F3)
          onSent: (sent) => db.prepare(`UPDATE outbox SET sent_message_ids = ? WHERE id = ?`).run(JSON.stringify(sent), row.id),
        },
      );
    }
    if (body.markdown !== undefined && method === 'editMessageText') {
      const target = inlineId ? { inlineMessageId: inlineId } : { chatId: row.chat_id, messageId: Number(p['message_id']), ...(bc ? { businessConnectionId: bc } : {}) };
      const kind = await editMarkdownChain(api, target, body.markdown, { ...(replyMarkup ? { replyMarkup } : {}), allowRich: !bc || d.businessRich });
      return inlineId ? [] : [{ chatId: row.chat_id, messageId: Number(p['message_id']), kind: kind === 'rich' ? 'rich' : kind === 'entities' ? 'entities' : 'plain' }];
    }

    const params: Record<string, unknown> = inlineId ? {} : { chat_id: row.chat_id };
    if (!inlineId && row.thread_id && THREADED.has(method)) params['message_thread_id'] = row.thread_id;
    if (bc) params['business_connection_id'] = bc;
    if (silent && method.startsWith('send') && method !== 'sendChatAction') params['disable_notification'] = true;
    const fallbackReaction = p['fallback_reaction_to'];
    delete p['fallback_reaction_to'];

    const field = BINARY_FIELD[method];
    if (field) {
      const blobId = String(p['blob_id'] ?? '');
      const filename = String(p['filename'] ?? field);
      delete p['blob_id'];
      delete p['filename'];
      const blob = blobId ? d.repos().messages.getBlob(blobId) : undefined;
      if (!blob) throw new GrammyError('blob missing', { ok: false, error_code: 400, description: 'Bad Request: blob missing' }, method, params);
      Object.assign(params, p, { [field]: new InputFile(blob.bytes, filename) });
    } else Object.assign(params, p);

    let res: unknown;
    try {
      res = await raw[method]!(params);
    } catch (e) {
      if (isNotModified(e)) return [];
      if (method === 'editMessageReplyMarkup' && isBadRequest(e) && !inlineId) {
        // ⚠U7: markup edits on rich messages may be refused — acknowledge with a ✍ reaction instead
        const target = typeof fallbackReaction === 'number' ? fallbackReaction : Number(p['message_id']);
        await raw['setMessageReaction']!({ chat_id: row.chat_id, message_id: target, reaction: [{ type: 'emoji', emoji: '✍' }] });
        return [];
      }
      throw e;
    }
    const mid = res && typeof res === 'object' && typeof (res as { message_id?: unknown }).message_id === 'number' ? (res as { message_id: number }).message_id : null;
    if (mid !== null) return [{ chatId: row.chat_id, messageId: mid, kind: method === 'sendRichMessage' ? 'rich' : 'plain' }];
    if (!inlineId && (method === 'editMessageText' || method === 'editMessageReplyMarkup') && typeof p['message_id'] === 'number') {
      return [{ chatId: row.chat_id, messageId: p['message_id'] as number, kind: 'plain' }];
    }
    return [];
  }

  // ── worker: one FIFO queue per chat, chats in parallel

  const chatKey = (r: Pick<Row, 'chat_id' | 'business_connection_id'>) => `${r.chat_id}|${r.business_connection_id ?? ''}`;
  /** A row that holds later rows of its chat: being sent, due, or already tried and waiting for its retry. */
  const HOLDS = `p.status IN ('queued','sending') AND p.chat_id = o.chat_id AND IFNULL(p.business_connection_id, '') = IFNULL(o.business_connection_id, '')
                 AND p.rowid < o.rowid AND (p.status = 'sending' OR p.attempts > 0 OR p.not_before <= ?)`;

  /** Due rows that are the head of their chat's queue (at most one per chat). */
  function dueHeads(now: Ms, limit: number): Row[] {
    return db
      .prepare(`SELECT ${selectCols} FROM outbox o WHERE o.status = 'queued' AND o.not_before <= ? AND NOT EXISTS (SELECT 1 FROM outbox p WHERE ${HOLDS})
                ORDER BY o.priority, o.not_before, o.rowid LIMIT ?`)
      .all<Row>(now, now, limit);
  }
  function dueHeadOf(chatId: number, bc: string | null, now: Ms): Row | undefined {
    return db
      .prepare(`SELECT ${selectCols} FROM outbox o WHERE o.status = 'queued' AND o.not_before <= ? AND o.chat_id = ? AND IFNULL(o.business_connection_id, '') = ?
                AND NOT EXISTS (SELECT 1 FROM outbox p WHERE ${HOLDS}) ORDER BY o.rowid LIMIT 1`)
      .get<Row>(now, chatId, bc ?? '', now);
  }
  /** The earliest row that holds `id` back, if any. */
  function blockerOf(id: string, now: Ms): Row | undefined {
    return db
      .prepare(`SELECT ${selectCols.split(', ').map((c) => `p.${c}`).join(', ')} FROM outbox o JOIN outbox p ON ${HOLDS} WHERE o.id = ? ORDER BY p.rowid LIMIT 1`)
      .get<Row>(now, id);
  }
  function nextNotBefore(now: Ms): Ms | null {
    const r = db.prepare(`SELECT MIN(not_before) AS t FROM outbox WHERE status = 'queued' AND not_before > ?`).get<{ t: number | null }>(now);
    return r?.t ?? null;
  }

  const workers = new Map<string, Promise<number>>();

  /** Sends one chat's due rows in order until none is due, the limiter says wait, or the head could not be sent. */
  async function runChat(chatId: number, bc: string | null): Promise<number> {
    let sent = 0;
    let lastFailed: string | null = null;
    for (let i = 0; i < 100_000; i++) {
      const head = dueHeadOf(chatId, bc, clock.now());
      if (!head) break;
      const w = d.limiter.waitMs(chatId, bc ?? undefined);
      if (w > 0) {
        wake(clock.now() + w);
        break;
      }
      try {
        await sendRow(head.id);
        sent++;
        lastFailed = null;
      } catch {
        // state already recorded: re-queued for later (it now holds the chat) or dead (the next row may go)
        if (lastFailed === head.id) break;
        lastFailed = head.id;
      }
    }
    return sent;
  }

  /** Starts a worker for every chat with a due head (none twice); returns the workers covering those chats. */
  function startWorkers(): Array<Promise<number>> {
    const out: Array<Promise<number>> = [];
    for (const head of dueHeads(clock.now(), 1000)) {
      const k = chatKey(head);
      let w = workers.get(k);
      if (!w) {
        w = runChat(head.chat_id, head.business_connection_id)
          .catch(() => 0)
          .finally(() => {
            workers.delete(k);
            rearm();
          });
        workers.set(k, w);
      }
      out.push(w);
    }
    return out;
  }

  /** flush(): every row due now, awaited. Returns the number sent. */
  async function sweep(): Promise<number> {
    let total = 0;
    for (let round = 0; round < 1000; round++) {
      const ws = startWorkers();
      if (!ws.length) break;
      const n = (await Promise.all(ws)).reduce((a, b) => a + b, 0);
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  /** The next wake-up for rows that are not due yet (retries, scheduled rows). */
  function rearm() {
    if (!running) return;
    const nb = nextNotBefore(clock.now());
    if (nb !== null) wake(nb);
  }

  function wake(at: Ms) {
    if (!running) return;
    const now = clock.now();
    const when = Math.max(now, at);
    if (timer !== null && timerAt <= when) return;
    if (timer !== null) d.clock.clearTimeout(timer);
    timerAt = when;
    timer = clock.setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      if (!running) return;
      startWorkers();
      rearm();
      if (running && timer === null) {
        // a periodic safety net (rows enqueued by another process, a missed wake-up)
        timerAt = clock.now() + tickMs;
        timer = clock.setTimeout(() => {
          timer = null;
          timerAt = Infinity;
          if (running) wake(clock.now());
        }, tickMs);
      }
    }, when - now);
  }

  function runPump(): Promise<number> {
    if (pumping) {
      again = true;
      return pumping;
    }
    pumping = (async () => {
      let total = 0;
      do {
        again = false;
        total += await sweep();
      } while (again);
      return total;
    })().finally(() => {
      pumping = null;
      rearm();
    });
    return pumping;
  }

  /** sendNow(): sends `id` once no earlier row of its chat holds it (see the header). */
  async function sendInOrder(id: string, key: string): Promise<SentRef[]> {
    for (let guard = 0; guard < 1000; guard++) {
      const row = byId(id);
      if (!row) throw new Error('outbox row vanished');
      if (row.status === 'sent') return parseSent(row);
      if (row.status === 'dead' || row.status === 'cancelled') throw new Error(`outbox row ${row.status}`);
      if (row.status === 'sending') {
        const p = inflight.get(id);
        if (!p) throw new OutboxPendingError(key);
        return p;
      }
      const now = clock.now();
      const b = blockerOf(id, now);
      if (!b) {
        try {
          return await sendRow(id);
        } catch (e) {
          if (byId(id)?.status === 'queued') throw new OutboxPendingError(key, e);
          throw e;
        }
      }
      if (b.status === 'sending') {
        const p = inflight.get(b.id);
        if (!p) throw new OutboxPendingError(key); // another process / a crashed attempt: the worker sorts it out
        await p.catch(() => undefined);
        continue;
      }
      if (b.not_before <= now) {
        // a due predecessor that no worker has taken yet: it goes first
        await sendRow(b.id).catch(() => undefined);
        if (byId(b.id)?.status === 'queued' && byId(b.id)!.not_before > clock.now()) throw new OutboxPendingError(key);
        continue;
      }
      throw new OutboxPendingError(key); // the predecessor waits for its retry; the worker sends both, in order
    }
    throw new OutboxPendingError(key);
  }

  return {
    enqueue,
    async sendNow(r) {
      const id = enqueue(r);
      try {
        return await sendInOrder(id, r.idempotencyKey);
      } finally {
        wake(clock.now()); // rows of this chat that waited behind this one
      }
    },
    onSent(refKind, hook) {
      hooks.set(refKind, [...(hooks.get(refKind) ?? []), hook]);
    },
    start() {
      if (running) return;
      // rows a crashed process left in 'sending' are retried (idempotent per key; a duplicate is possible but rare)
      db.prepare(`UPDATE outbox SET status = 'queued' WHERE status = 'sending'`).run();
      running = true;
      wake(clock.now());
    },
    async stop() {
      running = false;
      if (timer !== null) d.clock.clearTimeout(timer);
      timer = null;
      timerAt = Infinity;
      if (pumping) await pumping.catch(() => 0);
      await Promise.allSettled([...workers.values()]);
      await Promise.allSettled([...inflight.values()]);
    },
    flush: () => runPump(),
    retention(now) {
      db.prepare(`UPDATE outbox SET status = 'cancelled', last_error = 'expired' WHERE status = 'queued' AND created_at < ?`).run(now - 24 * 3600_000);
      db.prepare(`UPDATE outbox SET payload_enc = NULL WHERE payload_enc IS NOT NULL AND status <> 'queued' AND status <> 'sending' AND created_at < ?`).run(now - 24 * 3600_000);
      db.prepare(`DELETE FROM outbox WHERE created_at < ? AND status <> 'sending'`).run(now - 7 * 24 * 3600_000);
    },
    statusOf: (k) => byKey(k)?.status ?? null,
  };
}
