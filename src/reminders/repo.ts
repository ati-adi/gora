// reminders/repo.ts (WP6a) — the only SQL over `reminders`, `todos` and `todo_messages` (01 §7.2: WP6 owns them).
// Text columns are sealed under the scope's DEK: 'u:<userId>' for user scope, 'g:<chatId>' for group scope.
import type { Ms, Scope, UserId } from '../contracts/common.ts';
import { parseScopeKey, scopeKey } from '../contracts/common.ts';
import type { Crypto, Db } from '../contracts/storage.ts';
import { DekDestroyedError } from '../kernel/errors.ts';
import { shortId } from '../kernel/ids.ts';
import { createJobsRepo } from '../scheduler/repo.ts';

export type ReminderKind = 'reminder' | 'checkin' | 'followup';
export type ReminderStatus = 'scheduled' | 'fired' | 'done' | 'snoozed' | 'paused' | 'cancelled';
export interface ReminderRow {
  id: string; userId: UserId | null; scope: string; kind: ReminderKind; text: string; targetChatId: number; targetThreadId: number | null;
  scheduleKind: 'once' | 'cron'; fireAt: Ms | null; cron: string | null; tz: string; status: ReminderStatus; jobId: string | null;
  sourceToolUseId: string | null; createdAt: Ms; updatedAt: Ms;
}
interface RawReminder {
  id: string; user_id: string | null; scope: string; kind: ReminderKind; text_enc: Uint8Array; target_chat_id: number; target_thread_id: number | null;
  schedule_kind: 'once' | 'cron'; fire_at: number | null; cron: string | null; tz: string; status: ReminderStatus; job_id: string | null;
  source_tool_use_id: string | null; created_at: number; updated_at: number;
}
export interface TodoRow { id: string; scope: string; authorUserId: UserId | null; text: string; done: boolean; position: number; createdAt: Ms; doneAt: Ms | null }
interface RawTodo { id: string; scope: string; author_user_id: string | null; text_enc: Uint8Array; done: number; position: number; created_at: number; done_at: number | null }

/** The base DEK that seals a scope's reminder and to-do text (see ReminderRepo.sealDek for the live one). */
export function scopeDek(scope: Scope | string): string {
  const sc = typeof scope === 'string' ? parseScopeKey(scope) : scope;
  if (!sc) throw new TypeError('invalid scope');
  return sc.kind === 'user' ? `u:${sc.userId}` : `g:${sc.chatId}`;
}

const ACTIVE: readonly ReminderStatus[] = ['scheduled', 'snoozed', 'paused'];

export function createReminderRepo(db: Db, crypto: Crypto) {
  const aadR = (id: string) => `reminders|text_enc|${id}`;
  const aadT = (id: string) => `todos|text_enc|${id}`;
  const openR = (r: RawReminder): ReminderRow => {
    let text = '';
    try {
      text = crypto.openText(r.text_enc, aadR(r.id));
    } catch {
      text = '';
    }
    return {
      id: r.id, userId: r.user_id, scope: r.scope, kind: r.kind, text, targetChatId: Number(r.target_chat_id),
      targetThreadId: r.target_thread_id === null ? null : Number(r.target_thread_id), scheduleKind: r.schedule_kind,
      fireAt: r.fire_at === null ? null : Number(r.fire_at), cron: r.cron, tz: r.tz, status: r.status, jobId: r.job_id,
      sourceToolUseId: r.source_tool_use_id, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  };
  const openT = (r: RawTodo): TodoRow => {
    let text = '';
    try {
      text = crypto.openText(r.text_enc, aadT(r.id));
    } catch {
      text = '';
    }
    return {
      id: r.id, scope: r.scope, authorUserId: r.author_user_id, text, done: Number(r.done) === 1, position: Number(r.position),
      createdAt: Number(r.created_at), doneAt: r.done_at === null ? null : Number(r.done_at),
    };
  };

  const destroyedUnder = (ct: Uint8Array, aad: string): boolean => {
    try {
      crypto.open(ct, aad);
      return false;
    } catch (e) {
      return e instanceof DekDestroyedError;
    }
  };

  /**
   * Deletes the to-dos and reminders of a scope whose text is sealed under a destroyed DEK (orphans of a shred: the
   * surfaces retention destroys every 'grp:<chatId>' DEK 7 days after the bot left a group) and cancels the reminders'
   * jobs. Returns how many rows went.
   */
  const purgeOrphans = (scope: string, now: Ms): number => {
    let n = 0;
    const jobs = createJobsRepo(db);
    for (const r of db.prepare(`SELECT id, text_enc FROM todos WHERE scope = ?`).all<{ id: string; text_enc: Uint8Array }>(scope)) {
      if (destroyedUnder(r.text_enc, aadT(r.id))) n += Number(db.prepare(`DELETE FROM todos WHERE id = ?`).run(r.id).changes);
    }
    for (const r of db.prepare(`SELECT id, text_enc FROM reminders WHERE scope = ?`).all<{ id: string; text_enc: Uint8Array }>(scope)) {
      if (!destroyedUnder(r.text_enc, aadR(r.id))) continue;
      jobs.cancel(`rem:${r.id}`, now);
      jobs.cancel(`rem:${r.id}:snz`, now);
      n += Number(db.prepare(`DELETE FROM reminders WHERE id = ?`).run(r.id).changes);
    }
    return n;
  };

  /**
   * The live DEK for new text of a scope. A group whose 'g:<chatId>' DEK was destroyed (the bot left, the retention sweep
   * shredded it, then the bot was added back) continues under 'g:<chatId>:<n>' — same owner 'grp:<chatId>', so the next
   * shred destroys it too — after the orphaned rows are purged.
   */
  const sealDek = (scope: string, now: Ms): string => {
    const base = scopeDek(scope);
    if (!crypto.isDestroyed(base) || !base.startsWith('g:')) return base;
    purgeOrphans(scope, now);
    for (let n = 2; n < 100_000; n++) {
      const id = `${base}:${n}`;
      if (!crypto.isDestroyed(id)) return id;
    }
    return base;
  };

  const newReminderId = (): string => {
    for (let i = 0; i < 20; i++) {
      const id = `R${shortId(5)}`;
      if (!db.prepare(`SELECT 1 AS x FROM reminders WHERE id = ?`).get(id)) return id;
    }
    return `R${shortId(8)}`;
  };
  const newTodoId = (): string => {
    for (let i = 0; i < 20; i++) {
      const id = `T${shortId(5)}`;
      if (!db.prepare(`SELECT 1 AS x FROM todos WHERE id = ?`).get(id)) return id;
    }
    return `T${shortId(8)}`;
  };

  return {
    sealDek,
    purgeOrphans,
    /** Group scopes whose base DEK is destroyed but that still have rows (the retention sweep purges their orphans). */
    shreddedGroupScopes(): string[] {
      return db
        .prepare(`SELECT DISTINCT scope FROM todos WHERE scope LIKE 'grp:%' UNION SELECT DISTINCT scope FROM reminders WHERE scope LIKE 'grp:%'`)
        .all<{ scope: string }>()
        .map((r) => r.scope)
        .filter((sc) => {
          try {
            return crypto.isDestroyed(scopeDek(sc));
          } catch {
            return false;
          }
        });
    },
    // ── reminders
    insertReminder(r: Omit<ReminderRow, 'id' | 'createdAt' | 'updatedAt' | 'jobId'> & { now: Ms }): string {
      const id = newReminderId();
      const enc = crypto.seal(sealDek(r.scope, r.now), r.text, aadR(id));
      db.prepare(
        `INSERT INTO reminders (id, user_id, scope, kind, text_enc, target_chat_id, target_thread_id, schedule_kind, fire_at, cron, tz, status, job_id, source_tool_use_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(id, r.userId, r.scope, r.kind, enc, r.targetChatId, r.targetThreadId, r.scheduleKind, r.fireAt, r.cron, r.tz, r.status, r.sourceToolUseId, r.now, r.now);
      return id;
    },
    getReminder(id: string): ReminderRow | undefined {
      const r = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get<RawReminder>(id);
      return r ? openR(r) : undefined;
    },
    bySourceToolUse(scope: string, toolUseId: string): ReminderRow | undefined {
      const r = db.prepare(`SELECT * FROM reminders WHERE scope = ? AND source_tool_use_id = ? ORDER BY created_at LIMIT 1`).get<RawReminder>(scope, toolUseId);
      return r ? openR(r) : undefined;
    },
    updateReminder(id: string, p: Partial<Pick<ReminderRow, 'scheduleKind' | 'fireAt' | 'cron' | 'tz' | 'status' | 'jobId'>>, now: Ms): void {
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      const col: Record<string, string> = { scheduleKind: 'schedule_kind', fireAt: 'fire_at', cron: 'cron', tz: 'tz', status: 'status', jobId: 'job_id' };
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || !col[k]) continue;
        sets.push(`${col[k]} = ?`);
        vals.push(v as string | number | null);
      }
      if (!sets.length) return;
      db.prepare(`UPDATE reminders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
    },
    listReminders(scope: string, includeDone: boolean, limit = 200): ReminderRow[] {
      const rows = includeDone
        ? db.prepare(`SELECT * FROM reminders WHERE scope = ? ORDER BY created_at DESC LIMIT ?`).all<RawReminder>(scope, limit)
        : db.prepare(`SELECT * FROM reminders WHERE scope = ? AND status IN ('scheduled','snoozed','paused') ORDER BY created_at DESC LIMIT ?`).all<RawReminder>(scope, limit);
      return rows.map(openR);
    },
    countActive(scope: string): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE scope = ? AND status IN ('scheduled','snoozed','paused')`).get<{ n: number }>(scope)?.n ?? 0);
    },
    countCreatedSince(scope: string, since: Ms): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE scope = ? AND created_at >= ?`).get<{ n: number }>(scope, since)?.n ?? 0);
    },
    /** Active reminders of a user in user scope (tz change). */
    activeForUser(userId: UserId): ReminderRow[] {
      return db
        .prepare(`SELECT * FROM reminders WHERE scope = ? AND status IN ('scheduled','snoozed','paused')`)
        .all<RawReminder>(scopeKey({ kind: 'user', userId }))
        .map(openR);
    },
    remindersOfUser(userId: UserId): ReminderRow[] {
      return db.prepare(`SELECT * FROM reminders WHERE scope = ? OR user_id = ? ORDER BY created_at`).all<RawReminder>(scopeKey({ kind: 'user', userId }), userId).map(openR);
    },
    isActive(status: ReminderStatus): boolean {
      return ACTIVE.includes(status);
    },

    // ── todos
    listTodos(scope: string): TodoRow[] {
      return db.prepare(`SELECT * FROM todos WHERE scope = ? ORDER BY done, position, created_at`).all<RawTodo>(scope).map(openT);
    },
    getTodo(id: string): TodoRow | undefined {
      const r = db.prepare(`SELECT * FROM todos WHERE id = ?`).get<RawTodo>(id);
      return r ? openT(r) : undefined;
    },
    insertTodo(scope: string, authorUserId: UserId | null, text: string, now: Ms): string {
      const id = newTodoId();
      const pos = Number(db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM todos WHERE scope = ?`).get<{ p: number }>(scope)?.p ?? 0) + 1;
      const enc = crypto.seal(sealDek(scope, now), text, aadT(id));
      db.prepare(`INSERT INTO todos (id, scope, author_user_id, text_enc, done, position, created_at, done_at) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)`).run(id, scope, authorUserId, enc, pos, now);
      return id;
    },
    setTodoDone(id: string, done: boolean, now: Ms): boolean {
      return Number(db.prepare(`UPDATE todos SET done = ?, done_at = ? WHERE id = ? AND done <> ?`).run(done ? 1 : 0, done ? now : null, id, done ? 1 : 0).changes) > 0;
    },
    deleteTodo(id: string): boolean {
      return Number(db.prepare(`DELETE FROM todos WHERE id = ?`).run(id).changes) > 0;
    },
    countOpenTodos(scope: string): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM todos WHERE scope = ? AND done = 0`).get<{ n: number }>(scope)?.n ?? 0);
    },
    /** Keeps the list short: completed items beyond the newest `keep` are dropped. */
    pruneDone(scope: string, keep: number): number {
      return Number(
        db.prepare(`DELETE FROM todos WHERE scope = ? AND done = 1 AND id NOT IN (SELECT id FROM todos WHERE scope = ? AND done = 1 ORDER BY done_at DESC LIMIT ?)`).run(scope, scope, keep).changes,
      );
    },
    recordTodoMessage(scope: string, chatId: number, messageId: number, now: Ms): void {
      db.prepare(`INSERT OR REPLACE INTO todo_messages (scope, chat_id, message_id, created_at) VALUES (?, ?, ?, ?)`).run(scope, chatId, messageId, now);
    },
    todoMessage(chatId: number, messageId: number): { scope: string } | undefined {
      return db.prepare(`SELECT scope FROM todo_messages WHERE chat_id = ? AND message_id = ?`).get<{ scope: string }>(chatId, messageId);
    },
    todosOfUser(userId: UserId): TodoRow[] {
      return db.prepare(`SELECT * FROM todos WHERE scope = ? ORDER BY position`).all<RawTodo>(scopeKey({ kind: 'user', userId })).map(openT);
    },
    purgeTodoMessages(before: Ms): number {
      return Number(db.prepare(`DELETE FROM todo_messages WHERE created_at < ?`).run(before).changes);
    },
  };
}
export type ReminderRepo = ReturnType<typeof createReminderRepo>;
