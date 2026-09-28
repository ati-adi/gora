// proactive/repo.ts (WP6b) — all SQL for the WP6b proactivity tables: nudges, nudge_prefs, commitments (01 §7.1/§7.2).
// Text columns are sealed under the owner's DEK 'u:<userId>' with AAD '<table>|<column>|<id>' (never logged).
import type { Crypto, Db, Ms, NudgeCandidate, NudgeKind, UserId } from '../contracts/index.ts';
import { DEFAULT_PREF, type NudgePref } from './nudgeGate.ts';

export type NudgeStatus = 'candidate' | 'sent' | 'deferred' | 'dropped';
export type NudgeOutcome = 'do' | 'snooze' | 'never' | 'ignored' | 'reaction_up' | 'reaction_down';

export interface NudgeRow {
  id: string; userId: UserId; kind: NudgeKind; dedupeKey: string; refId: string | null; why: string; body: string; score: number;
  priority: 'low' | 'normal' | 'high'; countsAgainstBudget: boolean; status: NudgeStatus; deferUntil: Ms | null; localDay: string | null;
  sentAt: Ms | null; tgChatId: number | null; tgMessageId: number | null; outcome: NudgeOutcome | null; outcomeAt: Ms | null; createdAt: Ms;
}

export interface CommitmentRow {
  id: string; userId: UserId; source: 'dm' | 'business'; businessConnectionId: string | null; chatId: number | null; sourceMessageId: number | null;
  sourceInputId: string | null; direction: 'i_owe' | 'they_owe'; text: string; counterpart: string | null; dueAt: Ms | null;
  status: 'open' | 'nudged' | 'done' | 'dismissed'; jobId: string | null; createdAt: Ms;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const u8 = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : null);

export function createProactiveRepo(db: () => Db, crypto: () => Crypto) {
  const dek = (userId: string) => `u:${userId}`;
  const open = (ct: unknown, aad: string): string => {
    const b = u8(ct);
    if (!b) return '';
    try {
      return crypto().openText(b, aad);
    } catch {
      return ''; // destroyed DEK (user deleted) → nothing readable
    }
  };

  const toNudge = (r: Raw): NudgeRow => {
    const id = String(r['id']);
    return {
      id, userId: String(r['user_id']), kind: String(r['kind']) as NudgeKind, dedupeKey: String(r['dedupe_key']), refId: str(r['ref_id']),
      why: open(r['why_enc'], `nudges|why_enc|${id}`), body: open(r['body_enc'], `nudges|body_enc|${id}`), score: Number(r['score']),
      priority: String(r['priority']) as NudgeRow['priority'], countsAgainstBudget: Number(r['counts_against_budget']) === 1,
      status: String(r['status']) as NudgeStatus, deferUntil: num(r['defer_until']), localDay: str(r['local_day']), sentAt: num(r['sent_at']),
      tgChatId: num(r['tg_chat_id']), tgMessageId: num(r['tg_message_id']), outcome: str(r['outcome']) as NudgeOutcome | null,
      outcomeAt: num(r['outcome_at']), createdAt: Number(r['created_at']),
    };
  };

  const toCommitment = (r: Raw): CommitmentRow => {
    const id = String(r['id']);
    const cp = u8(r['counterpart_enc']);
    return {
      id, userId: String(r['user_id']), source: String(r['source']) as CommitmentRow['source'], businessConnectionId: str(r['business_connection_id']),
      chatId: num(r['chat_id']), sourceMessageId: num(r['source_message_id']), sourceInputId: str(r['source_input_id']),
      direction: String(r['direction']) as CommitmentRow['direction'], text: open(r['text_enc'], `commitments|text_enc|${id}`),
      counterpart: cp ? open(cp, `commitments|counterpart_enc|${id}`) || null : null, dueAt: num(r['due_at']),
      status: String(r['status']) as CommitmentRow['status'], jobId: str(r['job_id']), createdAt: Number(r['created_at']),
    };
  };

  return {
    // ───────────────────────── nudges
    insertNudge(id: string, c: NudgeCandidate, o: { status: NudgeStatus; deferUntil?: Ms | null; localDay?: string | null; sentAt?: Ms | null; now: Ms }): void {
      const c8 = crypto();
      db()
        .prepare(
          `INSERT INTO nudges (id, user_id, kind, dedupe_key, ref_id, why_enc, body_enc, score, priority, counts_against_budget, status, defer_until, local_day, sent_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, c.userId, c.kind, c.dedupeKey, c.refId ?? null,
          c8.seal(dek(c.userId), c.why, `nudges|why_enc|${id}`), c8.seal(dek(c.userId), c.body, `nudges|body_enc|${id}`),
          c.score, c.priority, c.countsAgainstBudget ? 1 : 0, o.status, o.deferUntil ?? null, o.localDay ?? null, o.sentAt ?? null, o.now,
        );
    },
    getNudge(id: string): NudgeRow | undefined {
      const r = db().prepare(`SELECT * FROM nudges WHERE id = ?`).get<Raw>(id);
      return r ? toNudge(r) : undefined;
    },
    setNudgeStatus(id: string, p: { status: NudgeStatus; deferUntil?: Ms | null; localDay?: string | null; sentAt?: Ms | null }): void {
      db()
        .prepare(`UPDATE nudges SET status = ?, defer_until = ?, local_day = ?, sent_at = ? WHERE id = ?`)
        .run(p.status, p.deferUntil ?? null, p.localDay ?? null, p.sentAt ?? null, id);
    },
    setNudgeMessage(id: string, chatId: number, messageId: number): void {
      db().prepare(`UPDATE nudges SET tg_chat_id = ?, tg_message_id = ? WHERE id = ?`).run(chatId, messageId, id);
    },
    /** Sets the outcome only when none is recorded yet (first interaction wins); returns whether it changed. */
    setOutcomeOnce(id: string, outcome: NudgeOutcome, now: Ms): boolean {
      const r = db().prepare(`UPDATE nudges SET outcome = ?, outcome_at = ? WHERE id = ? AND outcome IS NULL`).run(outcome, now, id);
      return Number(r.changes) === 1;
    },
    /** Reactions may follow a button tap: they overwrite only other reactions or nothing. */
    setReactionOutcome(id: string, outcome: 'reaction_up' | 'reaction_down', now: Ms): boolean {
      const r = db()
        .prepare(`UPDATE nudges SET outcome = ?, outcome_at = ? WHERE id = ? AND (outcome IS NULL OR outcome IN ('reaction_up','reaction_down','ignored')) AND (outcome IS NULL OR outcome != ?)`)
        .run(outcome, now, id, outcome);
      return Number(r.changes) === 1;
    },
    clearOutcome(id: string): void {
      db().prepare(`UPDATE nudges SET outcome = NULL, outcome_at = NULL WHERE id = ?`).run(id);
    },
    /** The same dedupe key sent since `since`, or currently deferred (a deferred copy is still pending delivery). */
    dedupeHit(userId: UserId, dedupeKey: string, since: Ms, excludeId?: string): boolean {
      const r = db()
        .prepare(
          `SELECT 1 FROM nudges WHERE user_id = ? AND dedupe_key = ? AND id != ?
             AND ((status = 'sent' AND sent_at >= ?) OR status = 'deferred') LIMIT 1`,
        )
        .get(userId, dedupeKey, excludeId ?? '', since);
      return r !== undefined;
    },
    sentToday(userId: UserId, day: string, excludeId?: string): number {
      const r = db()
        .prepare(`SELECT COUNT(*) AS n FROM nudges WHERE user_id = ? AND local_day = ? AND status = 'sent' AND counts_against_budget = 1 AND id != ?`)
        .get<{ n: number }>(userId, day, excludeId ?? '');
      return Number(r?.n ?? 0);
    },
    listNudgesForExport(userId: UserId, limit: number): NudgeRow[] {
      return db()
        .prepare(`SELECT * FROM nudges WHERE user_id = ? AND status IN ('sent','deferred') ORDER BY created_at DESC LIMIT ?`)
        .all<Raw>(userId, limit)
        .map(toNudge);
    },
    /** §11.9 retention: dropped/candidate rows carry nothing the owner saw; kept 30 days for diagnostics. */
    deleteStaleNudges(before: Ms): number {
      return Number(db().prepare(`DELETE FROM nudges WHERE status IN ('dropped','candidate') AND created_at < ?`).run(before).changes);
    },

    // ───────────────────────── nudge_prefs
    pref(userId: UserId, kind: NudgeKind): NudgePref {
      const r = db().prepare(`SELECT muted, snooze_until, weight, ignored_streak FROM nudge_prefs WHERE user_id = ? AND kind = ?`).get<Raw>(userId, kind);
      if (!r) return { ...DEFAULT_PREF };
      return { muted: Number(r['muted']) === 1, snoozeUntil: num(r['snooze_until']), weight: Number(r['weight']), ignoredStreak: Number(r['ignored_streak']) };
    },
    allPrefs(userId: UserId): Map<NudgeKind, NudgePref> {
      const m = new Map<NudgeKind, NudgePref>();
      for (const r of db().prepare(`SELECT kind, muted, snooze_until, weight, ignored_streak FROM nudge_prefs WHERE user_id = ?`).all<Raw>(userId)) {
        m.set(String(r['kind']) as NudgeKind, { muted: Number(r['muted']) === 1, snoozeUntil: num(r['snooze_until']), weight: Number(r['weight']), ignoredStreak: Number(r['ignored_streak']) });
      }
      return m;
    },
    upsertPref(userId: UserId, kind: NudgeKind, p: Partial<NudgePref>): void {
      const d = db();
      d.tx(() => {
        d.prepare(`INSERT INTO nudge_prefs (user_id, kind) VALUES (?, ?) ON CONFLICT (user_id, kind) DO NOTHING`).run(userId, kind);
        if (p.muted !== undefined) d.prepare(`UPDATE nudge_prefs SET muted = ? WHERE user_id = ? AND kind = ?`).run(p.muted ? 1 : 0, userId, kind);
        if (p.snoozeUntil !== undefined) d.prepare(`UPDATE nudge_prefs SET snooze_until = ? WHERE user_id = ? AND kind = ?`).run(p.snoozeUntil, userId, kind);
        if (p.weight !== undefined) d.prepare(`UPDATE nudge_prefs SET weight = ? WHERE user_id = ? AND kind = ?`).run(p.weight, userId, kind);
        if (p.ignoredStreak !== undefined) d.prepare(`UPDATE nudge_prefs SET ignored_streak = ? WHERE user_id = ? AND kind = ?`).run(p.ignoredStreak, userId, kind);
      });
    },

    // ───────────────────────── commitments
    insertCommitment(c: Omit<CommitmentRow, 'jobId' | 'status'> & { status?: CommitmentRow['status'] }): void {
      const c8 = crypto();
      db()
        .prepare(
          `INSERT INTO commitments (id, user_id, source, business_connection_id, chat_id, source_message_id, source_input_id, direction, text_enc, counterpart_enc, due_at, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id, c.userId, c.source, c.businessConnectionId, c.chatId, c.sourceMessageId, c.sourceInputId, c.direction,
          c8.seal(dek(c.userId), c.text, `commitments|text_enc|${c.id}`),
          c.counterpart ? c8.seal(dek(c.userId), c.counterpart, `commitments|counterpart_enc|${c.id}`) : null,
          c.dueAt, c.status ?? 'open', c.createdAt,
        );
    },
    getCommitment(id: string): CommitmentRow | undefined {
      const r = db().prepare(`SELECT * FROM commitments WHERE id = ?`).get<Raw>(id);
      return r ? toCommitment(r) : undefined;
    },
    setCommitmentJob(id: string, jobId: string | null): void {
      db().prepare(`UPDATE commitments SET job_id = ? WHERE id = ?`).run(jobId, id);
    },
    setCommitmentStatus(id: string, status: CommitmentRow['status']): void {
      db().prepare(`UPDATE commitments SET status = ? WHERE id = ?`).run(status, id);
    },
    /** open → nudged only (never reopens a closed commitment). */
    markCommitmentNudged(id: string): void {
      db().prepare(`UPDATE commitments SET status = 'nudged' WHERE id = ? AND status = 'open'`).run(id);
    },
    /** Open commitments; `onlyUnnudged` leaves out those already surfaced once (status 'nudged'). */
    openCommitments(userId: UserId, o: { direction?: 'i_owe' | 'they_owe'; limit: number; onlyUnnudged?: boolean }): CommitmentRow[] {
      const st = o.onlyUnnudged ? `status = 'open'` : `status IN ('open','nudged')`;
      const rows = o.direction
        ? db().prepare(`SELECT * FROM commitments WHERE user_id = ? AND ${st} AND direction = ? ORDER BY COALESCE(due_at, created_at) LIMIT ?`).all<Raw>(userId, o.direction, o.limit)
        : db().prepare(`SELECT * FROM commitments WHERE user_id = ? AND ${st} ORDER BY COALESCE(due_at, created_at) LIMIT ?`).all<Raw>(userId, o.limit);
      return rows.map(toCommitment);
    },
    /** Open commitments that came from the same owner input / business message (dedupe on re-extraction). */
    sameSource(userId: UserId, o: { sourceInputId?: string | null; connectionId?: string | null; chatId?: number | null; sourceMessageId?: number | null }): CommitmentRow[] {
      if (o.sourceInputId) return db().prepare(`SELECT * FROM commitments WHERE user_id = ? AND source_input_id = ?`).all<Raw>(userId, o.sourceInputId).map(toCommitment);
      if (o.connectionId && o.chatId !== null && o.chatId !== undefined && o.sourceMessageId !== null && o.sourceMessageId !== undefined) {
        return db()
          .prepare(`SELECT * FROM commitments WHERE user_id = ? AND business_connection_id = ? AND chat_id = ? AND source_message_id = ?`)
          .all<Raw>(userId, o.connectionId, o.chatId, o.sourceMessageId)
          .map(toCommitment);
      }
      return [];
    },
    bySourceMessages(connectionId: string, chatId: number, messageIds: number[]): Array<{ id: string; jobId: string | null }> {
      if (messageIds.length === 0) return [];
      const out: Array<{ id: string; jobId: string | null }> = [];
      for (let i = 0; i < messageIds.length; i += 200) {
        const part = messageIds.slice(i, i + 200);
        const rows = db()
          .prepare(`SELECT id, job_id FROM commitments WHERE business_connection_id = ? AND chat_id = ? AND source_message_id IN (${part.map(() => '?').join(',')})`)
          .all<Raw>(connectionId, chatId, ...part);
        for (const r of rows) out.push({ id: String(r['id']), jobId: str(r['job_id']) });
      }
      return out;
    },
    deleteCommitments(ids: string[]): number {
      let n = 0;
      const d = db();
      d.tx(() => {
        for (const id of ids) n += Number(d.prepare(`DELETE FROM commitments WHERE id = ?`).run(id).changes);
      });
      return n;
    },
    listCommitmentsForExport(userId: UserId): CommitmentRow[] {
      return db().prepare(`SELECT * FROM commitments WHERE user_id = ? ORDER BY created_at`).all<Raw>(userId).map(toCommitment);
    },
    commitmentJobIds(userId: UserId): string[] {
      return db().prepare(`SELECT job_id FROM commitments WHERE user_id = ? AND job_id IS NOT NULL`).all<Raw>(userId).map((r) => String(r['job_id']));
    },
  };
}

export type ProactiveRepo = ReturnType<typeof createProactiveRepo>;
