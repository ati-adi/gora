// privacy/shred.ts (WP1) — epoch and conversation shredding (01 §11.7 shredEpoch, §9 "forget a whole conversation").
//
// shredEpoch, in the §11.7 order:
//   1. insert the shred token;  2. DELETE the epoch's messages;  3. delete that epoch's tool_calls, llm_calls, run_waits,
//   run_memory_uses, runs, the conv_events those runs consumed, conversation_inputs with consumed_epoch = epoch and the
//   blob_refs rows (blobs left without references are deleted);  4. crypto.destroyDek('e:<conv>:<epoch>');
//   5. epochs.shredded_at;  6. the privacy hooks' onShredEpoch.
// Steps 1–3 are one transaction; 4 and 5 run after it so a crash in between leaves shredded_at NULL and the retention
// sweep (closedEpochsOlderThan) retries the whole idempotent sequence.
import type { Services } from '../contracts/index.ts';
import type { Db } from '../contracts/storage.ts';
import { errorMessage } from '../kernel/errors.ts';
import { epochDek } from '../db/repos/common.ts';

export class ShredCurrentEpochError extends Error {
  constructor(conversationId: string, epoch: number) {
    super(`shredEpoch: ${conversationId}:${epoch} is the current epoch of an active conversation; rotate first (or use shredConversation)`);
    this.name = 'ShredCurrentEpochError';
  }
}

const RUNS_OF_EPOCH = 'SELECT id FROM runs WHERE conversation_id = ? AND epoch = ?';

/** Steps 1–3 for one epoch (sync, caller's transaction). */
function deleteEpochRows(db: Db, conversationId: string, epoch: number, reason: string, now: number): void {
  const c = conversationId;
  db.prepare('INSERT OR IGNORE INTO shred_tokens(conversation_id, epoch, reason, created_at) VALUES (?, ?, ?, ?)').run(c, epoch, reason.slice(0, 64), now);
  db.prepare('DELETE FROM messages WHERE conversation_id = ? AND epoch = ?').run(c, epoch);
  db.prepare('DELETE FROM tool_calls WHERE conversation_id = ? AND epoch = ?').run(c, epoch);
  db.prepare(`DELETE FROM tool_calls WHERE run_id IN (${RUNS_OF_EPOCH})`).run(c, epoch);
  db.prepare('DELETE FROM llm_calls WHERE conversation_id = ? AND epoch = ?').run(c, epoch);
  db.prepare(`DELETE FROM llm_calls WHERE run_id IN (${RUNS_OF_EPOCH})`).run(c, epoch);
  db.prepare(`DELETE FROM run_waits WHERE run_id IN (${RUNS_OF_EPOCH})`).run(c, epoch);
  db.prepare(`DELETE FROM run_memory_uses WHERE run_id IN (${RUNS_OF_EPOCH})`).run(c, epoch);
  db.prepare(`DELETE FROM conv_events WHERE conversation_id = ? AND delivered_run_id IN (${RUNS_OF_EPOCH})`).run(c, c, epoch);
  db.prepare(`UPDATE conversations SET active_run_id = NULL WHERE id = ? AND active_run_id IN (${RUNS_OF_EPOCH})`).run(c, c, epoch);
  db.prepare('DELETE FROM runs WHERE conversation_id = ? AND epoch = ?').run(c, epoch);
  db.prepare('DELETE FROM conversation_inputs WHERE conversation_id = ? AND consumed_epoch = ?').run(c, epoch);
  const blobIds = db.prepare('SELECT blob_id FROM blob_refs WHERE conversation_id = ? AND epoch = ?').all<{ blob_id: string }>(c, epoch).map((r) => r.blob_id);
  db.prepare('DELETE FROM blob_refs WHERE conversation_id = ? AND epoch = ?').run(c, epoch);
  const orphan = db.prepare('DELETE FROM blobs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_id = blobs.id)');
  for (const id of blobIds) orphan.run(id);
  db.prepare('UPDATE epochs SET handoff_summary_enc = NULL, closed_at = COALESCE(closed_at, ?) WHERE conversation_id = ? AND epoch = ?').run(now, c, epoch);
}

export interface Shredder {
  shredEpoch(conversationId: string, epoch: number, reason: string, o?: { allowCurrent?: boolean }): Promise<void>;
  /** Shreds every epoch; an active conversation first rotates to a fresh 'wipe' epoch (when the current one holds anything) and stays usable; otherwise it becomes 'purged'. */
  shredConversation(conversationId: string, reason: string): Promise<void>;
  /** Shreds every epoch and deletes the conversation and all its rows (retention of guest / biz_draft conversations; frees the scope key). */
  purgeConversation(conversationId: string, reason: string): Promise<void>;
}

export function createShredder(s: Services): Shredder {
  const runHooks = async (conversationId: string, epoch: number): Promise<void> => {
    for (const h of s.privacyHooks) {
      if (!h.onShredEpoch) continue;
      try {
        await h.onShredEpoch(conversationId, epoch);
      } catch (e) {
        s.log.error({ hook: h.name, conversationId, epoch, err: errorMessage(e) }, 'privacy hook onShredEpoch failed');
      }
    }
  };

  const epochsOf = (conversationId: string): Array<{ epoch: number; shredded: boolean }> =>
    s.db
      .prepare('SELECT epoch, shredded_at FROM epochs WHERE conversation_id = ? ORDER BY epoch')
      .all<{ epoch: number; shredded_at: number | null }>(conversationId)
      .map((r) => ({ epoch: Number(r.epoch), shredded: r.shredded_at !== null }));

  const shredEpoch: Shredder['shredEpoch'] = async (conversationId, epoch, reason, o) => {
    const db = s.db;
    const conv = s.repos.conversations.get(conversationId);
    const dek = epochDek(conversationId, epoch);
    if (!conv) {
      // The conversation is gone (deleted with a user): only the key can still exist.
      s.crypto.destroyDek(dek);
      return;
    }
    if (!o?.allowCurrent && conv.status === 'active' && conv.epoch === epoch) throw new ShredCurrentEpochError(conversationId, epoch);
    const exists = db.prepare('SELECT 1 AS x FROM epochs WHERE conversation_id = ? AND epoch = ?').get(conversationId, epoch);
    if (!exists) {
      s.crypto.destroyDek(dek);
      return;
    }
    db.tx(() => deleteEpochRows(db, conversationId, epoch, reason, s.clock.now()));
    s.crypto.destroyDek(dek);
    db.prepare('UPDATE epochs SET shredded_at = COALESCE(shredded_at, ?) WHERE conversation_id = ? AND epoch = ?').run(s.clock.now(), conversationId, epoch);
    s.log.info({ conversationId, epoch, reason }, 'epoch shredded');
    await runHooks(conversationId, epoch);
  };

  const shredConversation: Shredder['shredConversation'] = async (conversationId, reason) => {
    let conv = s.repos.conversations.get(conversationId);
    if (!conv) return;
    const db = s.db;
    if (conv.status === 'active') {
      const cur = s.repos.conversations.currentEpoch(conversationId);
      const used =
        cur.nextSeq > 1 ||
        cur.handoffSummary !== null ||
        !!db.prepare('SELECT 1 AS x FROM runs WHERE conversation_id = ? AND epoch = ? LIMIT 1').get(conversationId, cur.epoch) ||
        !!db.prepare('SELECT 1 AS x FROM conversation_inputs WHERE conversation_id = ? AND consumed_epoch = ? LIMIT 1').get(conversationId, cur.epoch);
      if (used && !cur.shreddedAt) s.repos.conversations.startEpoch(conversationId, 'wipe', 'none', []);
      conv = s.repos.conversations.get(conversationId)!;
    }
    for (const e of epochsOf(conversationId)) {
      if (conv.status === 'active' && e.epoch === conv.epoch) continue; // the fresh (empty) epoch stays
      if (e.shredded) {
        s.crypto.destroyDek(epochDek(conversationId, e.epoch)); // idempotent re-assertion
        continue;
      }
      await shredEpoch(conversationId, e.epoch, reason, { allowCurrent: true });
    }
    if (conv.status !== 'active') s.repos.conversations.update(conversationId, { status: 'purged' });
  };

  const purgeConversation: Shredder['purgeConversation'] = async (conversationId, reason) => {
    const conv = s.repos.conversations.get(conversationId);
    if (!conv) return;
    for (const e of epochsOf(conversationId)) {
      if (e.shredded) s.crypto.destroyDek(epochDek(conversationId, e.epoch));
      else await shredEpoch(conversationId, e.epoch, reason, { allowCurrent: true });
    }
    const db = s.db;
    const c = conversationId;
    const runs = 'SELECT id FROM runs WHERE conversation_id = ?';
    db.tx(() => {
      // Anything left that is not epoch-bound (pending inputs, undelivered events, runs without an epoch match).
      db.prepare(`DELETE FROM tool_calls WHERE conversation_id = ? OR run_id IN (${runs})`).run(c, c);
      db.prepare(`DELETE FROM llm_calls WHERE conversation_id = ? OR run_id IN (${runs})`).run(c, c);
      db.prepare(`DELETE FROM run_memory_uses WHERE run_id IN (${runs})`).run(c);
      db.prepare(`DELETE FROM run_waits WHERE run_id IN (${runs})`).run(c);
      db.prepare('DELETE FROM runs WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM conversation_inputs WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM conv_events WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM conversation_toolkits WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM conversation_turns WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM extraction_watermarks WHERE conversation_id = ?').run(c);
      const blobIds = db.prepare('SELECT blob_id FROM blob_refs WHERE conversation_id = ?').all<{ blob_id: string }>(c).map((r) => r.blob_id);
      db.prepare('DELETE FROM blob_refs WHERE conversation_id = ?').run(c);
      const orphan = db.prepare('DELETE FROM blobs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_id = blobs.id)');
      for (const id of blobIds) orphan.run(id);
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c); // all epochs carry shred tokens by now
      db.prepare('DELETE FROM epochs WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM shred_tokens WHERE conversation_id = ?').run(c);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(c);
    });
    s.log.info({ conversationId, reason }, 'conversation purged');
  };

  return { shredEpoch, shredConversation, purgeConversation };
}
