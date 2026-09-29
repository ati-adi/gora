// groups/repo.ts (GR, spec 07 C3/C4) — SQL for group_messages, group_summaries and group_policy (migration 004).
// Every personal text is sealed under the group DEK 'g:<chatId>' (owner 'grp:<chatId>', so destroyOwner covers it) with
// AAD '<table>|<column>|<chatId>:<key>'. The sender is kept as a per-group pseudonym (hmac 'member') plus the Telegram
// id (needed for a member's own /deletemydata and for "since your last message"). No plaintext ever reaches the DB.
import type { Crypto, Db, GroupChattiness, GroupChimeKind, Ms } from '../contracts/index.ts';
import { GROUP_CHIME_KINDS, GROUP_DATA_TABLES } from '../contracts/index.ts';
import { DekDestroyedError } from '../kernel/errors.ts';

export type StoredKind = 'text' | 'caption' | 'voice' | 'bot';
export type Addressed = 'mention' | 'reply' | 'name' | 'command' | null;

export interface StoredMessage {
  chatId: number;
  tgMessageId: number;
  threadId: number | null;
  fromTgId: number;
  kind: StoredKind;
  addressed: Addressed;
  replyToTgMessageId: number | null;
  text: string;
  senderName: string | null;
  chimeKind: GroupChimeKind | null;
  at: Ms;
}

export interface SummaryRow {
  chatId: number; version: number; summary: string | null; coveredUntilAt: Ms; pendingCount: number; factsUntilAt: Ms | null; updatedAt: Ms;
  /** Oldest message folded into the summary text (migration 005); null = unknown (legacy row) or no text. */
  coveredFromAt: Ms | null;
}

/** Evidence per arm (successes, failures); the prior is added when a decision is made. */
export type ArmEvidence = Record<GroupChimeKind, [number, number]>;

export interface PolicyRow {
  chatId: number;
  chattiness: GroupChattiness;
  thresholdAdj: number;
  arms: ArmEvidence;
  readsAll: boolean | null;
  tz: string | null;
  lang: string | null;
  lastActivityAt: Ms | null;
  lastChimeAt: Ms | null;
  chimesDay: string | null;
  chimesToday: number;
  openChimeTgMessageId: number | null;
  openChimeKind: GroupChimeKind | null;
  openChimeAt: Ms | null;
  joinLineAt: Ms | null;
}

const dekOf = (chatId: number) => `g:${chatId}`;
const MAX_GEN = 10_000;
const aad = (table: string, column: string, chatId: number, key: string | number) => `${table}|${column}|${chatId}:${key}`;
const isKind = (k: unknown): k is GroupChimeKind => typeof k === 'string' && (GROUP_CHIME_KINDS as readonly string[]).includes(k);

export function emptyArms(): ArmEvidence {
  return Object.fromEntries(GROUP_CHIME_KINDS.map((k) => [k, [0, 0]])) as unknown as ArmEvidence;
}

function parseArms(json: string): ArmEvidence {
  const out = emptyArms();
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    for (const k of GROUP_CHIME_KINDS) {
      const a = v[k];
      if (Array.isArray(a) && a.length === 2 && a.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) out[k] = [a[0] as number, a[1] as number];
    }
  } catch {
    /* a corrupt row starts from the prior */
  }
  return out;
}

interface RawMsg {
  chat_id: number; tg_message_id: number; thread_id: number | null; from_tg_id: number; kind: StoredKind; addressed: Addressed;
  reply_to_tg_message_id: number | null; text_enc: Uint8Array; sender_name_enc: Uint8Array | null; chime_kind: string | null; at: number;
}
interface RawPolicy {
  chat_id: number; chattiness: GroupChattiness; threshold_adj: number; arms_json: string; reads_all: number | null; tz: string | null; lang: string | null;
  last_activity_at: number | null; last_chime_at: number | null; chimes_day: string | null; chimes_today: number;
  open_chime_tg_message_id: number | null; open_chime_kind: string | null; open_chime_at: number | null; join_line_at: number | null;
}

const MSG_COLS = 'chat_id, tg_message_id, thread_id, from_tg_id, kind, addressed, reply_to_tg_message_id, text_enc, sender_name_enc, chime_kind, at';

export function createGroupRepo(db: Db, crypto: Crypto, clock: { now(): Ms }) {
  /**
   * The live DEK for new group text (s07 lead fix, skeptic "re-added group"): 'g:<chatId>', or — once the surfaces
   * retention destroyed it (the bot left, 7-day grace) and the bot was added back — the next generation
   * 'g:<chatId>:<n>' (same owner 'grp:<chatId>', so the next shred destroys it too), exactly like reminders' group to-dos.
   */
  const sealDek = (chatId: number): string => {
    const base = dekOf(chatId);
    if (!crypto.isDestroyed(base)) return base;
    for (let n = 2; n < MAX_GEN; n++) {
      const id = `${base}:${n}`;
      if (!crypto.isDestroyed(id)) return id;
    }
    return base;
  };
  const destroyedUnder = (ct: Uint8Array, aadText: string): boolean => {
    try {
      crypto.open(ct, aadText);
      return false;
    } catch (e) {
      return e instanceof DekDestroyedError;
    }
  };
  const open = (r: RawMsg): StoredMessage | null => {
    try {
      const chatId = Number(r.chat_id);
      const id = Number(r.tg_message_id);
      return {
        chatId, tgMessageId: id, threadId: r.thread_id === null ? null : Number(r.thread_id), fromTgId: Number(r.from_tg_id), kind: r.kind, addressed: r.addressed,
        replyToTgMessageId: r.reply_to_tg_message_id === null ? null : Number(r.reply_to_tg_message_id),
        text: crypto.openText(r.text_enc, aad('group_messages', 'text_enc', chatId, id)),
        senderName: r.sender_name_enc ? crypto.openText(r.sender_name_enc, aad('group_messages', 'sender_name_enc', chatId, id)) : null,
        chimeKind: isKind(r.chime_kind) ? r.chime_kind : null,
        at: Number(r.at),
      };
    } catch {
      return null; // the group DEK was destroyed (bot left + grace) or the row is corrupt: unreadable = gone
    }
  };
  const openAll = (rows: RawMsg[]) => rows.map(open).filter((m): m is StoredMessage => m !== null);

  const policyRow = (chatId: number): PolicyRow | null => {
    const r = db.prepare('SELECT * FROM group_policy WHERE chat_id = ?').get<RawPolicy>(chatId);
    if (!r) return null;
    return {
      chatId: Number(r.chat_id), chattiness: r.chattiness, thresholdAdj: Number(r.threshold_adj), arms: parseArms(r.arms_json),
      readsAll: r.reads_all === null ? null : r.reads_all === 1, tz: r.tz, lang: r.lang,
      lastActivityAt: r.last_activity_at === null ? null : Number(r.last_activity_at), lastChimeAt: r.last_chime_at === null ? null : Number(r.last_chime_at),
      chimesDay: r.chimes_day, chimesToday: Number(r.chimes_today),
      openChimeTgMessageId: r.open_chime_tg_message_id === null ? null : Number(r.open_chime_tg_message_id),
      openChimeKind: isKind(r.open_chime_kind) ? r.open_chime_kind : null,
      openChimeAt: r.open_chime_at === null ? null : Number(r.open_chime_at),
      joinLineAt: r.join_line_at === null ? null : Number(r.join_line_at),
    };
  };

  const ensurePolicy = (chatId: number): void => {
    db.prepare(`INSERT OR IGNORE INTO group_policy (chat_id, arms_json, updated_at) VALUES (?, ?, ?)`).run(chatId, JSON.stringify(emptyArms()), clock.now());
  };

  return {
    // ── messages
    /** Inserts once per (chat, message id); returns false when the row already existed. Throws DekDestroyedError. */
    insertMessage(m: Omit<StoredMessage, 'chimeKind'> & { chimeKind?: GroupChimeKind | null }): boolean {
      const text = m.text.slice(0, 4_000);
      const dek = sealDek(m.chatId);
      const textEnc = crypto.seal(dek, text, aad('group_messages', 'text_enc', m.chatId, m.tgMessageId));
      const nameEnc = m.senderName ? crypto.seal(dek, m.senderName.slice(0, 64), aad('group_messages', 'sender_name_enc', m.chatId, m.tgMessageId)) : null;
      const r = db
        .prepare(`INSERT OR IGNORE INTO group_messages (chat_id, tg_message_id, thread_id, from_tg_id, sender_hmac, kind, addressed, reply_to_tg_message_id, text_enc, sender_name_enc, chime_kind, at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.chatId, m.tgMessageId, m.threadId, m.fromTgId, crypto.hmac('member', `${m.chatId}:${m.fromTgId}`), m.kind, m.addressed, m.replyToTgMessageId, textEnc, nameEnc, m.chimeKind ?? null, m.at, clock.now());
      return Number(r.changes) > 0;
    },
    /** Replaces a stored member message's text (sealed again), or deletes the row when `text` is empty. False = not stored. */
    editMessage(chatId: number, tgMessageId: number, fromTgId: number, text: string): { changed: boolean; at: Ms | null } {
      const r = db.prepare(`SELECT at FROM group_messages WHERE chat_id = ? AND tg_message_id = ? AND from_tg_id = ? AND kind != 'bot'`).get<{ at: number }>(chatId, tgMessageId, fromTgId);
      if (!r) return { changed: false, at: null };
      const t = text.trim();
      if (!t) {
        db.prepare(`DELETE FROM group_messages WHERE chat_id = ? AND tg_message_id = ?`).run(chatId, tgMessageId);
        return { changed: true, at: Number(r.at) };
      }
      const enc = crypto.seal(sealDek(chatId), t.slice(0, 4_000), aad('group_messages', 'text_enc', chatId, tgMessageId));
      db.prepare(`UPDATE group_messages SET text_enc = ? WHERE chat_id = ? AND tg_message_id = ?`).run(enc, chatId, tgMessageId);
      return { changed: true, at: Number(r.at) };
    },
    get(chatId: number, tgMessageId: number): StoredMessage | null {
      const r = db.prepare(`SELECT ${MSG_COLS} FROM group_messages WHERE chat_id = ? AND tg_message_id = ?`).get<RawMsg>(chatId, tgMessageId);
      return r ? open(r) : null;
    },
    /** The newest `limit` messages at or after `sinceAt`, oldest first. */
    recent(chatId: number, o: { sinceAt?: Ms; limit: number; threadId?: number | null; excludeTgMessageId?: number }): StoredMessage[] {
      const rows = db
        .prepare(`SELECT ${MSG_COLS} FROM group_messages WHERE chat_id = ? AND at >= ? ORDER BY at DESC, tg_message_id DESC LIMIT ?`)
        .all<RawMsg>(chatId, o.sinceAt ?? 0, o.limit + 1);
      let out = openAll(rows).reverse();
      if (o.excludeTgMessageId !== undefined) out = out.filter((m) => m.tgMessageId !== o.excludeTgMessageId);
      if (o.threadId !== undefined && o.threadId !== null) out = out.filter((m) => m.threadId === o.threadId);
      return out.slice(-o.limit);
    },
    /**
     * Messages after `afterAt`, oldest first (summary batches, catch-up). Telegram dates have 1 s resolution, so with
     * `afterId` a message in the same second counts when its id is larger (message ids grow within a chat).
     */
    after(chatId: number, afterAt: Ms, limit: number, afterId?: number): StoredMessage[] {
      if (afterId === undefined) return openAll(db.prepare(`SELECT ${MSG_COLS} FROM group_messages WHERE chat_id = ? AND at > ? ORDER BY at ASC, tg_message_id ASC LIMIT ?`).all<RawMsg>(chatId, afterAt, limit));
      return openAll(
        db.prepare(`SELECT ${MSG_COLS} FROM group_messages WHERE chat_id = ? AND (at > ? OR (at = ? AND tg_message_id > ?)) ORDER BY at ASC, tg_message_id ASC LIMIT ?`).all<RawMsg>(chatId, afterAt, afterAt, afterId, limit),
      );
    },
    /**
     * C5 catch-up window: the NEWEST `limit` messages after (`sinceAt`, `afterId`) up to `untilAt`, not written by
     * `exceptTgId`, optionally in one thread — oldest first — plus how many matched in total (s07 lead fix: the oldest
     * 2,000 then slice(-150) dropped the newest lines).
     */
    catchupWindow(chatId: number, o: { sinceAt: Ms; afterId?: number; exceptTgId: number; untilAt: Ms; threadId?: number | null; limit: number }): { msgs: StoredMessage[]; total: number } {
      const where = [`chat_id = ?`, o.afterId !== undefined ? `(at > ? OR (at = ? AND tg_message_id > ?))` : `at > ?`, `from_tg_id != ?`, `at <= ?`];
      const args: Array<number> = [chatId, ...(o.afterId !== undefined ? [o.sinceAt, o.sinceAt, o.afterId] : [o.sinceAt]), o.exceptTgId, o.untilAt];
      if (o.threadId !== undefined && o.threadId !== null) {
        where.push(`thread_id = ?`);
        args.push(o.threadId);
      }
      const w = where.join(' AND ');
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM group_messages WHERE ${w}`).get<{ n: number }>(...args)?.n ?? 0);
      const rows = db.prepare(`SELECT ${MSG_COLS} FROM group_messages WHERE ${w} ORDER BY at DESC, tg_message_id DESC LIMIT ?`).all<RawMsg>(...args, o.limit);
      return { msgs: openAll(rows).reverse(), total };
    },
    /** The member's latest message strictly before `beforeAt` (null = none stored). */
    lastOf(chatId: number, fromTgId: number, beforeAt: Ms): { at: Ms; tgMessageId: number } | null {
      const r = db.prepare(`SELECT at, tg_message_id FROM group_messages WHERE chat_id = ? AND from_tg_id = ? AND kind != 'bot' AND at < ? ORDER BY at DESC LIMIT 1`).get<{ at: number; tg_message_id: number }>(chatId, fromTgId, beforeAt);
      return r ? { at: Number(r.at), tgMessageId: Number(r.tg_message_id) } : null;
    },
    /** The latest chime-in (a bot message with a chime kind) since `sinceAt`. */
    lastChime(chatId: number, sinceAt: Ms): { tgMessageId: number; kind: GroupChimeKind; at: Ms } | null {
      const r = db.prepare(`SELECT tg_message_id, chime_kind, at FROM group_messages WHERE chat_id = ? AND kind = 'bot' AND chime_kind IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 1`).get<{ tg_message_id: number; chime_kind: string; at: number }>(chatId, sinceAt);
      return r && isKind(r.chime_kind) ? { tgMessageId: Number(r.tg_message_id), kind: r.chime_kind, at: Number(r.at) } : null;
    },
    /** Distinct human senders seen since `sinceAt` (the group's tz / language majority). */
    members(chatId: number, sinceAt: Ms): number[] {
      return db.prepare(`SELECT DISTINCT from_tg_id FROM group_messages WHERE chat_id = ? AND kind != 'bot' AND at >= ?`).all<{ from_tg_id: number }>(chatId, sinceAt).map((r) => Number(r.from_tg_id));
    },
    countMessages(chatId: number): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM group_messages WHERE chat_id = ?`).get<{ n: number }>(chatId)?.n ?? 0);
    },
    /** /export: the member's own group lines as a count per chat (never the text). */
    countsByMember(fromTgId: number): Array<{ chatId: number; messages: number }> {
      return db.prepare(`SELECT chat_id, COUNT(*) AS n FROM group_messages WHERE from_tg_id = ? AND kind != 'bot' GROUP BY chat_id`).all<{ chat_id: number; n: number }>(fromTgId).map((r) => ({ chatId: Number(r.chat_id), messages: Number(r.n) }));
    },
    /** C3 rolling retention (by the Telegram date). */
    deleteOlderThan(cutoff: Ms): number {
      return Number(db.prepare(`DELETE FROM group_messages WHERE at < ?`).run(cutoff).changes);
    },
    /** Every chat that still has any group row (the bot-left sweep). */
    chats(): number[] {
      return db
        .prepare(`SELECT chat_id FROM group_policy UNION SELECT chat_id FROM group_summaries UNION SELECT DISTINCT chat_id FROM group_messages`)
        .all<{ chat_id: number }>()
        .map((r) => Number(r.chat_id));
    },

    // ── summary
    summary(chatId: number): SummaryRow | null {
      const r = db.prepare(`SELECT chat_id, version, summary_enc, covered_until_at, pending_count, facts_until_at, updated_at, covered_from_at FROM group_summaries WHERE chat_id = ?`).get<{ chat_id: number; version: number; summary_enc: Uint8Array; covered_until_at: number; pending_count: number; facts_until_at: number | null; updated_at: number; covered_from_at: number | null }>(chatId);
      if (!r) return null;
      let summary: string | null = null;
      if (r.summary_enc.length > 0) {
        try {
          summary = crypto.openText(r.summary_enc, aad('group_summaries', 'summary_enc', chatId, `v${Number(r.version)}`));
        } catch {
          summary = null;
        }
      }
      return {
        chatId, version: Number(r.version), summary, coveredUntilAt: Number(r.covered_until_at), pendingCount: Number(r.pending_count), factsUntilAt: r.facts_until_at === null ? null : Number(r.facts_until_at),
        updatedAt: Number(r.updated_at), coveredFromAt: r.covered_from_at === null ? null : Number(r.covered_from_at),
      };
    },
    /**
     * C3 retention for the rolling summary (s07 lead fix): the text is dropped when its coverage starts before `cutoff`
     * (or is unknown); the coverage end and the batch counter stay, so the next batch starts a fresh summary from newer
     * messages only. Returns true when a text was dropped.
     */
    expireSummary(chatId: number, cutoff: Ms): boolean {
      const r = db.prepare(`UPDATE group_summaries SET summary_enc = x'', covered_from_at = NULL, version = version + 1, updated_at = ? WHERE chat_id = ? AND length(summary_enc) > 0 AND COALESCE(covered_from_at, 0) < ?`).run(clock.now(), chatId, cutoff);
      return Number(r.changes) > 0;
    },
    /** One more message waiting for the next summary; returns the new pending count. */
    bumpPending(chatId: number): number {
      const now = clock.now();
      db.prepare(`INSERT INTO group_summaries (chat_id, version, summary_enc, covered_until_at, pending_count, facts_until_at, updated_at) VALUES (?, 0, x'', 0, 1, NULL, ?)
                  ON CONFLICT(chat_id) DO UPDATE SET pending_count = pending_count + 1`).run(chatId, now);
      return Number(db.prepare(`SELECT pending_count FROM group_summaries WHERE chat_id = ?`).get<{ pending_count: number }>(chatId)?.pending_count ?? 0);
    },
    /** Writes the next summary version (sealed) and resets the batch counter by the messages it covered. */
    setSummary(chatId: number, p: { summary: string | null; coveredUntilAt: Ms; covered: number; factsUntilAt?: Ms; coveredFromAt?: Ms }): void {
      const now = clock.now();
      const batchFrom = p.coveredFromAt ?? p.coveredUntilAt;
      db.tx(() => {
        const cur = db.prepare(`SELECT version, summary_enc, pending_count, covered_from_at FROM group_summaries WHERE chat_id = ?`).get<{ version: number; summary_enc: Uint8Array; pending_count: number; covered_from_at: number | null }>(chatId);
        const version = (cur ? Number(cur.version) : 0) + 1;
        const enc = p.summary !== null ? crypto.seal(sealDek(chatId), p.summary.slice(0, 4_000), aad('group_summaries', 'summary_enc', chatId, `v${version}`)) : null;
        if (!cur) {
          db.prepare(`INSERT INTO group_summaries (chat_id, version, summary_enc, covered_until_at, pending_count, facts_until_at, updated_at, covered_from_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
            .run(chatId, version, enc ?? new Uint8Array(0), p.coveredUntilAt, p.factsUntilAt ?? null, now, enc ? batchFrom : null);
          return;
        }
        // the coverage start: kept while an earlier text is folded in; a legacy text of unknown age counts as ancient (0)
        const prevHasText = cur.summary_enc.length > 0;
        const from = prevHasText ? (cur.covered_from_at === null ? 0 : Number(cur.covered_from_at)) : batchFrom;
        // keep the previous text when this batch produced none (a parse failure must not erase the summary)
        let keep: Uint8Array = cur.summary_enc;
        if (!enc && cur.summary_enc.length > 0) {
          try {
            const prev = crypto.openText(cur.summary_enc, aad('group_summaries', 'summary_enc', chatId, `v${Number(cur.version)}`));
            keep = crypto.seal(sealDek(chatId), prev, aad('group_summaries', 'summary_enc', chatId, `v${version}`));
          } catch {
            keep = new Uint8Array(0);
          }
        }
        const text = enc ?? keep;
        db.prepare(`UPDATE group_summaries SET version = ?, summary_enc = ?, covered_until_at = ?, pending_count = MAX(0, pending_count - ?), facts_until_at = COALESCE(?, facts_until_at), updated_at = ?, covered_from_at = ? WHERE chat_id = ?`)
          .run(version, text, p.coveredUntilAt, p.covered, p.factsUntilAt ?? null, now, text.length > 0 ? from : null, chatId);
      });
    },

    // ── policy
    policy: policyRow,
    ensurePolicy,
    updatePolicy(chatId: number, patch: Partial<Omit<PolicyRow, 'chatId'>>): void {
      ensurePolicy(chatId);
      const cols: string[] = [];
      const vals: Array<string | number | null> = [];
      const set = (c: string, v: string | number | null) => {
        cols.push(`${c} = ?`);
        vals.push(v);
      };
      if (patch.chattiness !== undefined) set('chattiness', patch.chattiness);
      if (patch.thresholdAdj !== undefined) set('threshold_adj', patch.thresholdAdj);
      if (patch.arms !== undefined) set('arms_json', JSON.stringify(patch.arms));
      if (patch.readsAll !== undefined) set('reads_all', patch.readsAll === null ? null : patch.readsAll ? 1 : 0);
      if (patch.tz !== undefined) set('tz', patch.tz);
      if (patch.lang !== undefined) set('lang', patch.lang);
      if (patch.lastActivityAt !== undefined) set('last_activity_at', patch.lastActivityAt);
      if (patch.lastChimeAt !== undefined) set('last_chime_at', patch.lastChimeAt);
      if (patch.chimesDay !== undefined) set('chimes_day', patch.chimesDay);
      if (patch.chimesToday !== undefined) set('chimes_today', patch.chimesToday);
      if (patch.openChimeTgMessageId !== undefined) set('open_chime_tg_message_id', patch.openChimeTgMessageId);
      if (patch.openChimeKind !== undefined) set('open_chime_kind', patch.openChimeKind);
      if (patch.openChimeAt !== undefined) set('open_chime_at', patch.openChimeAt);
      if (patch.joinLineAt !== undefined) set('join_line_at', patch.joinLineAt);
      if (!cols.length) return;
      set('updated_at', clock.now());
      db.prepare(`UPDATE group_policy SET ${cols.join(', ')} WHERE chat_id = ?`).run(...vals, chatId);
    },
    /** Claims the join line once per chat and join (C2): true when this call set join_line_at. */
    claimJoinLine(chatId: number, since: Ms): boolean {
      ensurePolicy(chatId);
      const r = db.prepare(`UPDATE group_policy SET join_line_at = ?, updated_at = ? WHERE chat_id = ? AND (join_line_at IS NULL OR join_line_at < ?)`).run(clock.now(), clock.now(), chatId, since);
      return Number(r.changes) > 0;
    },
    /** Pooled evidence of every OTHER group (the hierarchical population prior). */
    pooledArms(exceptChatId: number): ArmEvidence {
      const out = emptyArms();
      for (const r of db.prepare(`SELECT arms_json FROM group_policy WHERE chat_id != ?`).all<{ arms_json: string }>(exceptChatId)) {
        const a = parseArms(r.arms_json);
        for (const k of GROUP_CHIME_KINDS) out[k] = [out[k][0] + a[k][0], out[k][1] + a[k][1]];
      }
      return out;
    },

    /**
     * Rows sealed under a destroyed group DEK (the bot left and the grace passed, possibly re-added since): unreadable,
     * so deleted. Rows of the live generation stay. Returns how many rows went.
     */
    purgeOrphans(chatId: number): number {
      let n = 0;
      for (const r of db.prepare(`SELECT tg_message_id, text_enc FROM group_messages WHERE chat_id = ?`).all<{ tg_message_id: number; text_enc: Uint8Array }>(chatId)) {
        if (destroyedUnder(r.text_enc, aad('group_messages', 'text_enc', chatId, Number(r.tg_message_id)))) {
          n += Number(db.prepare(`DELETE FROM group_messages WHERE chat_id = ? AND tg_message_id = ?`).run(chatId, r.tg_message_id).changes);
        }
      }
      const sr = db.prepare(`SELECT version, summary_enc FROM group_summaries WHERE chat_id = ?`).get<{ version: number; summary_enc: Uint8Array }>(chatId);
      if (sr && sr.summary_enc.length > 0 && destroyedUnder(sr.summary_enc, aad('group_summaries', 'summary_enc', chatId, `v${Number(sr.version)}`))) {
        n += Number(db.prepare(`DELETE FROM group_summaries WHERE chat_id = ?`).run(chatId).changes);
      }
      return n;
    },

    // ── deletion (GROUP_DATA_TABLES, in order)
    purge(chatId: number, reason: 'forget' | 'left'): void {
      db.tx(() => {
        for (const t of GROUP_DATA_TABLES) {
          if (reason === 'forget' && t.keepOnForget) continue;
          db.prepare(`DELETE FROM ${t.table} WHERE ${t.where.replaceAll(':chatId', '?')}`).run(chatId);
        }
        if (reason === 'forget') {
          // chattiness is a setting and stays; so do the rate-limit counters (last_chime_at / chimes_day / chimes_today are
          // not member content — s07 lead fix: /forget всё must not reset the 1-per-30-min / 6-per-day caps). The open
          // reward window and the tz guess (derived from members) reset.
          db.prepare(`UPDATE group_policy SET open_chime_tg_message_id = NULL, open_chime_kind = NULL, open_chime_at = NULL, last_activity_at = NULL, tz = NULL, updated_at = ? WHERE chat_id = ?`).run(clock.now(), chatId);
        }
      });
    },
  };
}
export type GroupRepo = ReturnType<typeof createGroupRepo>;
