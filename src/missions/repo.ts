// missions/repo.ts (WP6b) — all SQL for the WP6b mission tables: missions, watchers (01 §7.1/§7.2).
// Text columns are sealed under the owner's DEK 'u:<userId>' with AAD '<table>|<column>|<id>'.
import type { Crypto, Db, Ms, TaintSource, UserId, WatchCondition } from '../contracts/index.ts';

export type MissionStatus = 'active' | 'parked' | 'done' | 'failed' | 'cancelled' | 'budget_exhausted';
export type WatcherStatus = 'active' | 'paused' | 'done' | 'cancelled';
export interface ChecklistItem { text: string; done: boolean }

export interface MissionRow {
  id: string; userId: UserId; conversationId: string; title: string; goal: string; criteria: string[];
  checklist: ChecklistItem[]; note: string | null; status: MissionStatus; threadId: number | null; statusMessageId: number | null;
  budgetMicros: number; spentMicros: number; deadlineAt: Ms | null; taint: TaintSource[]; lastReportAt: Ms | null; createdAt: Ms; finishedAt: Ms | null;
}
export interface WatcherRow {
  id: string; userId: UserId; missionId: string | null; kind: 'page' | 'inbox'; target: string; condition: WatchCondition; intervalMin: number;
  nextCheckAt: Ms; lastHash: string | null; lastValue: string | null; lastCheckedAt: Ms | null; failCount: number; status: WatcherStatus;
  threadId: number | null; jobId: string | null; createdAt: Ms;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const u8 = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : null);
export const OPEN_MISSION_STATUSES: readonly MissionStatus[] = ['active', 'parked', 'budget_exhausted'];

export function createMissionRepo(db: () => Db, crypto: () => Crypto) {
  const dek = (userId: string) => `u:${userId}`;
  const openText = (v: unknown, aad: string): string => {
    const b = u8(v);
    if (!b) return '';
    try {
      return crypto().openText(b, aad);
    } catch {
      return '';
    }
  };
  const openJson = <T>(v: unknown, aad: string, dflt: T): T => {
    const b = u8(v);
    if (!b) return dflt;
    try {
      return crypto().openJson<T>(b, aad);
    } catch {
      return dflt;
    }
  };

  const toMission = (r: Raw): MissionRow => {
    const id = String(r['id']);
    const cl = openJson<{ items: ChecklistItem[]; note: string | null }>(r['checklist_enc'], `missions|checklist_enc|${id}`, { items: [], note: null });
    let taint: TaintSource[] = [];
    try {
      taint = JSON.parse(String(r['taint_json'] ?? '[]')) as TaintSource[];
    } catch {
      taint = [];
    }
    return {
      id, userId: String(r['user_id']), conversationId: String(r['conversation_id']),
      title: openText(r['title_enc'], `missions|title_enc|${id}`), goal: openText(r['goal_enc'], `missions|goal_enc|${id}`),
      criteria: openJson<string[]>(r['criteria_enc'], `missions|criteria_enc|${id}`, []), checklist: cl.items ?? [], note: cl.note ?? null,
      status: String(r['status']) as MissionStatus, threadId: num(r['thread_id']), statusMessageId: num(r['status_message_id']),
      budgetMicros: Number(r['budget_micros']), spentMicros: Number(r['spent_micros']), deadlineAt: num(r['deadline_at']), taint,
      lastReportAt: num(r['last_report_at']), createdAt: Number(r['created_at']), finishedAt: num(r['finished_at']),
    };
  };
  const toWatcher = (r: Raw): WatcherRow => {
    const id = String(r['id']);
    const lv = u8(r['last_value_enc']);
    return {
      id, userId: String(r['user_id']), missionId: str(r['mission_id']), kind: String(r['kind']) as WatcherRow['kind'],
      target: openText(r['target_enc'], `watchers|target_enc|${id}`), condition: openJson<WatchCondition>(r['condition_enc'], `watchers|condition_enc|${id}`, { type: 'changed' }),
      intervalMin: Number(r['interval_min']), nextCheckAt: Number(r['next_check_at']), lastHash: str(r['last_hash']),
      lastValue: lv ? openText(lv, `watchers|last_value_enc|${id}`) : null, lastCheckedAt: num(r['last_checked_at']), failCount: Number(r['fail_count']),
      status: String(r['status']) as WatcherStatus, threadId: num(r['thread_id']), jobId: str(r['job_id']), createdAt: Number(r['created_at']),
    };
  };

  return {
    // ───────────────────────── missions
    insertMission(m: Pick<MissionRow, 'id' | 'userId' | 'conversationId' | 'title' | 'goal' | 'criteria' | 'threadId' | 'budgetMicros' | 'deadlineAt' | 'taint' | 'createdAt'>): void {
      const c = crypto();
      db()
        .prepare(
          `INSERT INTO missions (id, user_id, conversation_id, title_enc, goal_enc, criteria_enc, checklist_enc, status, thread_id, budget_micros, spent_micros, deadline_at, taint_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          m.id, m.userId, m.conversationId, c.seal(dek(m.userId), m.title, `missions|title_enc|${m.id}`), c.seal(dek(m.userId), m.goal, `missions|goal_enc|${m.id}`),
          c.sealJson(dek(m.userId), m.criteria, `missions|criteria_enc|${m.id}`),
          c.sealJson(dek(m.userId), { items: m.criteria.map((t) => ({ text: t, done: false })), note: null }, `missions|checklist_enc|${m.id}`),
          m.threadId, m.budgetMicros, m.deadlineAt, JSON.stringify(m.taint), m.createdAt,
        );
    },
    getMission(id: string): MissionRow | undefined {
      const r = db().prepare(`SELECT * FROM missions WHERE id = ?`).get<Raw>(id);
      return r ? toMission(r) : undefined;
    },
    missionByConversation(conversationId: string): MissionRow | undefined {
      const r = db().prepare(`SELECT * FROM missions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`).get<Raw>(conversationId);
      return r ? toMission(r) : undefined;
    },
    listMissions(userId: UserId, o: { open?: boolean; limit: number }): MissionRow[] {
      const rows = o.open
        ? db().prepare(`SELECT * FROM missions WHERE user_id = ? AND status IN ('active','parked','budget_exhausted') ORDER BY created_at DESC LIMIT ?`).all<Raw>(userId, o.limit)
        : db().prepare(`SELECT * FROM missions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all<Raw>(userId, o.limit);
      return rows.map(toMission);
    },
    countOpenMissions(userId: UserId): number {
      const r = db().prepare(`SELECT COUNT(*) AS n FROM missions WHERE user_id = ? AND status IN ('active','parked','budget_exhausted')`).get<{ n: number }>(userId);
      return Number(r?.n ?? 0);
    },
    /** CAS on the current status; returns whether it changed. */
    setMissionStatus(id: string, to: MissionStatus, from: readonly MissionStatus[], now: Ms): boolean {
      const fin = to === 'done' || to === 'failed' || to === 'cancelled';
      const r = db()
        .prepare(`UPDATE missions SET status = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
        .run(to, fin ? 1 : 0, now, id, ...from);
      return Number(r.changes) === 1;
    },
    setStatusMessage(id: string, messageId: number): void {
      db().prepare(`UPDATE missions SET status_message_id = ? WHERE id = ?`).run(messageId, id);
    },
    setThread(id: string, threadId: number | null): void {
      db().prepare(`UPDATE missions SET thread_id = ? WHERE id = ?`).run(threadId, id);
    },
    setChecklist(m: Pick<MissionRow, 'id' | 'userId'>, items: ChecklistItem[], note: string | null): void {
      db().prepare(`UPDATE missions SET checklist_enc = ? WHERE id = ?`).run(crypto().sealJson(dek(m.userId), { items, note }, `missions|checklist_enc|${m.id}`), m.id);
    },
    setLastReport(id: string, at: Ms): void {
      db().prepare(`UPDATE missions SET last_report_at = ? WHERE id = ?`).run(at, id);
    },
    /** Adds to spent_micros atomically; returns the new totals. */
    addSpent(id: string, micros: number): { spent: number; budget: number; status: MissionStatus } | undefined {
      const d = db();
      return d.tx(() => {
        d.prepare(`UPDATE missions SET spent_micros = spent_micros + ? WHERE id = ?`).run(Math.max(0, Math.round(micros)), id);
        const r = d.prepare(`SELECT spent_micros, budget_micros, status FROM missions WHERE id = ?`).get<Raw>(id);
        return r ? { spent: Number(r['spent_micros']), budget: Number(r['budget_micros']), status: String(r['status']) as MissionStatus } : undefined;
      });
    },
    setBudget(id: string, micros: number): void {
      db().prepare(`UPDATE missions SET budget_micros = ? WHERE id = ?`).run(Math.round(micros), id);
    },
    listMissionsForExport(userId: UserId): MissionRow[] {
      return db().prepare(`SELECT * FROM missions WHERE user_id = ? ORDER BY created_at`).all<Raw>(userId).map(toMission);
    },

    // ───────────────────────── watchers
    insertWatcher(w: Pick<WatcherRow, 'id' | 'userId' | 'missionId' | 'kind' | 'target' | 'condition' | 'intervalMin' | 'nextCheckAt' | 'threadId' | 'createdAt'>): void {
      const c = crypto();
      db()
        .prepare(
          `INSERT INTO watchers (id, user_id, mission_id, kind, target_enc, condition_enc, interval_min, next_check_at, fail_count, status, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
        )
        .run(
          w.id, w.userId, w.missionId, w.kind, c.seal(dek(w.userId), w.target, `watchers|target_enc|${w.id}`),
          c.sealJson(dek(w.userId), w.condition, `watchers|condition_enc|${w.id}`), w.intervalMin, w.nextCheckAt, w.threadId, w.createdAt,
        );
    },
    getWatcher(id: string): WatcherRow | undefined {
      const r = db().prepare(`SELECT * FROM watchers WHERE id = ?`).get<Raw>(id);
      return r ? toWatcher(r) : undefined;
    },
    listWatchers(userId: UserId): WatcherRow[] {
      return db().prepare(`SELECT * FROM watchers WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`).all<Raw>(userId).map(toWatcher);
    },
    watchersOfMission(missionId: string): WatcherRow[] {
      return db().prepare(`SELECT * FROM watchers WHERE mission_id = ?`).all<Raw>(missionId).map(toWatcher);
    },
    countLiveWatchers(userId: UserId): number {
      const r = db().prepare(`SELECT COUNT(*) AS n FROM watchers WHERE user_id = ? AND status IN ('active','paused')`).get<{ n: number }>(userId);
      return Number(r?.n ?? 0);
    },
    setWatcherStatus(id: string, status: WatcherStatus): void {
      db().prepare(`UPDATE watchers SET status = ? WHERE id = ?`).run(status, id);
    },
    setWatcherJob(id: string, jobId: string | null, nextCheckAt: Ms): void {
      db().prepare(`UPDATE watchers SET job_id = ?, next_check_at = ? WHERE id = ?`).run(jobId, nextCheckAt, id);
    },
    /** A successful check: new hash/value (when given), fail_count reset. */
    recordCheck(w: Pick<WatcherRow, 'id' | 'userId'>, p: { at: Ms; next: Ms; hash?: string; value?: string }): void {
      if (p.hash !== undefined && p.value !== undefined) {
        db()
          .prepare(`UPDATE watchers SET last_hash = ?, last_value_enc = ?, last_checked_at = ?, next_check_at = ?, fail_count = 0 WHERE id = ?`)
          .run(p.hash, crypto().seal(dek(w.userId), p.value, `watchers|last_value_enc|${w.id}`), p.at, p.next, w.id);
      } else {
        db().prepare(`UPDATE watchers SET last_checked_at = ?, next_check_at = ?, fail_count = 0 WHERE id = ?`).run(p.at, p.next, w.id);
      }
    },
    /** Moves the next check without recording a check (skipped or deferred check: hash and fail_count kept). */
    setNextCheck(id: string, nextCheckAt: Ms): void {
      db().prepare(`UPDATE watchers SET next_check_at = ? WHERE id = ?`).run(nextCheckAt, id);
    },
    /** A failed check: fail_count + 1; returns the new count. */
    recordFailure(id: string, at: Ms, next: Ms): number {
      const d = db();
      return d.tx(() => {
        d.prepare(`UPDATE watchers SET fail_count = fail_count + 1, last_checked_at = ?, next_check_at = ? WHERE id = ?`).run(at, next, id);
        return Number(d.prepare(`SELECT fail_count FROM watchers WHERE id = ?`).get<Raw>(id)?.['fail_count'] ?? 0);
      });
    },
    resetFailures(id: string): void {
      db().prepare(`UPDATE watchers SET fail_count = 0 WHERE id = ?`).run(id);
    },
    watcherJobIds(userId: UserId): string[] {
      return db().prepare(`SELECT id FROM watchers WHERE user_id = ?`).all<Raw>(userId).map((r) => `wch:${String(r['id'])}`);
    },
  };
}

export type MissionRepo = ReturnType<typeof createMissionRepo>;
