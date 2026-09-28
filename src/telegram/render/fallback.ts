// telegram/render/fallback.ts (WP2) — the send / edit fallback chain of F2 and ⚠U18:
//   rich (sendRichMessage, skip_entity_detection) → entities (telegram-md-entities, link previews off) → plain 4096 chunks.
// ANY 400 from a rich send is treated as a parse failure (U18) and moves to the next rung; a 400 from the entities send moves
// to plain text. Other errors (429 after autoRetry, 403, network) propagate to the caller.
import { GrammyError, type Api } from 'grammy';
import type { InlineKeyboardMarkup, MessageEntity } from 'grammy/types';
import { renderMarkdown, splitMessage } from 'telegram-md-entities';
import type { SentRef } from '../../contracts/index.ts';
import { splitMarkdown } from './split.ts';

export const PLAIN_LIMIT = 4096;

export interface SendTarget { chatId: number; threadId?: number; businessConnectionId?: string; replyTo?: number }
export interface SendOpts { replyMarkup?: InlineKeyboardMarkup; silent?: boolean; allowRich?: boolean }

type RawCall = (p: Record<string, unknown>) => Promise<unknown>;
export function rawOf(api: Api): Record<string, RawCall> {
  return api.raw as unknown as Record<string, RawCall>;
}

/** A log-safe description of an error: Telegram error code + description, else only the class name (never message text). */
export function errInfo(e: unknown): string {
  if (e instanceof GrammyError) return `${e.error_code} ${e.description}`.slice(0, 200);
  return e instanceof Error ? e.name : 'error';
}

export function isBadRequest(e: unknown): e is GrammyError {
  return e instanceof GrammyError && e.error_code === 400;
}
export function isNotModified(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /not modified/i.test(e.description);
}

/** Markdown → [{text, entities}] chunks of ≤ 4096 UTF-16 units (the entities rung). */
export function toEntities(md: string): Array<{ text: string; entities: MessageEntity[] }> {
  if (!md.trim()) return [];
  const rendered = renderMarkdown(md);
  return splitMessage(rendered, { maxLength: PLAIN_LIMIT }).map((m) => ({ text: m.text, entities: m.entities as MessageEntity[] }));
}

/** Plain text chunks of ≤ 4096 units, cut at newlines or spaces when possible. */
export function plainChunks(text: string, limit = PLAIN_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Plain-text rendering of markdown (entity text without the entities). */
export function plainText(md: string): string {
  if (!md.trim()) return '';
  try {
    return renderMarkdown(md).text;
  } catch {
    return md;
  }
}

function common(t: SendTarget, o: SendOpts, first: boolean, last: boolean): Record<string, unknown> {
  return {
    chat_id: t.chatId,
    ...(t.threadId ? { message_thread_id: t.threadId } : {}),
    ...(t.businessConnectionId ? { business_connection_id: t.businessConnectionId } : {}),
    ...(first && t.replyTo ? { reply_parameters: { message_id: t.replyTo, allow_sending_without_reply: true } } : {}),
    ...(last && o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
    ...(o.silent ? { disable_notification: true } : {}),
  };
}

function messageIdOf(res: unknown): number | null {
  if (res && typeof res === 'object' && typeof (res as { message_id?: unknown }).message_id === 'number') return (res as { message_id: number }).message_id;
  return null;
}

/**
 * Progress of a chain that already sent some of its messages (review F3). `done` are the refs sent by earlier attempts,
 * in order; `onSent` is called after every message so the caller can persist them. The chain is deterministic for a given
 * markdown, so a retry resumes after the messages that already went out instead of sending them again.
 */
export interface ChainProgress { done: readonly SentRef[]; onSent: (sent: readonly SentRef[]) => void }

/**
 * Sends `md` with the full chain. Rich parts that already went out stay; the fallback covers the remaining text only.
 * Returns one SentRef per message sent, in order (including `progress.done`).
 */
export async function sendMarkdownChain(api: Api, t: SendTarget, md: string, o: SendOpts = {}, progress?: ChainProgress): Promise<SentRef[]> {
  const raw = rawOf(api);
  const done = progress?.done ?? [];
  const sent: SentRef[] = [...done];
  const push = (ref: SentRef) => {
    sent.push(ref);
    progress?.onSent([...sent]);
  };
  const richDone = done.filter((r) => r.kind === 'rich').length;
  const entDone = done.filter((r) => r.kind === 'entities').length;
  const plainDone = done.filter((r) => r.kind === 'plain').length;
  const parts = splitMarkdown(md);
  if (!parts.length) return sent;
  let i = 0;
  if (o.allowRich !== false) {
    i = Math.min(richDone, parts.length);
    // a previous attempt that already moved on to entities / plain text found the rich rung refused at part `richDone`
    if (entDone === 0 && plainDone === 0) {
      for (; i < parts.length; i++) {
        try {
          const res = await raw['sendRichMessage']!({ ...common(t, o, sent.length === 0, i === parts.length - 1), rich_message: { markdown: parts[i]!, skip_entity_detection: true } });
          const id = messageIdOf(res);
          if (id !== null) push({ chatId: t.chatId, messageId: id, kind: 'rich' });
        } catch (e) {
          if (!isBadRequest(e)) throw e;
          break; // U18: any 400 → entities for the rest
        }
      }
      if (i >= parts.length) return sent;
    }
  }
  const rest = parts.slice(i).join('\n\n');
  const ents = toEntities(rest);
  let j = Math.min(entDone, ents.length);
  if (plainDone === 0) {
    for (; j < ents.length; j++) {
      try {
        const res = await raw['sendMessage']!({ ...common(t, o, sent.length === 0, j === ents.length - 1), text: ents[j]!.text, entities: ents[j]!.entities, link_preview_options: { is_disabled: true } });
        const id = messageIdOf(res);
        if (id !== null) push({ chatId: t.chatId, messageId: id, kind: 'entities' });
      } catch (e) {
        if (!isBadRequest(e)) throw e;
        break;
      }
    }
    if (j >= ents.length) return sent;
  }
  const chunks = plainChunks(ents.slice(j).map((e) => e.text).join('\n\n'));
  for (let k = Math.min(plainDone, chunks.length); k < chunks.length; k++) {
    const res = await raw['sendMessage']!({ ...common(t, o, sent.length === 0, k === chunks.length - 1), text: chunks[k]!, link_preview_options: { is_disabled: true } });
    const id = messageIdOf(res);
    if (id !== null) push({ chatId: t.chatId, messageId: id, kind: 'plain' });
  }
  return sent;
}

export type EditTarget = { chatId: number; messageId: number; businessConnectionId?: string } | { inlineMessageId: string };

/** A message that did not fit the edited one: entity or plain text, sent as a new message by the caller. */
export interface EditOverflow { text: string; entities?: MessageEntity[] }

/**
 * Edits a message in place with the chain rich → entities → plain (01 §5.5 group placeholder, ⚠U1 guest edits).
 * Only the first 30 000 / 4096 chars fit one message; the caller sends any overflow separately.
 * Returns the rung that worked, or throws the last error.
 */
export async function editMarkdownChain(api: Api, t: EditTarget, md: string, o: { replyMarkup?: InlineKeyboardMarkup; allowRich?: boolean } = {}): Promise<'rich' | 'entities' | 'plain'> {
  // callers of this form drop the overflow, so the keyboard always stays on the edited message
  return (await editMarkdownChainWithRest(api, t, md, { ...o, keyboardAlways: true })).kind;
}

/**
 * Like editMarkdownChain, but also returns what did not fit when the edit fell back to the entities or plain rung
 * (review F1: those rungs carry one 4096-char message). The keyboard goes on the edited message only when nothing is
 * left over; otherwise the caller puts it on the last overflow message.
 */
export async function editMarkdownChainWithRest(
  api: Api, t: EditTarget, md: string, o: { replyMarkup?: InlineKeyboardMarkup; allowRich?: boolean; keyboardAlways?: boolean } = {},
): Promise<{ kind: 'rich' | 'entities' | 'plain'; rest: EditOverflow[] }> {
  const raw = rawOf(api);
  const where: Record<string, unknown> = 'inlineMessageId' in t ? { inline_message_id: t.inlineMessageId } : { chat_id: t.chatId, message_id: t.messageId, ...(t.businessConnectionId ? { business_connection_id: t.businessConnectionId } : {}) };
  const markupIf = (whole: boolean) => (o.replyMarkup && (whole || o.keyboardAlways) ? { reply_markup: o.replyMarkup } : {});
  let lastErr: unknown = null;
  if (o.allowRich !== false) {
    const first = splitMarkdown(md)[0] ?? md;
    try {
      await raw['editMessageText']!({ ...where, ...markupIf(true), rich_message: { markdown: first, skip_entity_detection: true } });
      return { kind: 'rich', rest: [] };
    } catch (e) {
      if (isNotModified(e)) return { kind: 'rich', rest: [] };
      if (!isBadRequest(e)) throw e;
      lastErr = e;
    }
  }
  const ents = toEntities(md);
  const ent = ents[0];
  if (ent) {
    const rest = ents.slice(1).map((x) => ({ text: x.text, entities: x.entities }));
    try {
      await raw['editMessageText']!({ ...where, ...markupIf(rest.length === 0), text: ent.text, entities: ent.entities, link_preview_options: { is_disabled: true } });
      return { kind: 'entities', rest };
    } catch (e) {
      if (isNotModified(e)) return { kind: 'entities', rest };
      if (!isBadRequest(e)) throw e;
      lastErr = e;
    }
  }
  const chunks = plainChunks(plainText(md));
  const plain = chunks[0];
  if (!plain) throw lastErr ?? new Error('empty edit');
  const rest = chunks.slice(1).map((text) => ({ text }));
  try {
    await raw['editMessageText']!({ ...where, ...markupIf(rest.length === 0), text: plain, link_preview_options: { is_disabled: true } });
  } catch (e) {
    if (isNotModified(e)) return { kind: 'plain', rest };
    throw e;
  }
  return { kind: 'plain', rest };
}
