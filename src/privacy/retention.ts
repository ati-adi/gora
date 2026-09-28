// privacy/retention.ts (WP1) — the hourly retention_sweep (01 §11.9 retention table), WP1's rows plus every
// privacy hook's retentionSweep (WP2 tg_updates/outbox; WP4 pending-action payloads; WP5 location; WP7 business
// messages, guest invocations, deep-link tokens). WP1's part:
//   - closed epochs              → shredded 90 days after closing (shredEpoch; idempotent retry of half-done shreds)
//   - guest conversations        → purged 24 h after their last activity
//   - biz_draft conversations    → purged 30 days after their last activity
//   - llm_calls.raw_enc          → nulled after 30 days
//   - ledger, sentinel decisions → rows older than 365 days deleted (the first remaining ledger row keeps its
//                                  prev_hmac as the anchor, so verify() still passes)
//   - rate_buckets               → windows older than 1 day dropped
//   - unreferenced blobs         → deleted 7 days after creation (outbox binary payloads live at most 7 days)
//   - users stuck in 'deleting'  → the deletion plan is resumed
// Each step is isolated: one failing step is logged and the others still run.
import type { Ms, Services } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { DELETION_MARKER_TTL_MS, type Deleter } from './delete.ts';
import type { Shredder } from './shred.ts';

const H = 3_600_000;
const D = 24 * H;
export const RETENTION = Object.freeze({
  closedEpochMs: 90 * D,
  guestConversationMs: 24 * H,
  bizDraftConversationMs: 30 * D,
  llmRawMs: 30 * D,
  ledgerMs: 365 * D,
  sentinelDecisionMs: 365 * D,
  rateBucketMs: D,
  orphanBlobMs: 7 * D,
});
/** Per sweep, so one hourly run stays short; the remainder is picked up by the next sweep. */
const BATCH = 500;
/** Mirrors the ledger/sentinel delete-guard triggers (SQLite wall clock), so a sweep never trips them. */
const TRIGGER_CUTOFF = `(CAST(strftime('%s','now') AS INTEGER) - 31536000) * 1000`;

export interface RetentionReport {
  epochsShredded: number;
  conversationsPurged: number;
  llmRawNulled: number;
  ledgerRowsDeleted: number;
  sentinelRowsDeleted: number;
  rateBucketsDeleted: number;
  blobsDeleted: number;
  deletionsResumed: number;
  failedSteps: string[];
}

export function createRetention(s: Services, shredder: Shredder, deleter: Deleter): { sweep(now: Ms): Promise<RetentionReport> } {
  return {
    async sweep(now) {
      const db = s.db;
      const r: RetentionReport = {
        epochsShredded: 0, conversationsPurged: 0, llmRawNulled: 0, ledgerRowsDeleted: 0, sentinelRowsDeleted: 0,
        rateBucketsDeleted: 0, blobsDeleted: 0, deletionsResumed: 0, failedSteps: [],
      };
      const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
        try {
          await fn();
        } catch (e) {
          r.failedSteps.push(name);
          s.log.error({ step: name, err: errorMessage(e) }, 'retention step failed');
        }
      };

      await step('deleting_users', async () => {
        r.deletionsResumed = await deleter.resumeStuck();
      });

      await step('closed_epochs', async () => {
        for (const e of s.repos.conversations.closedEpochsOlderThan(now - RETENTION.closedEpochMs).slice(0, BATCH)) {
          try {
            await shredder.shredEpoch(e.conversationId, e.epoch, 'retention', { allowCurrent: true });
            r.epochsShredded++;
          } catch (err) {
            s.log.error({ conversationId: e.conversationId, epoch: e.epoch, err: errorMessage(err) }, 'retention: shredEpoch failed');
          }
        }
      });

      await step('guest_biz_conversations', async () => {
        const rows = db
          .prepare(
            `SELECT id FROM conversations WHERE (kind = 'guest' AND last_activity_at <= ?) OR (kind = 'biz_draft' AND last_activity_at <= ?)
             ORDER BY last_activity_at LIMIT ?`,
          )
          .all<{ id: string }>(now - RETENTION.guestConversationMs, now - RETENTION.bizDraftConversationMs, BATCH);
        for (const c of rows) {
          // A guest run still in flight keeps its conversation until the next sweep.
          const conv = s.repos.conversations.get(c.id);
          if (conv?.activeRunId) continue;
          try {
            await shredder.purgeConversation(c.id, 'retention');
            r.conversationsPurged++;
          } catch (err) {
            s.log.error({ conversationId: c.id, err: errorMessage(err) }, 'retention: purgeConversation failed');
          }
        }
      });

      await step('llm_raw', () => {
        r.llmRawNulled = Number(db.prepare('UPDATE llm_calls SET raw_enc = NULL WHERE raw_enc IS NOT NULL AND created_at < ?').run(now - RETENTION.llmRawMs).changes);
      });

      await step('ledger', () => {
        r.ledgerRowsDeleted = Number(db.prepare(`DELETE FROM ledger WHERE ts < ? AND ts < ${TRIGGER_CUTOFF}`).run(now - RETENTION.ledgerMs).changes);
      });

      await step('sentinel_decisions', () => {
        r.sentinelRowsDeleted = Number(
          db.prepare(`DELETE FROM sentinel_decisions WHERE created_at < ? AND created_at < ${TRIGGER_CUTOFF}`).run(now - RETENTION.sentinelDecisionMs).changes,
        );
      });

      await step('rate_buckets', () => {
        r.rateBucketsDeleted = Number(db.prepare('DELETE FROM rate_buckets WHERE window_start < ?').run(now - RETENTION.rateBucketMs).changes);
      });

      await step('deletion_markers', () => {
        db.prepare(`DELETE FROM kv WHERE key LIKE 'deleted_tg:%' AND updated_at < ?`).run(now - DELETION_MARKER_TTL_MS);
      });

      await step('orphan_blobs', () => {
        r.blobsDeleted = Number(
          db.prepare('DELETE FROM blobs WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM blob_refs b WHERE b.blob_id = blobs.id)').run(now - RETENTION.orphanBlobMs).changes,
        );
      });

      for (const h of s.privacyHooks) {
        if (!h.retentionSweep) continue;
        await step(`hook:${h.name}`, () => h.retentionSweep!(now));
      }

      s.log.info({ ...r }, 'retention sweep done');
      return r;
    },
  };
}
