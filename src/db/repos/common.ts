// db/repos/common.ts (WP1) — small helpers shared by the core repos: row coercion and DEK selection.
import type { Clock } from '../../contracts/common.ts';
import type { ConversationRow, Crypto, Db, DekId, SqlValue } from '../../contracts/storage.ts';

export interface RepoCtx { db: Db; crypto: Crypto; clock: Clock }

export const b2i = (b: boolean | null | undefined): number => (b ? 1 : 0);
export const i2b = (v: unknown): boolean => v === 1 || v === 1n || v === true;
export const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const bytes = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : null);

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Epoch DEK id (01 §4.4): 'e:<conversationId>:<epoch>'. */
export const epochDek = (conversationId: string, epoch: number): DekId => `e:${conversationId}:${epoch}`;

/** The DEK owner of a conversation's epoch DEKs (contracts/storage.ts): userId, 'grp:<chatId>' or 'guest'. */
export function convDekOwner(c: Pick<ConversationRow, 'userId' | 'kind' | 'tgChatId' | 'businessConnectionId'>): string {
  if (c.userId) return c.userId;
  if (c.kind === 'group' && c.tgChatId !== null) return `grp:${c.tgChatId}`;
  if (c.kind === 'biz_draft' && c.businessConnectionId) return `biz:${c.businessConnectionId}`;
  return 'guest';
}

/**
 * The DEK for conversation-scoped rows that outlive a single epoch (pending inputs, conv_events): the owner's DEK
 * ('u:<userId>' / 'g:<chatId>' / 'b:<connId>'), so an epoch rotation + shred never makes a not-yet-consumed input
 * unreadable; guest conversations (no owner) use the current epoch DEK. Consumed inputs are deleted with their epoch.
 */
export function convScopedDek(c: Pick<ConversationRow, 'id' | 'userId' | 'kind' | 'tgChatId' | 'businessConnectionId' | 'epoch'>): DekId {
  if (c.userId) return `u:${c.userId}`;
  if (c.kind === 'group' && c.tgChatId !== null) return `g:${c.tgChatId}`;
  if (c.kind === 'biz_draft' && c.businessConnectionId) return `b:${c.businessConnectionId}`;
  return epochDek(c.id, c.epoch);
}

/** Builds `SET a = ?, b = ?` from [column, value] pairs; returns null when there is nothing to set. */
export function setClause(pairs: Array<[string, SqlValue]>): { sql: string; params: SqlValue[] } | null {
  if (!pairs.length) return null;
  return { sql: pairs.map(([c]) => `${c} = ?`).join(', '), params: pairs.map(([, v]) => v) };
}

export const has = <T extends object>(o: T, k: keyof T): boolean => Object.prototype.hasOwnProperty.call(o, k) && (o as Record<keyof T, unknown>)[k] !== undefined;
