// surfaces/business/repo.ts (WP7b) — the only SQL over business_connections, business_chats, business_messages and
// business_drafts (01 §7.1, §7.2). Content columns are sealed under the connection DEK 'b:<connId>' (owner
// 'biz:<connId>'); AAD '<table>|<column>|<row key>'. business_messages rows exist ONLY for AI-enabled chats: the
// pipeline checks consent before calling addMessage, and this repo re-checks it (defence in depth).
import type { Crypto, Db, Ms, UserId } from '../../contracts/index.ts';
import { aadText, aadTitle, aadTone, dekOf, dekOwnerOf, MAX_TEXT_STORED } from './core.ts';

export interface ConnRow {
  id: string; userId: UserId; tgUserId: number; userChatId: number; rights: Record<string, unknown>; isEnabled: boolean;
  aiDefault: 'off' | 'new_chats'; connectedAt: Ms; updatedAt: Ms; disconnectedAt: Ms | null;
}
export interface ChatRow {
  connectionId: string; chatId: number; peerUserId: number | null; aiEnabled: boolean; consentId: string | null; mode: 'triage' | 'draft';
  firstSeenAt: Ms; lastIncomingAt: Ms | null; lastOwnerAt: Ms | null; unansweredSince: Ms | null; windowExpiresAt: Ms | null;
  lastTriageAt: Ms | null; priority: number; hasTitle: boolean; hasTone: boolean;
}
export interface MsgRow { connectionId: string; chatId: number; messageId: number; fromOwner: boolean; viaBot: boolean; date: Ms; text: string; mediaKind: string | null; editedAt: Ms | null }

type RawConn = { id: string; user_id: string; tg_user_id: number; user_chat_id: number; rights_json: string; is_enabled: number; ai_default: string; connected_at: number; updated_at: number; disconnected_at: number | null };
type RawChat = {
  connection_id: string; chat_id: number; peer_user_id: number | null; ai_enabled: number; consent_id: string | null; mode: string; first_seen_at: number;
  last_incoming_at: number | null; last_owner_at: number | null; unanswered_since: number | null; window_expires_at: number | null; last_triage_at: number | null;
  priority: number; has_title: number; has_tone: number;
};
type RawMsg = { connection_id: string; chat_id: number; message_id: number; from_owner: number; via_bot: number; date: number; text_enc: Uint8Array; media_kind: string | null; edited_at: number | null };

const CHAT_COLS = `connection_id, chat_id, peer_user_id, ai_enabled, consent_id, mode, first_seen_at, last_incoming_at, last_owner_at, unanswered_since,
  window_expires_at, last_triage_at, priority, (title_enc IS NOT NULL) AS has_title, (tone_notes_enc IS NOT NULL) AS has_tone`;

function parseRights(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const toConn = (r: RawConn): ConnRow => ({
  id: r.id, userId: r.user_id, tgUserId: Number(r.tg_user_id), userChatId: Number(r.user_chat_id), rights: parseRights(r.rights_json), isEnabled: r.is_enabled === 1,
  aiDefault: r.ai_default === 'new_chats' ? 'new_chats' : 'off', connectedAt: Number(r.connected_at), updatedAt: Number(r.updated_at),
  disconnectedAt: r.disconnected_at === null ? null : Number(r.disconnected_at),
});
const num = (v: number | null): number | null => (v === null ? null : Number(v));
const toChat = (r: RawChat): ChatRow => ({
  connectionId: r.connection_id, chatId: Number(r.chat_id), peerUserId: num(r.peer_user_id), aiEnabled: r.ai_enabled === 1, consentId: r.consent_id,
  mode: r.mode === 'draft' ? 'draft' : 'triage', firstSeenAt: Number(r.first_seen_at), lastIncomingAt: num(r.last_incoming_at), lastOwnerAt: num(r.last_owner_at),
  unansweredSince: num(r.unanswered_since), windowExpiresAt: num(r.window_expires_at), lastTriageAt: num(r.last_triage_at), priority: Number(r.priority),
  hasTitle: Number(r.has_title) === 1, hasTone: Number(r.has_tone) === 1,
});

export function createBizRepo(db: Db, crypto: Crypto) {
  /** All drafts of a connection with their embedded (chat, message) entries; `entries` null = unreadable (treat as all). */
  const draftRows = (connectionId: string): Array<{ conversationId: string; chatId: number; entries: Array<{ chatId: number; messageId: number }> | null }> =>
    db
      .prepare('SELECT conversation_id, chat_id, message_ids_json FROM business_drafts WHERE connection_id = ? ORDER BY created_at')
      .all<{ conversation_id: string; chat_id: number; message_ids_json: string }>(connectionId)
      .map((r) => {
        const own = Number(r.chat_id);
        let entries: Array<{ chatId: number; messageId: number }> | null;
        try {
          entries = (JSON.parse(r.message_ids_json) as unknown[]).flatMap((x) => {
            if (typeof x === 'number') return [{ chatId: own, messageId: x }];
            const m = typeof x === 'string' ? /^(-?\d+):(\d+)$/.exec(x) : null;
            return m ? [{ chatId: Number(m[1]), messageId: Number(m[2]) }] : [];
          });
        } catch {
          entries = null;
        }
        return { conversationId: r.conversation_id, chatId: own, entries };
      });
  const ensureDek = (connectionId: string) => crypto.ensureDek(dekOf(connectionId), dekOwnerOf(connectionId), 'business');
  const openText = (ct: Uint8Array | null, aad: string): string | null => {
    if (!ct) return null;
    try {
      return crypto.openText(ct, aad);
    } catch {
      return null; // DEK destroyed (deletion) or tampered: treat as absent
    }
  };
  const toMsg = (r: RawMsg): MsgRow => ({
    connectionId: r.connection_id, chatId: Number(r.chat_id), messageId: Number(r.message_id), fromOwner: r.from_owner === 1, viaBot: r.via_bot === 1,
    date: Number(r.date), text: openText(r.text_enc, aadText(r.connection_id, Number(r.chat_id), Number(r.message_id))) ?? '', mediaKind: r.media_kind,
    editedAt: num(r.edited_at),
  });

  const repo = {
    ensureDek,

    // ── connections
    getConnection(id: string): ConnRow | undefined {
      const r = db.prepare('SELECT * FROM business_connections WHERE id = ?').get<RawConn>(id);
      return r ? toConn(r) : undefined;
    },
    /** The owner's current connection: enabled first, then the most recently connected. */
    connectionOfUser(userId: UserId): ConnRow | undefined {
      const r = db
        .prepare('SELECT * FROM business_connections WHERE user_id = ? ORDER BY is_enabled DESC, (disconnected_at IS NULL) DESC, connected_at DESC, id LIMIT 1')
        .get<RawConn>(userId);
      return r ? toConn(r) : undefined;
    },
    connectionsOfUser(userId: UserId): ConnRow[] {
      return db.prepare('SELECT * FROM business_connections WHERE user_id = ? ORDER BY connected_at').all<RawConn>(userId).map(toConn);
    },
    upsertConnection(c: { id: string; userId: UserId; tgUserId: number; userChatId: number; rightsJson: string; isEnabled: boolean; now: Ms }): void {
      ensureDek(c.id);
      db.prepare(
        `INSERT INTO business_connections (id, user_id, tg_user_id, user_chat_id, rights_json, is_enabled, ai_default, connected_at, updated_at, disconnected_at)
         VALUES (?, ?, ?, ?, ?, ?, 'off', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, tg_user_id = excluded.tg_user_id, user_chat_id = excluded.user_chat_id,
           rights_json = excluded.rights_json, is_enabled = excluded.is_enabled, updated_at = excluded.updated_at,
           connected_at = CASE WHEN business_connections.is_enabled = 0 AND excluded.is_enabled = 1 THEN excluded.updated_at ELSE business_connections.connected_at END,
           disconnected_at = CASE WHEN excluded.is_enabled = 1 THEN NULL ELSE COALESCE(business_connections.disconnected_at, excluded.updated_at) END`,
      ).run(c.id, c.userId, c.tgUserId, c.userChatId, c.rightsJson, c.isEnabled ? 1 : 0, c.now, c.now, c.isEnabled ? null : c.now);
    },
    setAiDefault(id: string, v: 'off' | 'new_chats', now: Ms): void {
      db.prepare('UPDATE business_connections SET ai_default = ?, updated_at = ? WHERE id = ?').run(v, now, id);
    },

    // ── chats
    getChat(connectionId: string, chatId: number): ChatRow | undefined {
      const r = db.prepare(`SELECT ${CHAT_COLS} FROM business_chats WHERE connection_id = ? AND chat_id = ?`).get<RawChat>(connectionId, chatId);
      return r ? toChat(r) : undefined;
    },
    /** Creates the metadata row when missing; returns whether it was created. */
    ensureChat(connectionId: string, chatId: number, now: Ms, peerUserId: number | null): boolean {
      const res = db
        .prepare('INSERT OR IGNORE INTO business_chats (connection_id, chat_id, peer_user_id, first_seen_at) VALUES (?, ?, ?, ?)')
        .run(connectionId, chatId, peerUserId, now);
      return Number(res.changes) > 0;
    },
    setTitle(connectionId: string, chatId: number, title: string): void {
      const t = title.slice(0, 256);
      if (!t) return;
      db.prepare('UPDATE business_chats SET title_enc = ? WHERE connection_id = ? AND chat_id = ?').run(crypto.seal(dekOf(connectionId), t, aadTitle(connectionId, chatId)), connectionId, chatId);
    },
    title(connectionId: string, chatId: number): string | null {
      const r = db.prepare('SELECT title_enc FROM business_chats WHERE connection_id = ? AND chat_id = ?').get<{ title_enc: Uint8Array | null }>(connectionId, chatId);
      return r ? openText(r.title_enc, aadTitle(connectionId, chatId)) : null;
    },
    setTone(connectionId: string, chatId: number, notes: string | null): void {
      const v = notes && notes.trim() ? crypto.seal(dekOf(connectionId), notes.trim().slice(0, 500), aadTone(connectionId, chatId)) : null;
      db.prepare('UPDATE business_chats SET tone_notes_enc = ? WHERE connection_id = ? AND chat_id = ?').run(v, connectionId, chatId);
    },
    tone(connectionId: string, chatId: number): string | null {
      const r = db.prepare('SELECT tone_notes_enc FROM business_chats WHERE connection_id = ? AND chat_id = ?').get<{ tone_notes_enc: Uint8Array | null }>(connectionId, chatId);
      return r ? openText(r.tone_notes_enc, aadTone(connectionId, chatId)) : null;
    },
    setMode(connectionId: string, chatId: number, mode: 'triage' | 'draft'): void {
      db.prepare('UPDATE business_chats SET mode = ? WHERE connection_id = ? AND chat_id = ?').run(mode, connectionId, chatId);
    },
    setAi(connectionId: string, chatId: number, enabled: boolean, consentId: string | null): void {
      db.prepare('UPDATE business_chats SET ai_enabled = ?, consent_id = ? WHERE connection_id = ? AND chat_id = ?').run(enabled ? 1 : 0, enabled ? consentId : null, connectionId, chatId);
    },
    /** A peer message: last_incoming_at, the 24 h window and unanswered_since (kept when already set). */
    notePeer(connectionId: string, chatId: number, at: Ms, windowEnd: Ms): void {
      db.prepare(
        `UPDATE business_chats SET last_incoming_at = MAX(COALESCE(last_incoming_at, 0), ?), window_expires_at = MAX(COALESCE(window_expires_at, 0), ?),
           unanswered_since = COALESCE(unanswered_since, ?) WHERE connection_id = ? AND chat_id = ?`,
      ).run(at, windowEnd, at, connectionId, chatId);
    },
    /** An owner message (typed by the owner or sent by Gora on approval): the chat is answered. */
    noteOwner(connectionId: string, chatId: number, at: Ms): void {
      db.prepare(
        'UPDATE business_chats SET last_owner_at = MAX(COALESCE(last_owner_at, 0), ?), unanswered_since = NULL, priority = 0 WHERE connection_id = ? AND chat_id = ?',
      ).run(at, connectionId, chatId);
    },
    noteTriage(connectionId: string, chatId: number, at: Ms, priority: number | null): void {
      if (priority === null) db.prepare('UPDATE business_chats SET last_triage_at = ? WHERE connection_id = ? AND chat_id = ?').run(at, connectionId, chatId);
      else db.prepare('UPDATE business_chats SET last_triage_at = ?, priority = ? WHERE connection_id = ? AND chat_id = ?').run(at, Math.max(0, Math.min(3, Math.round(priority))), connectionId, chatId);
    },
    listChats(connectionId: string, q: { aiOnly: boolean; unansweredOnly: boolean; limit: number }): ChatRow[] {
      const where = ['connection_id = ?'];
      if (q.aiOnly) where.push('ai_enabled = 1');
      if (q.unansweredOnly) where.push('unanswered_since IS NOT NULL');
      const order = q.unansweredOnly ? 'priority DESC, unanswered_since ASC' : 'COALESCE(MAX(COALESCE(last_incoming_at, 0), COALESCE(last_owner_at, 0)), first_seen_at) DESC';
      return db
        .prepare(`SELECT ${CHAT_COLS} FROM business_chats WHERE ${where.join(' AND ')} ORDER BY ${order}, chat_id LIMIT ?`)
        .all<RawChat>(connectionId, Math.max(1, Math.min(500, q.limit)))
        .map(toChat);
    },
    countAiChats(connectionId: string): { ai: number; unanswered: number } {
      const r = db
        .prepare('SELECT SUM(ai_enabled = 1) AS ai, SUM(ai_enabled = 1 AND unanswered_since IS NOT NULL) AS un FROM business_chats WHERE connection_id = ?')
        .get<{ ai: number | null; un: number | null }>(connectionId);
      return { ai: Number(r?.ai ?? 0), unanswered: Number(r?.un ?? 0) };
    },
    deleteChatsOfConnection(connectionId: string): void {
      db.prepare('DELETE FROM business_chats WHERE connection_id = ?').run(connectionId);
    },

    // ── messages (AI-enabled chats only)
    /** Stores a message of a consented chat. Returns true only when a new row was written (false: not AI-enabled, or already stored). */
    addMessage(m: { connectionId: string; chatId: number; messageId: number; fromOwner: boolean; viaBot: boolean; date: Ms; text: string; mediaKind: string | null; now: Ms }): boolean {
      const chat = repo.getChat(m.connectionId, m.chatId);
      if (!chat?.aiEnabled) return false;
      const enc = crypto.seal(dekOf(m.connectionId), m.text.slice(0, MAX_TEXT_STORED), aadText(m.connectionId, m.chatId, m.messageId));
      const res = db.prepare(
        `INSERT OR IGNORE INTO business_messages (connection_id, chat_id, message_id, from_owner, via_bot, date, text_enc, media_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(m.connectionId, m.chatId, m.messageId, m.fromOwner ? 1 : 0, m.viaBot ? 1 : 0, m.date, enc, m.mediaKind, m.now);
      return Number(res.changes) > 0;
    },
    /** edited_business_message: replaces the stored text (consented chats only; unknown messages are not created). */
    editMessage(connectionId: string, chatId: number, messageId: number, text: string, at: Ms): boolean {
      const chat = repo.getChat(connectionId, chatId);
      if (!chat?.aiEnabled) return false;
      const enc = crypto.seal(dekOf(connectionId), text.slice(0, MAX_TEXT_STORED), aadText(connectionId, chatId, messageId));
      const res = db
        .prepare('UPDATE business_messages SET text_enc = ?, edited_at = ? WHERE connection_id = ? AND chat_id = ? AND message_id = ?')
        .run(enc, at, connectionId, chatId, messageId);
      return Number(res.changes) > 0;
    },
    /** The last `n` stored messages of a chat, oldest first. */
    lastMessages(connectionId: string, chatId: number, n: number): MsgRow[] {
      return db
        .prepare('SELECT * FROM business_messages WHERE connection_id = ? AND chat_id = ? ORDER BY date DESC, message_id DESC LIMIT ?')
        .all<RawMsg>(connectionId, chatId, Math.max(1, n))
        .map(toMsg)
        .reverse();
    },
    /** The owner's own outgoing messages (typed by the owner, not sent by Gora), newest first; `chatId` or every OTHER AI-enabled chat. */
    ownerSamples(connectionId: string, q: { chatId: number; otherChats: boolean }, n: number): MsgRow[] {
      if (n <= 0) return [];
      const sql = q.otherChats
        ? `SELECT m.* FROM business_messages m JOIN business_chats c ON c.connection_id = m.connection_id AND c.chat_id = m.chat_id
             WHERE m.connection_id = ? AND m.chat_id <> ? AND c.ai_enabled = 1 AND m.from_owner = 1 AND m.via_bot = 0 ORDER BY m.date DESC, m.message_id DESC LIMIT ?`
        : `SELECT m.* FROM business_messages m JOIN business_chats c ON c.connection_id = m.connection_id AND c.chat_id = m.chat_id
             WHERE m.connection_id = ? AND m.chat_id = ? AND c.ai_enabled = 1 AND m.from_owner = 1 AND m.via_bot = 0 ORDER BY m.date DESC, m.message_id DESC LIMIT ?`;
      return db.prepare(sql).all<RawMsg>(connectionId, q.chatId, n).map(toMsg);
    },
    messageIds(connectionId: string, chatId: number, ids: number[]): number[] {
      if (!ids.length) return [];
      const have = new Set(
        db.prepare('SELECT message_id FROM business_messages WHERE connection_id = ? AND chat_id = ?').all<{ message_id: number }>(connectionId, chatId).map((r) => Number(r.message_id)),
      );
      return ids.filter((i) => have.has(i));
    },
    deleteMessages(connectionId: string, chatId: number, ids: number[]): number {
      let n = 0;
      const st = db.prepare('DELETE FROM business_messages WHERE connection_id = ? AND chat_id = ? AND message_id = ?');
      db.tx(() => {
        for (const id of ids) n += Number(st.run(connectionId, chatId, id).changes);
      });
      return n;
    },
    deleteChatMessages(connectionId: string, chatId: number): number {
      return Number(db.prepare('DELETE FROM business_messages WHERE connection_id = ? AND chat_id = ?').run(connectionId, chatId).changes);
    },
    deleteMessagesOlderThan(cutoff: Ms): number {
      return Number(db.prepare('DELETE FROM business_messages WHERE MAX(date, created_at) < ?').run(cutoff).changes);
    },
    allMessagesOfConnection(connectionId: string, limit: number): MsgRow[] {
      return db.prepare('SELECT * FROM business_messages WHERE connection_id = ? ORDER BY chat_id, date, message_id LIMIT ?').all<RawMsg>(connectionId, limit).map(toMsg);
    },

    // ── biz_draft conversations ↔ the messages they included
    // message_ids_json holds the drafted chat's transcript ids as numbers, plus every embedded style sample (from this
    // or another consented chat) as a "<chatId>:<messageId>" string, so deleting a sample or revoking its chat's consent
    // finds this draft too (01 F12, §10.2 step 7). No schema change: older rows (numbers only) still parse.
    addDraft(conversationId: string, connectionId: string, chatId: number, messageIds: number[], now: Ms, embedded: ReadonlyArray<{ chatId: number; messageId: number }> = []): void {
      const entries: Array<number | string> = [...messageIds, ...embedded.map((e) => `${e.chatId}:${e.messageId}`)];
      db.prepare('INSERT OR REPLACE INTO business_drafts (conversation_id, connection_id, chat_id, message_ids_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
        conversationId, connectionId, chatId, JSON.stringify(entries), now,
      );
    },
    /** The draft's own transcript ids (numbers only; embedded samples are not reply targets). */
    draftOf(conversationId: string): { connectionId: string; chatId: number; messageIds: number[]; createdAt: Ms } | undefined {
      const r = db.prepare('SELECT * FROM business_drafts WHERE conversation_id = ?').get<{ connection_id: string; chat_id: number; message_ids_json: string; created_at: number }>(conversationId);
      if (!r) return undefined;
      let ids: number[] = [];
      try {
        ids = (JSON.parse(r.message_ids_json) as unknown[]).filter((x) => typeof x === 'number').map(Number).filter(Number.isSafeInteger);
      } catch {
        ids = [];
      }
      return { connectionId: r.connection_id, chatId: Number(r.chat_id), messageIds: ids, createdAt: Number(r.created_at) };
    },
    /** Drafting conversations FOR one chat (its cards, its transcript). */
    draftsOfChat(connectionId: string, chatId: number): string[] {
      return db.prepare('SELECT conversation_id FROM business_drafts WHERE connection_id = ? AND chat_id = ? ORDER BY created_at').all<{ conversation_id: string }>(connectionId, chatId).map((r) => r.conversation_id);
    },
    /** Drafting conversations that hold ANY content of one chat: its own drafts plus drafts embedding its style samples. */
    draftsTouchingChat(connectionId: string, chatId: number): string[] {
      return draftRows(connectionId)
        .filter((r) => r.chatId === chatId || r.entries === null || r.entries.some((e) => e.chatId === chatId))
        .map((r) => r.conversationId);
    },
    /** Drafting conversations whose transcript or style samples included any of `ids` of chat `chatId`. */
    draftsWithMessages(connectionId: string, chatId: number, ids: number[]): string[] {
      if (!ids.length) return [];
      const want = new Set(ids);
      return draftRows(connectionId)
        .filter((r) => (r.entries === null ? r.chatId === chatId : r.entries.some((e) => e.chatId === chatId && want.has(e.messageId))))
        .map((r) => r.conversationId);
    },
    draftsOfConnection(connectionId: string): string[] {
      return db.prepare('SELECT conversation_id FROM business_drafts WHERE connection_id = ?').all<{ conversation_id: string }>(connectionId).map((r) => r.conversation_id);
    },
    deleteDraft(conversationId: string): void {
      db.prepare('DELETE FROM business_drafts WHERE conversation_id = ?').run(conversationId);
    },

    /** Everything of one connection (disconnect, /deletemydata). The connection row itself is kept unless `dropConnection`. */
    purgeConnection(connectionId: string, dropConnection: boolean): void {
      db.tx(() => {
        db.prepare('DELETE FROM business_drafts WHERE connection_id = ?').run(connectionId);
        db.prepare('DELETE FROM business_messages WHERE connection_id = ?').run(connectionId);
        db.prepare('DELETE FROM business_chats WHERE connection_id = ?').run(connectionId);
        if (dropConnection) db.prepare('DELETE FROM business_connections WHERE id = ?').run(connectionId);
      });
    },
  };
  return repo;
}
export type BizRepo = ReturnType<typeof createBizRepo>;
