// telegram/channels/common.ts (WP2) — shared pieces of the reply channels (01 §5.5): the final message assembly (sanitized
// model text + code-built footer + effect lines and buttons), durable final sends through the outbox (idempotency keys
// `run:<id>:<what>:<part>`, so a recovery re-send never duplicates), effects that are separate messages, and tg_links.
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import type { ConversationRow, Effect, OutboxRequest, RunRow, SentRef, Services, UserRow } from '../../contracts/index.ts';
import { scopeKey } from '../../contracts/index.ts';
import { isOutboxPending } from '../outbox.ts';
import { escapeMd } from '../render/escape.ts';
import { STATIC_LINK_HOSTS, type SanitizeCtx } from '../render/sanitize.ts';

export const STATIC_CTX: SanitizeCtx = Object.freeze({ allowedLinkHosts: new Set(STATIC_LINK_HOSTS), allowedEmails: new Set<string>() });
export const DRAFT_CTX: SanitizeCtx = Object.freeze({ allowedLinkHosts: new Set(STATIC_LINK_HOSTS), allowedEmails: new Set<string>(), draft: true });

export interface RunCtx {
  s: Services; run: RunRow; conv: ConversationRow; user: UserRow | undefined; lang: string | null | undefined;
  chatId: number; threadId: number | undefined; businessConnectionId: string | undefined; owner: number;
}

export function runCtx(s: Services, run: RunRow, conv: ConversationRow): RunCtx {
  const user = run.userId ? s.repos.users.getById(run.userId) : undefined;
  const ref = run.replyRef;
  const chatId = ref.chatId ?? conv.tgChatId ?? user?.dmChatId ?? user?.tgUserId ?? 0;
  const threadId = ref.threadId ?? conv.threadId ?? undefined;
  return {
    s, run, conv, user, lang: user?.languageCode, chatId, threadId: threadId || undefined,
    businessConnectionId: ref.businessConnectionId ?? conv.businessConnectionId ?? undefined,
    owner: user?.tgUserId ?? 0,
  };
}

/** Sanitizes model markdown with the run's allowlist (01 §11.4). */
export function sanitizeFor(c: RunCtx, md: string, ctx: SanitizeCtx = STATIC_CTX): string {
  return c.s.telegram.render.sanitize(md, ctx).trim();
}

/** Final markdown + keyboard from sanitized body, footer lines (code-built) and effects (lines, Undo buttons, button rows). */
export function assembleFinal(c: RunCtx, bodyMd: string, footerLines: string[], effects: Effect[], extraRows: InlineKeyboardButton[][] = []): { markdown: string; replyMarkup?: InlineKeyboardMarkup } {
  const lines: string[] = [...footerLines.filter((l) => l.trim())];
  const rows: InlineKeyboardButton[][] = [];
  for (const e of effects) {
    if (e.kind === 'line') {
      lines.push(e.markdown);
      if (e.undoId) {
        try {
          rows.push([{ text: c.s.strings.t('undo_button', c.lang), callback_data: c.s.telegram.codec.encode('ud', [e.undoId], c.owner) }]);
        } catch (err) {
          c.s.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'undo button could not be encoded');
        }
      }
    } else if (e.kind === 'buttons') rows.push(...e.rows);
  }
  rows.push(...extraRows);
  const parts = [bodyMd.trim(), lines.join('\n')].filter((p) => p.length > 0);
  return { markdown: parts.join('\n\n'), ...(rows.length ? { replyMarkup: { inline_keyboard: rows } } : {}) };
}

/**
 * Sends markdown through the outbox immediately, one row per split part (`run:<id>:<what>:<i>`), the keyboard on the last
 * part and the reply on the first. Every part is ENQUEUED before the first is sent (review F2): when a part hits a
 * transient failure (429 above autoRetry's cap, 5xx, network) the outbox keeps the chat's order and its worker delivers
 * that part and the rest later, so this returns the refs sent so far instead of dropping the tail. A part that is dead
 * (e.g. 403) still throws.
 */
export async function sendDurable(c: RunCtx, what: string, md: string, o: { replyMarkup?: InlineKeyboardMarkup; replyTo?: number; silent?: boolean; rich?: boolean } = {}): Promise<SentRef[]> {
  const parts = c.s.telegram.render.split(md);
  const reqs: OutboxRequest[] = parts.map((part, i) => {
    const last = i === parts.length - 1;
    return {
      idempotencyKey: `run:${c.run.id}:${what}:${i}`,
      ...(c.run.userId ? { userId: c.run.userId } : {}),
      chatId: c.chatId,
      ...(c.threadId ? { threadId: c.threadId } : {}),
      ...(c.businessConnectionId ? { businessConnectionId: c.businessConnectionId } : {}),
      method: o.rich === false ? 'sendMessage' : 'sendRichMessage',
      markdown: part,
      payload: {
        ...(last && o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
        ...(i === 0 && o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
      },
      priority: 1,
      ...(o.silent ? { disableNotification: true } : {}),
    };
  });
  for (const r of reqs) c.s.telegram.outbox.enqueue(r);
  const out: SentRef[] = [];
  for (const r of reqs) {
    try {
      out.push(...(await c.s.telegram.outbox.sendNow(r)));
    } catch (e) {
      if (!isOutboxPending(e)) throw e;
      c.s.log.warn({ runId: c.run.id, what, parts: reqs.length }, 'final part queued for retry: the outbox delivers the rest in order');
      break;
    }
  }
  return out;
}

export function recordLinks(c: RunCtx, refs: SentRef[], kind: string): void {
  const space = c.businessConnectionId ? `biz:${c.businessConnectionId}` : 'bot';
  refs.forEach((r, i) => {
    try {
      c.s.telegram.links.record({ space, chatId: r.chatId, messageId: r.messageId, kind, userId: c.run.userId, conversationId: c.conv.id, epoch: c.run.epoch, runId: c.run.id, part: i });
    } catch (e) {
      c.s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'tg_links record failed');
    }
  });
}

/** Effects that are separate messages (venue, files, to-do list, location request), sent after the answer. */
export async function sendEffectMessages(c: RunCtx, effects: Effect[]): Promise<SentRef[]> {
  const all: SentRef[] = [];
  let i = 0;
  for (const e of effects) {
    const key = `run:${c.run.id}:eff:${i++}`;
    const base = {
      idempotencyKey: key, ...(c.run.userId ? { userId: c.run.userId } : {}), chatId: c.chatId,
      ...(c.threadId ? { threadId: c.threadId } : {}), priority: 1 as const,
    };
    try {
      if (e.kind === 'venue') {
        const refs = await c.s.telegram.outbox.sendNow({ ...base, method: 'sendVenue', payload: { latitude: e.lat, longitude: e.lon, title: e.title.slice(0, 200), address: e.address.slice(0, 300) } });
        recordLinks(c, refs, 'venue');
        all.push(...refs);
      } else if (e.kind === 'document' || e.kind === 'photo') {
        const blobId = c.s.repos.messages.putBlob({ ownerUserId: c.run.userId, dek: dekFor(c), mime: e.kind === 'document' ? e.mime : mimeOfImage(e.filename), bytes: e.bytes });
        const refs = await c.s.telegram.outbox.sendNow({ ...base, method: e.kind === 'document' ? 'sendDocument' : 'sendPhoto', payload: { blob_id: blobId, filename: safeFilename(e.filename) } });
        recordLinks(c, refs, 'file');
        all.push(...refs);
      } else if (e.kind === 'todo_list') {
        const view = c.s.todos.render(e.scope, c.lang ?? 'en');
        const refs = await c.s.telegram.outbox.sendNow({
          ...base, method: 'sendRichMessage', markdown: view.markdown, payload: view.buttons.length ? { reply_markup: { inline_keyboard: view.buttons } } : {},
          refKind: 'todo', refId: scopeKey(e.scope), // WP6a's outbox.onSent('todo') records the list message
        });
        recordLinks(c, refs, 'list');
        all.push(...refs);
      } else if (e.kind === 'location_request') {
        const refs = await c.s.telegram.outbox.sendNow({
          ...base, method: 'sendMessage',
          payload: {
            text: e.text.slice(0, 1000),
            reply_markup: { keyboard: [[{ text: c.s.strings.t('share_location_button', c.lang), request_location: true }]], one_time_keyboard: true, resize_keyboard: true },
          },
        });
        recordLinks(c, refs, 'notice');
        all.push(...refs);
      }
    } catch (err) {
      if (isOutboxPending(err)) c.s.log.info({ effect: e.kind }, 'effect message queued behind a retry (the outbox sends it in order)');
      else c.s.log.warn({ effect: e.kind, err: err instanceof Error ? err.name : 'error' }, 'effect message failed');
    }
  }
  return all;
}

export function dekFor(c: RunCtx): string {
  if (c.run.userId) return `u:${c.run.userId}`;
  if (c.conv.kind === 'group' && c.conv.tgChatId !== null) return `g:${c.conv.tgChatId}`;
  return 'sys';
}

export function safeFilename(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim();
  return (base || 'file').slice(0, 120);
}
function mimeOfImage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
}

/** A plain user-facing line (engine messages are plain text) rendered safely inside markdown. */
export function plainLine(text: string): string {
  return escapeMd(text);
}

/** The ↻ Retry button (event `retry` through WP7's `ct` callback: `ct:<conversationId>:r`). */
export function retryRow(c: RunCtx): InlineKeyboardButton[][] {
  try {
    return [[{ text: c.s.strings.t('retry_button', c.lang), callback_data: c.s.telegram.codec.encode('ct', [c.conv.id, 'r'], c.owner) }]];
  } catch {
    return [];
  }
}
