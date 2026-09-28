// privacy/delete.ts (WP1) — /deletemydata and admin purge-user: the 01 §7.2 deletion plan over USER_DATA_TABLES.
//
//   0. a deletion_requests row (status 'running'; user_ref is a pseudonym, never the raw id) — a crash leaves it
//      'running' with users.status = 'deleting', and the retention sweep re-runs the whole idempotent plan;
//   1. users.status = 'deleting'; the user's jobs are deleted and their unfinished runs are stopped;
//   2. privacy hooks onDeleteUser (registration order; an error is logged, recorded and skipped — the plan continues,
//      because leaving the user's data in place is worse than a partially failed external revoke);
//   3. every conversation of the user (and the biz_draft conversations of their business connections) is purged:
//      shred token + messages + run rows per epoch, epoch DEK destroyed, onShredEpoch hooks, then the conversation;
//   4. USER_DATA_TABLES in order in ONE transaction (shred tokens are inserted first for any epoch still present;
//      `via:'hook'` tables — payments — are never DELETEd; `users` is left for step 6), plus the WP1 side keys
//      (kv cooldown, rate buckets naming the user);
//   5. crypto.destroyOwner(userId) and destroyOwner('biz:<connId>') for each of the user's business connections;
//   6. DELETE FROM users (cascades) and the deletion_requests row → 'done'.
import type { Services, UserId } from '../contracts/index.ts';
import { USER_DATA_TABLES, type Db, type SqlValue, type UserDataTable } from '../contracts/storage.ts';
import { errorMessage } from '../kernel/errors.ts';
import { ulid } from '../kernel/ids.ts';
import type { Shredder } from './shred.ts';

const UNFINISHED_RUN_STATES = `('queued','running','parked','retry_wait')`;

/** Pseudonymous reference to a user that survives the deletion (deletion_requests.user_ref). */
export function deletedUserRef(s: Pick<Services, 'crypto'>, userId: UserId): string {
  return 'deleted:' + s.crypto.hmac('target', `user:${userId}`).slice(0, 32);
}

/**
 * kv key of the post-deletion marker for a Telegram user (pseudonymous: an HMAC of the tg id, no raw id). The Mini App
 * auth middleware refuses to re-create an account from initData signed before the deletion (a still-open Mini App
 * session); a fresh initData (the user reopens the Mini App later) signs up again normally. Swept after
 * DELETION_MARKER_TTL_MS by the retention sweep (longer than the 24 h 'read' initData window).
 */
export function deletedTgMarkerKey(s: Pick<Services, 'crypto'>, tgUserId: number): string {
  return 'deleted_tg:' + s.crypto.hmac('target', `tg:${tgUserId}`).slice(0, 32);
}
export const DELETION_MARKER_TTL_MS = 3 * 24 * 60 * 60_000;

/** Named parameters actually used by a USER_DATA_TABLES `where` (node:sqlite rejects unknown names). */
function paramsFor(where: string, p: { userId: string; tgUserId: number }): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  if (where.includes(':userId')) out.userId = p.userId;
  if (where.includes(':tgUserId')) out.tgUserId = p.tgUserId;
  return out;
}

function runPlanTable(db: Db, t: UserDataTable, p: { userId: string; tgUserId: number }): number {
  // Table names and WHERE clauses come from the frozen USER_DATA_TABLES literal (never user input).
  const st = db.raw.prepare(`DELETE FROM ${t.table} WHERE ${t.where}`);
  return Number(st.run(paramsFor(t.where, p)).changes);
}

export interface Deleter {
  deleteUser(userId: UserId, reason: 'user' | 'admin'): Promise<void>;
  /** Re-runs the plan for users left in status 'deleting' (a crash mid-deletion). Returns how many were resumed. */
  resumeStuck(): Promise<number>;
}

export function createDeleter(s: Services, shredder: Shredder): Deleter {
  const inFlight = new Map<UserId, Promise<void>>();

  const requestFor = (userRef: string, reason: string, now: number): string => {
    const db = s.db;
    const open = db
      .prepare(`SELECT id FROM deletion_requests WHERE user_ref = ? AND scope = 'account' AND status IN ('pending','running') ORDER BY requested_at LIMIT 1`)
      .get<{ id: string }>(userRef);
    if (open) {
      db.prepare(`UPDATE deletion_requests SET status = 'running', error = NULL WHERE id = ?`).run(open.id);
      return open.id;
    }
    const id = ulid(now);
    db.prepare(`INSERT INTO deletion_requests(id, user_ref, scope, target_ref, status, requested_at) VALUES (?, ?, 'account', ?, 'running', ?)`).run(id, userRef, reason, now);
    return id;
  };

  const stopRuns = async (userId: UserId): Promise<void> => {
    const ids = s.db
      .prepare(`SELECT id FROM runs WHERE state IN ${UNFINISHED_RUN_STATES} AND (user_id = ? OR conversation_id IN (SELECT id FROM conversations WHERE user_id = ?))`)
      .all<{ id: string }>(userId, userId)
      .map((r) => r.id);
    for (const id of ids) {
      try {
        await s.runner.stopRun(id, 'system');
      } catch (e) {
        s.log.warn({ runId: id, err: errorMessage(e) }, 'deleteUser: stopRun failed (rows are deleted anyway)');
      }
    }
  };

  const run = async (userId: UserId, reason: 'user' | 'admin'): Promise<void> => {
    const user = s.repos.users.getById(userId);
    if (!user) return;
    const db = s.db;
    const tgUserId = user.tgUserId;
    const userRef = deletedUserRef(s, userId);
    const started = s.clock.now();

    // 0 + 1
    const reqId = db.tx(() => {
      const id = requestFor(userRef, reason, started);
      db.prepare(`UPDATE users SET status = 'deleting' WHERE id = ?`).run(userId);
      db.prepare('DELETE FROM jobs WHERE user_id = ?').run(userId);
      return id;
    });
    s.log.info({ userId, reason }, 'deleteUser: started');
    await stopRuns(userId);

    // Captured before the hooks: WP7b's hook removes business data (and with it the connection ids).
    const bizConnIds = db.prepare('SELECT id FROM business_connections WHERE user_id = ?').all<{ id: string }>(userId).map((r) => r.id);

    // 2
    const failedHooks: string[] = [];
    for (const h of s.privacyHooks) {
      try {
        await h.onDeleteUser(userId, tgUserId);
      } catch (e) {
        failedHooks.push(h.name);
        s.log.error({ hook: h.name, userId, err: errorMessage(e) }, 'privacy hook onDeleteUser failed');
      }
    }

    // 3
    const convIds = new Set(db.prepare('SELECT id FROM conversations WHERE user_id = ?').all<{ id: string }>(userId).map((r) => r.id));
    for (const connId of bizConnIds) {
      for (const r of db.prepare(`SELECT id FROM conversations WHERE kind = 'biz_draft' AND business_connection_id = ?`).all<{ id: string }>(connId)) convIds.add(r.id);
    }
    for (const id of convIds) await shredder.purgeConversation(id, 'account_deleted');

    // Jobs a hook or a stopped run may have scheduled meanwhile.
    db.prepare('DELETE FROM jobs WHERE user_id = ?').run(userId);

    // 4
    const p = { userId, tgUserId };
    const now = s.clock.now();
    const counts: Record<string, number> = {};
    db.tx(() => {
      // Shred tokens for every epoch still present (conversations created after step 3 or a partial earlier attempt).
      db.prepare(
        `INSERT OR IGNORE INTO shred_tokens(conversation_id, epoch, reason, created_at)
         SELECT conversation_id, epoch, 'account_deleted', ? FROM epochs WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
      ).run(now, userId);
      for (const t of USER_DATA_TABLES) {
        if (t.via === 'hook' || t.table === 'users') continue;
        const n = runPlanTable(db, t, p);
        if (n) counts[t.table] = n;
      }
      db.prepare('DELETE FROM kv WHERE key = ?').run(`cooldown:${userId}`);
      db.prepare(`DELETE FROM rate_buckets WHERE key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ?`).run(`%:${userId}`, `%:${userId}:%`, `%:${tgUserId}`, `%:${tgUserId}:%`);
    });

    // 5
    let destroyed = s.crypto.destroyOwner(userId);
    for (const connId of bizConnIds) destroyed += s.crypto.destroyOwner(`biz:${connId}`);

    // 6
    const usersTable = USER_DATA_TABLES.find((t) => t.table === 'users');
    db.tx(() => {
      if (usersTable) runPlanTable(db, usersTable, p);
      else db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      const doneAt = s.clock.now();
      db.prepare('INSERT OR REPLACE INTO kv(key, value_json, updated_at) VALUES (?, ?, ?)').run(deletedTgMarkerKey(s, tgUserId), JSON.stringify({ at: doneAt }), doneAt);
      db.prepare(`UPDATE deletion_requests SET status = 'done', completed_at = ?, error = ? WHERE id = ?`).run(
        s.clock.now(),
        failedHooks.length ? `hooks_failed:${failedHooks.join(',')}`.slice(0, 200) : null,
        reqId,
      );
    });
    s.log.info({ reason, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0), deks: destroyed, failedHooks }, 'deleteUser: done');
  };

  const deleteUser: Deleter['deleteUser'] = (userId, reason) => {
    const cur = inFlight.get(userId);
    if (cur) return cur;
    const p = run(userId, reason)
      .catch((e: unknown) => {
        try {
          s.db
            .prepare(`UPDATE deletion_requests SET status = 'failed', error = ? WHERE user_ref = ? AND scope = 'account' AND status = 'running'`)
            .run(errorMessage(e).slice(0, 200), deletedUserRef(s, userId));
        } catch {
          /* keep the original error */
        }
        s.log.error({ userId, err: errorMessage(e) }, 'deleteUser failed (the retention sweep resumes it)');
        throw e;
      })
      .finally(() => inFlight.delete(userId));
    inFlight.set(userId, p);
    return p;
  };

  const resumeStuck: Deleter['resumeStuck'] = async () => {
    let n = 0;
    for (const u of [...s.repos.users.iterate({ status: 'deleting' })]) {
      try {
        await deleteUser(u.id, 'admin');
        n++;
      } catch {
        /* logged by deleteUser; retried on the next sweep */
      }
    }
    return n;
  };

  return { deleteUser, resumeStuck };
}
