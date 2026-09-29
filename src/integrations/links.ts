// integrations/links.ts (s07 CAL) — pending connect links (table integration_links, migration 004) and the
// `integration_poll` job (spec 07 B1, plan 08 §4.4). A link row is written for every connect link the service issues:
// it remembers the oauth `state` it belongs to, the provider's pending account id (sealed), where to say "Готово ✓"
// and which conversation's question resumes afterwards (B2). The poller asks the provider every 5 s for 10 min whether
// the pending account became active, because the tunnel URL can change and the OAuth callback may never arrive. A poll
// hit and a callback both complete through the service's `finish`, which claims the same oauth_states row exactly once.
import type { IntegrationKind, IntegrationProvider, JobHandler, JobResult, Ms, Services, UserId } from '../contracts/index.ts';
import { LIMITS } from '../config.ts';
import { errorMessage } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';

export type LinkStatus = 'pending' | 'active' | 'failed' | 'expired';
export interface LinkRow {
  id: string; userId: UserId; kind: IntegrationKind; provider: string; state: string; pendingRef: string | null; status: LinkStatus;
  returnChatId: number; returnThreadId: number | null; resumeConversationId: string | null;
  nextPollAt: Ms; deadlineAt: Ms; polls: number; lastError: string | null; createdAt: Ms; completedAt: Ms | null;
}
interface Raw {
  id: string; user_id: string; integration: IntegrationKind; provider: string; state: string; pending_ref_enc: Uint8Array | null; status: LinkStatus;
  return_chat_id: number; return_thread_id: number | null; resume_conversation_id: string | null;
  next_poll_at: number; deadline_at: number; polls: number; last_error: string | null; created_at: number; completed_at: number | null;
}
/** Finished link rows are kept this long (for "already connected" answers and debugging), then deleted. */
export const LINK_KEEP_MS = 7 * 86_400_000;
/**
 * s07 lead fix (red team "no cap on pending links"): at most this many connect links of one user are pending (and
 * polled every 5 s) at once; issuing another expires the oldest, so repeated Mini App taps never multiply the polls.
 */
export const MAX_PENDING_LINKS_PER_USER = 3;

const aad = (id: string) => `integration_links|pending_ref_enc|${id}`;

export function createLinksRepo(s: Services) {
  const toRow = (r: Raw): LinkRow => {
    let pendingRef: string | null = null;
    if (r.pending_ref_enc) {
      try {
        pendingRef = s.crypto.openText(r.pending_ref_enc, aad(r.id));
      } catch (e) {
        s.log.warn({ err: errorMessage(e), integration: r.integration }, 'integration link ref unreadable');
      }
    }
    return {
      id: r.id, userId: r.user_id, kind: r.integration, provider: r.provider, state: r.state, pendingRef, status: r.status,
      returnChatId: r.return_chat_id, returnThreadId: r.return_thread_id, resumeConversationId: r.resume_conversation_id,
      nextPollAt: r.next_poll_at, deadlineAt: r.deadline_at, polls: r.polls, lastError: r.last_error, createdAt: r.created_at, completedAt: r.completed_at,
    };
  };
  const one = (sql: string, ...args: Array<string | number | null>): LinkRow | undefined => {
    const r = s.db.prepare(sql).get<Raw>(...args);
    return r ? toRow(r) : undefined;
  };

  return {
    insert(l: { userId: UserId; kind: IntegrationKind; provider: string; state: string; pendingRef?: string; ret: { chatId: number; threadId?: number }; resumeConversationId?: string | null; now: Ms; deadlineAt?: Ms }): LinkRow {
      const id = newId('il', l.now);
      const deadline = Math.min(l.deadlineAt ?? Infinity, l.now + LIMITS.integrationPollForMs);
      s.db.prepare(
        `INSERT INTO integration_links (id, user_id, integration, provider, state, pending_ref_enc, status, return_chat_id, return_thread_id, resume_conversation_id, next_poll_at, deadline_at, polls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        id, l.userId, l.kind, l.provider, l.state, l.pendingRef ? s.crypto.seal(`u:${l.userId}`, l.pendingRef, aad(id)) : null,
        l.ret.chatId, l.ret.threadId ?? null, l.resumeConversationId ?? null, l.now + LIMITS.integrationPollEveryMs, deadline, l.now,
      );
      return this.get(id)!;
    },
    get: (id: string) => one('SELECT * FROM integration_links WHERE id = ?', id),
    byState: (state: string) => one('SELECT * FROM integration_links WHERE state = ?', state),
    /** The newest still-pending link of a user for one service in one chat, issued at or after `since` (card dedupe). */
    recentPending: (userId: UserId, kind: IntegrationKind, chat: { chatId: number; threadId?: number }, since: Ms, now: Ms) =>
      one(
        `SELECT * FROM integration_links WHERE user_id = ? AND integration = ? AND status = 'pending' AND return_chat_id = ? AND COALESCE(return_thread_id, 0) = ? AND created_at >= ? AND deadline_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        userId, kind, chat.chatId, chat.threadId ?? 0, since, now,
      ),
    setResume(id: string, conversationId: string): void {
      s.db.prepare(`UPDATE integration_links SET resume_conversation_id = ? WHERE id = ? AND status = 'pending'`).run(conversationId, id);
    },
    markPolled(id: string, nextPollAt: Ms, lastError: string | null): void {
      s.db.prepare('UPDATE integration_links SET polls = polls + 1, next_poll_at = ?, last_error = ? WHERE id = ?').run(nextPollAt, lastError, id);
    },
    /** pending → a final status; false when the link was already final (a callback and a poll racing). */
    finish(id: string, status: Exclude<LinkStatus, 'pending'>, now: Ms): boolean {
      const r = s.db.prepare(`UPDATE integration_links SET status = ?, completed_at = ? WHERE id = ? AND status = 'pending'`).run(status, now, id);
      return Number(r.changes) === 1;
    },
    /** Ids of the user's still-pending links, newest first. */
    pendingIds(userId: UserId, now: Ms): string[] {
      return s.db
        .prepare(`SELECT id FROM integration_links WHERE user_id = ? AND status = 'pending' AND deadline_at > ? ORDER BY created_at DESC, id DESC`)
        .all<{ id: string }>(userId, now)
        .map((r) => r.id);
    },
    pendingFor(userId: UserId, now: Ms): Array<{ kind: IntegrationKind; createdAt: Ms; deadlineAt: Ms }> {
      return s.db
        .prepare(`SELECT integration, created_at, deadline_at FROM integration_links WHERE user_id = ? AND status = 'pending' AND deadline_at > ? ORDER BY created_at DESC`)
        .all<{ integration: IntegrationKind; created_at: number; deadline_at: number }>(userId, now)
        .map((r) => ({ kind: r.integration, createdAt: r.created_at, deadlineAt: r.deadline_at }));
    },
    deleteUser(userId: UserId): void {
      s.db.prepare('DELETE FROM integration_links WHERE user_id = ?').run(userId);
    },
    /** Export: metadata only (never the pending account id). */
    exportUser(userId: UserId): Array<Record<string, unknown>> {
      return s.db.prepare('SELECT integration, provider, status, created_at, completed_at FROM integration_links WHERE user_id = ? ORDER BY created_at').all<Record<string, unknown>>(userId);
    },
    /** Pending links past their deadline become 'expired'; finished rows older than LINK_KEEP_MS are deleted. */
    sweep(now: Ms): void {
      s.db.prepare(`UPDATE integration_links SET status = 'expired', completed_at = ? WHERE status = 'pending' AND deadline_at <= ?`).run(now, now);
      s.db.prepare(`DELETE FROM integration_links WHERE status <> 'pending' AND COALESCE(completed_at, created_at) < ?`).run(now - LINK_KEEP_MS);
    },
  };
}
export type LinksRepo = ReturnType<typeof createLinksRepo>;

/** A log-safe error class for `last_error` (never a payload). */
export function errorClass(e: unknown): string {
  if (!(e instanceof Error)) return 'error';
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timeout';
  if (e.name === 'ComposioMisconfiguredError') return 'misconfigured';
  const st = (e as { status?: unknown }).status;
  if (typeof st === 'number') return st >= 500 ? 'http_5xx' : `http_${st}`;
  return 'network';
}

export type PollOutcome = 'pending' | 'active' | 'failed' | 'expired' | 'gone';

/**
 * The `integration_poll` handler (payload {linkId}). Each run: a link that is no longer pending stops; past its
 * deadline it becomes 'expired' (quietly, no message); otherwise the provider's status decides: pending → again in 5 s,
 * active → `onActive` (the service completes exactly once), failed → `onFailed`, a network error → `last_error` and again.
 */
export function createPollHandler(
  s: Services,
  deps: {
    links: LinksRepo;
    provider: IntegrationProvider | null;
    onActive: (link: LinkRow, accountRef: string) => Promise<void> | void;
    onFailed: (link: LinkRow, reason: string) => void;
    onExpired: (link: LinkRow) => void;
  },
): JobHandler {
  return async (job): Promise<JobResult> => {
    const id = String(job.payload['linkId'] ?? job.refId ?? '');
    const link = id ? deps.links.get(id) : undefined;
    if (!link || link.status !== 'pending') return { status: 'done' };
    const now = s.clock.now();
    if (now >= link.deadlineAt) {
      if (deps.links.finish(link.id, 'expired', now)) deps.onExpired(link);
      return { status: 'done' };
    }
    const p = deps.provider;
    if (!p?.connectionStatus || !link.pendingRef || p.name !== link.provider) return { status: 'done' }; // callback-only
    const next = Math.min(now + LIMITS.integrationPollEveryMs, link.deadlineAt);
    let r;
    try {
      r = await p.connectionStatus(link.pendingRef, { userId: link.userId, kind: link.kind });
    } catch (e) {
      deps.links.markPolled(link.id, next, errorClass(e));
      return { status: 'reschedule', runAt: next };
    }
    if (r.status === 'pending') {
      deps.links.markPolled(link.id, next, null);
      return { status: 'reschedule', runAt: next };
    }
    if (r.status === 'active') {
      await deps.onActive(link, r.accountRef);
      return { status: 'done' };
    }
    if (deps.links.finish(link.id, 'failed', now)) deps.onFailed(link, r.reason);
    return { status: 'done' };
  };
}
