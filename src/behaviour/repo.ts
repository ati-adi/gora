// behaviour/repo.ts (friend set B, spec 05 §C/§D) — all SQL for user_signals, user_rhythm, proactive_arms and proactive_log.
// user_signals holds features only (numbers and enums, never message text). proactive_log.judge_reason_enc is sealed JSON
// {reason, text} under the owner's DEK 'u:<userId>' (AAD 'proactive_log|judge_reason_enc|<id>'): the friend check needs the
// last proactive texts to veto repetition; the row goes with the user (USER_DATA_TABLES) and the 90-day retention sweep.
import type { Crypto, Db, GapBucket, Ms, ProactiveContentType, SignalKind, UserId } from '../contracts/index.ts';

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface SignalRow {
  kind: SignalKind; at: Ms; localHour?: number | null; localWeekday?: number | null; length?: number | null; emoji?: number | null;
  lang?: string | null; question?: boolean | null; register?: 'informal' | 'formal' | null; source?: string | null; arm?: string | null;
  refId?: string | null; latencyMs?: number | null; value?: string | null;
}
export interface RhythmRow { hist: Float64Array; style: StyleState | null; updatedAt: Ms }
/**
 * C3 EMAs (numbers only). `since`: first inbound seen (the rhythm's observation window). `utc`: the row's histogram is
 * binned by UTC hour-of-week (rows written before that fix were binned in the zone users.tz held at the time).
 */
export interface StyleState { n: number; len: number; emoji: number; formal: number | null; registerN: number; scripts: Record<string, number>; since: Ms; utc?: boolean }
export interface ArmRow { arm: string; alpha: number; beta: number }
export interface ProactiveLogRow {
  id: string; userId: UserId; arm: string; contentType: ProactiveContentType; gapBucket: GapBucket; score: number; sent: boolean;
  reason: string; text: string; tgChatId: number | null; tgMessageId: number | null; createdAt: Ms; sentAt: Ms | null; repliedAt: Ms | null; reward: 0 | 1 | null;
}

export const HIST_BINS = 168;

export function histToBytes(h: Float64Array): Uint8Array {
  const out = new Uint8Array(HIST_BINS * 8);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < HIST_BINS; i++) dv.setFloat64(i * 8, h[i] ?? 0, true);
  return out;
}
export function bytesToHist(b: Uint8Array): Float64Array {
  const h = new Float64Array(HIST_BINS);
  if (b.byteLength !== HIST_BINS * 8) return h;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < HIST_BINS; i++) {
    const v = dv.getFloat64(i * 8, true);
    h[i] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return h;
}

export function createBehaviourRepo(db: () => Db, crypto: () => Crypto) {
  const aad = (id: string) => `proactive_log|judge_reason_enc|${id}`;
  const openLog = (r: Raw): { reason: string; text: string } => {
    const b = r['judge_reason_enc'];
    if (!(b instanceof Uint8Array)) return { reason: '', text: '' };
    try {
      const v = crypto().openJson<{ reason?: unknown; text?: unknown }>(b, aad(String(r['id'])));
      return { reason: typeof v.reason === 'string' ? v.reason : '', text: typeof v.text === 'string' ? v.text : '' };
    } catch {
      return { reason: '', text: '' }; // destroyed DEK (user deleted)
    }
  };
  const toLog = (r: Raw): ProactiveLogRow => {
    const o = openLog(r);
    const rw = num(r['reward']);
    return {
      id: String(r['id']), userId: String(r['user_id']), arm: String(r['arm']), contentType: String(r['content_type']) as ProactiveContentType,
      gapBucket: String(r['gap_bucket']) as GapBucket, score: Number(r['score']), sent: Number(r['sent']) === 1, reason: o.reason, text: o.text,
      tgChatId: num(r['tg_chat_id']), tgMessageId: num(r['tg_message_id']), createdAt: Number(r['created_at']), sentAt: num(r['sent_at']),
      repliedAt: num(r['replied_at']), reward: rw === 0 || rw === 1 ? rw : null,
    };
  };

  return {
    // ───────────────────────── user_signals (append-only)
    addSignal(userId: UserId, s: SignalRow): void {
      db()
        .prepare(
          `INSERT INTO user_signals (user_id, kind, at, local_hour, local_weekday, length, emoji, lang, question, register, source, arm, ref_id, latency_ms, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId, s.kind, s.at, s.localHour ?? null, s.localWeekday ?? null, s.length ?? null, s.emoji ?? null, s.lang ?? null,
          s.question === undefined || s.question === null ? null : s.question ? 1 : 0, s.register ?? null, s.source ?? null, s.arm ?? null,
          s.refId ?? null, s.latencyMs ?? null, s.value ?? null,
        );
    },
    /** Latest `at` of a signal kind (optionally since a time). */
    lastSignalAt(userId: UserId, kinds: readonly SignalKind[]): Ms | null {
      const q = `SELECT MAX(at) AS m FROM user_signals WHERE user_id = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      return num(db().prepare(q).get<{ m: number | null }>(userId, ...kinds)?.m);
    },
    /** gora_sent rows from `sources` at or after `since`. */
    countGoraSent(userId: UserId, sources: readonly string[], since: Ms): number {
      const q = `SELECT COUNT(*) AS n FROM user_signals WHERE user_id = ? AND kind = 'gora_sent' AND at >= ? AND source IN (${sources.map(() => '?').join(',')})`;
      return Number(db().prepare(q).get<{ n: number }>(userId, since, ...sources)?.n ?? 0);
    },
    /** gora_sent item fingerprints (value) since `since` (never text). */
    sentFingerprints(userId: UserId, since: Ms): Set<string> {
      const rows = db().prepare(`SELECT value FROM user_signals WHERE user_id = ? AND kind = 'gora_sent' AND at >= ? AND value IS NOT NULL`).all<{ value: string }>(userId, since);
      return new Set(rows.map((r) => r.value));
    },
    signalCounts(userId: UserId): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of db().prepare(`SELECT kind, COUNT(*) AS n FROM user_signals WHERE user_id = ? GROUP BY kind`).all<{ kind: string; n: number }>(userId)) out[r.kind] = Number(r.n);
      return out;
    },
    /**
     * 90-day retention. The rows that anchor a safety cap survive it: the Gora-first messages sent since the owner last
     * wrote or replied (the "unanswered" streak and its hard stop hold until the owner writes, C4), however old.
     */
    deleteSignalsBefore(before: Ms): number {
      return Number(
        db()
          .prepare(
            `DELETE FROM user_signals WHERE at < ? AND NOT (kind = 'gora_sent' AND at > COALESCE(
               (SELECT MAX(x.at) FROM user_signals x WHERE x.user_id = user_signals.user_id AND x.kind IN ('inbound','reply')), -1))`,
          )
          .run(before).changes,
      );
    },

    // ───────────────────────── user_rhythm
    getRhythm(userId: UserId): RhythmRow | undefined {
      const r = db().prepare(`SELECT hist_blob, style_json, updated_at FROM user_rhythm WHERE user_id = ?`).get<Raw>(userId);
      if (!r) return undefined;
      let style: StyleState | null = null;
      try {
        style = r['style_json'] ? (JSON.parse(String(r['style_json'])) as StyleState) : null;
      } catch {
        style = null;
      }
      return { hist: bytesToHist(r['hist_blob'] as Uint8Array), style, updatedAt: Number(r['updated_at']) };
    },
    putRhythm(userId: UserId, row: RhythmRow): void {
      db()
        .prepare(
          `INSERT INTO user_rhythm (user_id, hist_blob, style_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET hist_blob = excluded.hist_blob, style_json = excluded.style_json, updated_at = excluded.updated_at`,
        )
        .run(userId, histToBytes(row.hist), row.style ? JSON.stringify(row.style) : null, row.updatedAt);
    },
    /** Every user's rhythm (population prior); ids are not needed. */
    allRhythms(limit: number): Array<{ userId: UserId; hist: Float64Array; since: Ms | null; updatedAt: Ms; utc: boolean }> {
      return db()
        .prepare(`SELECT user_id, hist_blob, style_json, updated_at FROM user_rhythm ORDER BY updated_at DESC LIMIT ?`)
        .all<Raw>(limit)
        .map((r) => {
          let since: Ms | null = null;
          let utc = false;
          try {
            const st = r['style_json'] ? (JSON.parse(String(r['style_json'])) as Partial<StyleState>) : null;
            since = typeof st?.since === 'number' ? st.since : null;
            utc = st?.utc === true;
          } catch {
            since = null;
          }
          return { userId: String(r['user_id']), hist: bytesToHist(r['hist_blob'] as Uint8Array), since, updatedAt: Number(r['updated_at']), utc };
        });
    },

    // ───────────────────────── proactive_arms (the user's evidence; priors are computed at decision time)
    arms(userId: UserId): Map<string, ArmRow> {
      const m = new Map<string, ArmRow>();
      for (const r of db().prepare(`SELECT arm, alpha, beta FROM proactive_arms WHERE user_id = ?`).all<Raw>(userId)) {
        m.set(String(r['arm']), { arm: String(r['arm']), alpha: Number(r['alpha']), beta: Number(r['beta']) });
      }
      return m;
    },
    /** Pooled evidence per arm over every user. */
    pooledArms(): Map<string, { alpha: number; beta: number }> {
      const m = new Map<string, { alpha: number; beta: number }>();
      for (const r of db().prepare(`SELECT arm, SUM(alpha) AS a, SUM(beta) AS b FROM proactive_arms GROUP BY arm`).all<Raw>()) {
        m.set(String(r['arm']), { alpha: Number(r['a'] ?? 0), beta: Number(r['b'] ?? 0) });
      }
      return m;
    },
    bumpArm(userId: UserId, arm: string, dAlpha: number, dBeta: number, now: Ms): void {
      db()
        .prepare(
          `INSERT INTO proactive_arms (user_id, arm, alpha, beta, updated_at) VALUES (?, ?, MAX(0, ?), MAX(0, ?), ?)
           ON CONFLICT(user_id, arm) DO UPDATE SET alpha = MAX(0, alpha + ?), beta = MAX(0, beta + ?), updated_at = excluded.updated_at`,
        )
        .run(userId, arm, dAlpha, dBeta, now, dAlpha, dBeta);
    },

    // ───────────────────────── proactive_log
    insertLog(r: { id: string; userId: UserId; arm: string; contentType: ProactiveContentType; gapBucket: GapBucket; score: number; sent: boolean; reason: string; text: string; now: Ms }): void {
      db()
        .prepare(
          `INSERT INTO proactive_log (id, user_id, arm, content_type, gap_bucket, score, sent, judge_reason_enc, created_at, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id, r.userId, r.arm, r.contentType, r.gapBucket, r.score, r.sent ? 1 : 0,
          crypto().sealJson(`u:${r.userId}`, { reason: r.reason, text: r.text }, aad(r.id)), r.now, r.sent ? r.now : null,
        );
    },
    getLog(id: string): ProactiveLogRow | undefined {
      const r = db().prepare(`SELECT * FROM proactive_log WHERE id = ?`).get<Raw>(id);
      return r ? toLog(r) : undefined;
    },
    setLogMessage(id: string, chatId: number, messageId: number, sentAt: Ms): void {
      db().prepare(`UPDATE proactive_log SET tg_chat_id = ?, tg_message_id = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?`).run(chatId, messageId, sentAt, id);
    },
    /** The open (sent, unrewarded) proactive message whose window covers `at`, newest first. */
    openLog(userId: UserId, at: Ms, windowMs: Ms): ProactiveLogRow | undefined {
      const r = db()
        .prepare(`SELECT * FROM proactive_log WHERE user_id = ? AND sent = 1 AND reward IS NULL AND sent_at <= ? AND sent_at > ? ORDER BY sent_at DESC LIMIT 1`)
        .get<Raw>(userId, at, at - windowMs);
      return r ? toLog(r) : undefined;
    },
    lastSentLog(userId: UserId, since: Ms): ProactiveLogRow | undefined {
      const r = db().prepare(`SELECT * FROM proactive_log WHERE user_id = ? AND sent = 1 AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`).get<Raw>(userId, since);
      return r ? toLog(r) : undefined;
    },
    /** Sets the reward once; returns whether this call set it. */
    setReward(id: string, reward: 0 | 1, repliedAt: Ms | null): boolean {
      return Number(db().prepare(`UPDATE proactive_log SET reward = ?, replied_at = ? WHERE id = ? AND reward IS NULL`).run(reward, repliedAt, id).changes) === 1;
    },
    /** Replaces a reward already set (a "stop" after a reply turns the reply into a strong negative). */
    overrideReward(id: string, reward: 0 | 1): void {
      db().prepare(`UPDATE proactive_log SET reward = ? WHERE id = ?`).run(reward, id);
    },
    /** Sent rows whose reply window closed without a reward. */
    expiredOpen(before: Ms, limit: number): ProactiveLogRow[] {
      return db().prepare(`SELECT * FROM proactive_log WHERE sent = 1 AND reward IS NULL AND sent_at <= ? ORDER BY sent_at LIMIT ?`).all<Raw>(before, limit).map(toLog);
    },
    recentSent(userId: UserId, limit: number): ProactiveLogRow[] {
      return db().prepare(`SELECT * FROM proactive_log WHERE user_id = ? AND sent = 1 ORDER BY sent_at DESC LIMIT ?`).all<Raw>(userId, limit).map(toLog);
    },
    countSentOfType(userId: UserId, t: ProactiveContentType): number {
      return Number(db().prepare(`SELECT COUNT(*) AS n FROM proactive_log WHERE user_id = ? AND sent = 1 AND content_type = ?`).get<{ n: number }>(userId, t)?.n ?? 0);
    },
    /**
     * Forget (01 §9): every proactive text of the user that `keep` rejects (it holds forgotten text) is re-sealed empty.
     * Returns the texts that were dropped.
     */
    scrubTexts(userId: UserId, keep: (texts: string[]) => string[]): string[] {
      const d = db();
      const rows = d.prepare(`SELECT * FROM proactive_log WHERE user_id = ? AND judge_reason_enc IS NOT NULL`).all<Raw>(userId);
      const dropped: string[] = [];
      for (const r of rows) {
        const o = openLog(r);
        if (!o.text || keep([o.text]).length) continue;
        const id = String(r['id']);
        d.prepare(`UPDATE proactive_log SET judge_reason_enc = ? WHERE id = ?`).run(crypto().sealJson(`u:${userId}`, { reason: o.reason, text: '' }, aad(id)), id);
        dropped.push(o.text);
      }
      return dropped;
    },
    logsForExport(userId: UserId, limit: number): ProactiveLogRow[] {
      return db().prepare(`SELECT * FROM proactive_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all<Raw>(userId, limit).map(toLog);
    },
    /**
     * 90-day retention of settled rows. A sent first_hint row is kept (its text dropped): it is the "at most 2 hints"
     * counter for an owner who never wrote (C4), which must not reset every 90 days.
     */
    deleteLogsBefore(before: Ms): number {
      const d = db();
      d.prepare(`UPDATE proactive_log SET judge_reason_enc = NULL WHERE created_at < ? AND content_type = 'first_hint' AND sent = 1 AND judge_reason_enc IS NOT NULL`).run(before);
      return Number(
        d.prepare(`DELETE FROM proactive_log WHERE created_at < ? AND (reward IS NOT NULL OR sent = 0) AND NOT (content_type = 'first_hint' AND sent = 1)`).run(before).changes,
      );
    },
  };
}
export type BehaviourRepo = ReturnType<typeof createBehaviourRepo>;
