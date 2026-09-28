// telegram/links.ts (WP2) — tg_links: which run / card / nudge produced a Telegram message (/why, recovery §5.11,
// replies to cards). Business chat ids live in their own space 'biz:<connectionId>'.
import type { Clock, Db, TgLinkRow, TgLinks } from '../contracts/index.ts';

export const LINK_KINDS: ReadonlySet<string> = new Set(['answer', 'card', 'nudge', 'status', 'reminder', 'brief', 'intro', 'file', 'venue', 'list', 'notice', 'onboarding', 'voice']);

interface Raw {
  space: string; chat_id: number; message_id: number; kind: string; user_id: string | null; conversation_id: string | null; epoch: number | null;
  seq: number | null; run_id: string | null; pending_action_id: string | null; nudge_id: string | null; job_id: string | null; part: number;
}
const toRow = (r: Raw): TgLinkRow => ({
  space: r.space, chatId: Number(r.chat_id), messageId: Number(r.message_id), kind: r.kind, userId: r.user_id, conversationId: r.conversation_id,
  epoch: r.epoch === null ? null : Number(r.epoch), seq: r.seq === null ? null : Number(r.seq), runId: r.run_id, pendingActionId: r.pending_action_id,
  nudgeId: r.nudge_id, jobId: r.job_id, part: Number(r.part),
});
const COLS = 'space, chat_id, message_id, kind, user_id, conversation_id, epoch, seq, run_id, pending_action_id, nudge_id, job_id, part';

export function createLinks(db: Db, clock: Clock): TgLinks & { deleteForChat(chatId: number): number } {
  return {
    record(l) {
      if (!LINK_KINDS.has(l.kind)) throw new Error(`tg_links: unknown kind ${l.kind}`);
      if (!l.messageId) return; // ephemeral / inline messages have no message id
      db.prepare(`INSERT OR REPLACE INTO tg_links (${COLS}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        l.space ?? 'bot', l.chatId, l.messageId, l.kind, l.userId ?? null, l.conversationId ?? null, l.epoch ?? null, l.seq ?? null, l.runId ?? null,
        l.pendingActionId ?? null, l.nudgeId ?? null, l.jobId ?? null, l.part ?? 0, clock.now(),
      );
    },
    lookup(chatId, messageId, space = 'bot') {
      const r = db.prepare(`SELECT ${COLS} FROM tg_links WHERE space = ? AND chat_id = ? AND message_id = ?`).get<Raw>(space, chatId, messageId);
      return r ? toRow(r) : undefined;
    },
    byRun(runId) {
      return db.prepare(`SELECT ${COLS} FROM tg_links WHERE run_id = ? ORDER BY created_at, part`).all<Raw>(runId).map(toRow);
    },
    deleteForChat(chatId) {
      return Number(db.prepare('DELETE FROM tg_links WHERE chat_id = ?').run(chatId).changes);
    },
  };
}
