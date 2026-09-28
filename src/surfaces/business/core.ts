// surfaces/business/core.ts (WP7b) — shared plumbing of the Secretary pipeline (01 §10.2): chat refs, DEK/AAD
// conventions, source refs for approvals.voidBySourceRef, the module context object and small helpers.
import type { Logger, Ms, Services, UserId, UserRow } from '../../contracts/index.ts';
import { formatLocal, wallTimeOf } from '../../kernel/timeMath.ts';
import type { BizRepo } from './repo.ts';

/** Consent text version of the connection card and per-chat consents (01 §10.2 step 1). */
export const CONSENT_TEXT_VERSION = 'biz-v1';
export const DAY_MS = 86_400_000;
/** can_reply works only within 24 h of the peer's last incoming message. */
export const WINDOW_MS = DAY_MS;
/** Triage debounce after the last message (01 §10.2 step 2). */
export const TRIAGE_DEBOUNCE_MS = 45_000;
/** At most 60 triage calls per connection per day (01 §10.2 step 3). */
export const TRIAGE_PER_DAY = 60;
/** The last 20 stored messages go to triage and drafting. */
export const TRANSCRIPT_MESSAGES = 20;
/** Style samples: the owner's last ≤ 15 outgoing messages (this chat first, then other consented chats). */
export const STYLE_SAMPLES = 15;
/** Stored business messages live 30 days (§11.9). */
export const MESSAGE_RETENTION_MS = 30 * DAY_MS;
/** At most one NEW digest message per 2 h; otherwise the current one is edited in place. */
export const DIGEST_NEW_EVERY_MS = 2 * 3600_000;
/** The digest is re-rendered shortly after a change (coalesces bursts of triage results). */
export const DIGEST_DELAY_MS = 5_000;
/** `copy_text` buttons carry at most 256 characters. */
export const COPY_TEXT_MAX = 256;
export const MAX_TEXT_STORED = 8_000;

export interface Biz {
  s: Services;
  repo: BizRepo;
  log: Logger;
}

/** 'bc:<connId>:<chatId>' — the form tools, the Mini App and BizChatView use. */
export function chatRef(connectionId: string, chatId: number): string {
  return `bc:${connectionId}:${chatId}`;
}

/** Accepts 'bc:<connId>:<chatId>' and the bare '<connId>:<chatId>' WP4's Sentinel builds from Classification.businessRef. */
export function parseChatRef(ref: string | null | undefined): { connectionId: string; chatId: number } | null {
  if (typeof ref !== 'string') return null;
  const r = ref.trim().startsWith('bc:') ? ref.trim().slice(3) : ref.trim();
  const i = r.lastIndexOf(':');
  if (i <= 0 || i === r.length - 1) return null;
  const connectionId = r.slice(0, i);
  const chatId = Number(r.slice(i + 1));
  if (!Number.isSafeInteger(chatId) || chatId === 0 || connectionId.length > 256) return null;
  return { connectionId, chatId };
}

export const dekOf = (connectionId: string): string => `b:${connectionId}`;
export const dekOwnerOf = (connectionId: string): string => `biz:${connectionId}`;
export const aadTitle = (c: string, chat: number): string => `business_chats|title_enc|${c}:${chat}`;
export const aadTone = (c: string, chat: number): string => `business_chats|tone_notes_enc|${c}:${chat}`;
export const aadText = (c: string, chat: number, msgId: number): string => `business_messages|text_enc|${c}:${chat}:${msgId}`;
export const aadDigest = (c: string): string => `kv|bizdigest|${c}`;

/** pending_actions.source_refs_json entries (voidBySourceRef matches exact strings). */
export const chatSourceRef = (c: string, chat: number): string => `bizchat:${c}:${chat}`;
export const msgSourceRef = (c: string, chat: number, msgId: number): string => `bizmsg:${c}:${chat}:${msgId}`;

export const triageJobKey = (c: string, chat: number): string => `triage:${c}:${chat}`;
export const windowJobKey = (c: string, chat: number): string => `bizwin:${c}:${chat}`;
export const digestJobKey = (c: string): string => `bizdigest:${c}`;
export const digestKvKey = (c: string): string => `bizdigest:${c}`;

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'error';
}

/** 'YYYY-MM-DDTHH:MM' wall time of `at` in `tz` (triage's nowLocal). */
export function localStamp(at: Ms, tz: string): string {
  try {
    return formatLocal(wallTimeOf(at, tz));
  } catch {
    return formatLocal(wallTimeOf(at, 'UTC'));
  }
}

/** 'HH:MM' in the owner's zone (card lines). */
export function hhmm(at: Ms, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** A peer display name that is safe inside code-built lines (no markup, no newlines, ≤ 40 chars). */
export function safeName(name: string | null | undefined, fallback: string): string {
  const n = (name ?? '').replace(/[\u0000-\u001f<>`*_[\]()~|#\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return n ? clip(n, 40) : fallback;
}

/** Markdown fenced code block whose fence is longer than any backtick run inside the text. */
export function codeFence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function ownerOf(b: Biz, userId: UserId): UserRow | undefined {
  try {
    return b.s.repos.users.getById(userId);
  } catch {
    return undefined;
  }
}

/** Where the owner's Secretary cards go: the 📥 Inbox topic when topics work, else the main DM. */
export async function inboxOf(b: Biz, u: UserRow): Promise<{ chatId: number; threadId?: number }> {
  const chatId = u.dmChatId ?? u.tgUserId;
  try {
    const thread = await b.s.telegram.topics.ensureFixed(u.id, u.tgUserId, 'inbox');
    return thread ? { chatId, threadId: thread } : { chatId };
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: inbox topic unavailable; using the DM');
    return { chatId };
  }
}

export function ledger(b: Biz, e: Parameters<Services['ledger']['append']>[0]): void {
  try {
    b.s.ledger.append(e);
  } catch (err) {
    b.log.warn({ err: errName(err), kind: e.kind }, 'business: ledger append failed');
  }
}

export function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}
