// tools/impl/calMemo.ts (WP5) — a small per-process memo of calendar events seen by the calendar tools. `classify()` is
// synchronous, so whether an event has attendees (write_self+Undo vs send_external+ask) comes from here; an unknown or
// STALE event (older than MEMO_TTL_MS) is classified conservatively (ask). execute() re-fetches the event before a write
// and refuses an auto-run edit of an event that gained guests. Cleared on gcal revoke and account deletion.
import type { CalEvent, Ms, UserId } from '../../contracts/index.ts';

const MAX = 1000;
/** How long a listed event may decide classification (guests can be added in the Google UI at any time). */
export const MEMO_TTL_MS = 5 * 60_000;
const memo = new Map<string, { e: CalEvent; at: Ms }>();

export function rememberEvents(userId: UserId, events: readonly CalEvent[], now: Ms): void {
  for (const e of events) {
    const k = `${userId}:${e.id}`;
    memo.delete(k);
    memo.set(k, { e, at: now });
  }
  while (memo.size > MAX) memo.delete(memo.keys().next().value as string);
}
/** A remembered event seen within MEMO_TTL_MS of `now`; stale entries are dropped. */
export function knownEvent(userId: UserId | null, id: string, now: Ms): CalEvent | undefined {
  if (!userId) return undefined;
  const k = `${userId}:${id}`;
  const hit = memo.get(k);
  if (!hit) return undefined;
  if (now - hit.at > MEMO_TTL_MS || hit.at - now > MEMO_TTL_MS) {
    memo.delete(k);
    return undefined;
  }
  return hit.e;
}
/** What the memo holds regardless of age (what a synchronous classify() may have seen just before execute()). */
export function memoEntry(userId: UserId | null, id: string): CalEvent | undefined {
  return userId ? memo.get(`${userId}:${id}`)?.e : undefined;
}
export function forgetEvent(userId: UserId, id: string): void {
  memo.delete(`${userId}:${id}`);
}
/** Privacy hook / revoke / tests: drop everything of one user (or all). */
export function clearEventMemo(userId?: UserId): void {
  if (!userId) return memo.clear();
  for (const k of [...memo.keys()]) if (k.startsWith(`${userId}:`)) memo.delete(k);
}
