// memory/repo.ts (WP6a; friend mode: importance / expires_at, spec 05 B1/B3) — the only SQL over memory_facts,
// memory_fingerprints and extraction_watermarks (01 §7.2).
// Rows come back with their ciphertexts; memory/store.ts decrypts (AAD 'memory_facts|<column>|<id>').
import type { Ms, UserId } from '../contracts/common.ts';
import type { FactKind } from '../contracts/memory.ts';
import type { Db } from '../contracts/storage.ts';

export type FactStatus = 'active' | 'pending_confirm' | 'forgotten' | 'superseded';
export type SourceKind = 'user_message' | 'import' | 'miniapp' | 'tool_explicit' | 'group_explicit';
export type CreatedBy = 'user' | 'extractor' | 'model_tool' | 'import';

export interface FactRow {
  id: string; userId: UserId | null; scope: string; kind: FactKind; textEnc: Uint8Array | null; subjectEnc: Uint8Array | null; quoteEnc: Uint8Array | null;
  dekGen: number; sensitivity: 'normal' | 'sensitive'; confidence: number; pinned: boolean; status: FactStatus; sourceKind: SourceKind;
  sourceConversationId: string | null; sourceInputId: string | null; sourceTgMessageId: number | null; createdBy: CreatedBy; supersedesId: string | null;
  useCount: number; lastUsedAt: Ms | null; createdAt: Ms; updatedAt: Ms; forgottenAt: Ms | null;
  /** 003: 0–1 (default 0.5) and the TTL of short-lived mood/context facts (null = durable). */
  importance: number; expiresAt: Ms | null;
}
interface Raw {
  id: string; user_id: string | null; scope: string; kind: FactKind; text_enc: Uint8Array | null; subject_enc: Uint8Array | null; quote_enc: Uint8Array | null;
  dek_gen: number; sensitivity: 'normal' | 'sensitive'; confidence: number; pinned: number; status: FactStatus; source_kind: SourceKind;
  source_conversation_id: string | null; source_input_id: string | null; source_tg_message_id: number | null; created_by: CreatedBy; supersedes_id: string | null;
  use_count: number; last_used_at: number | null; created_at: number; updated_at: number; forgotten_at: number | null;
  importance: number | null; expires_at: number | null;
}
const toRow = (r: Raw): FactRow => ({
  id: r.id, userId: r.user_id, scope: r.scope, kind: r.kind, textEnc: r.text_enc, subjectEnc: r.subject_enc, quoteEnc: r.quote_enc, dekGen: Number(r.dek_gen),
  sensitivity: r.sensitivity, confidence: Number(r.confidence), pinned: Number(r.pinned) === 1, status: r.status, sourceKind: r.source_kind,
  sourceConversationId: r.source_conversation_id, sourceInputId: r.source_input_id, sourceTgMessageId: r.source_tg_message_id === null ? null : Number(r.source_tg_message_id),
  createdBy: r.created_by, supersedesId: r.supersedes_id, useCount: Number(r.use_count), lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), forgottenAt: r.forgotten_at === null ? null : Number(r.forgotten_at),
  importance: r.importance === null || r.importance === undefined ? 0.5 : Number(r.importance), expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
});

export interface NewFactRow {
  id: string; userId: UserId | null; scope: string; kind: FactKind; textEnc: Uint8Array; subjectEnc: Uint8Array | null; quoteEnc: Uint8Array | null; dekGen: number;
  sensitivity: 'normal' | 'sensitive'; confidence: number; pinned: boolean; status: 'active' | 'pending_confirm'; sourceKind: SourceKind;
  sourceConversationId: string | null; sourceInputId: string | null; sourceTgMessageId: number | null; createdBy: CreatedBy; supersedesId: string | null; now: Ms;
  importance?: number; expiresAt?: Ms | null;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);

export function createMemoryRepo(db: Db) {
  return {
    exists(id: string): boolean {
      return !!db.prepare(`SELECT 1 AS x FROM memory_facts WHERE id = ?`).get(id);
    },
    insert(f: NewFactRow): void {
      db.prepare(
        `INSERT INTO memory_facts (id, user_id, scope, kind, text_enc, subject_enc, quote_enc, dek_gen, sensitivity, confidence, pinned, status, source_kind,
           source_conversation_id, source_input_id, source_tg_message_id, created_by, supersedes_id, use_count, last_used_at, created_at, updated_at, forgotten_at,
           importance, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, ?, ?)`,
      ).run(
        f.id, f.userId, f.scope, f.kind, f.textEnc, f.subjectEnc, f.quoteEnc, f.dekGen, f.sensitivity, f.confidence, f.pinned ? 1 : 0, f.status, f.sourceKind,
        f.sourceConversationId, f.sourceInputId, f.sourceTgMessageId, f.createdBy, f.supersedesId, f.now, f.now, clamp01(f.importance ?? 0.5), f.expiresAt ?? null,
      );
    },
    get(id: string): FactRow | undefined {
      const r = db.prepare(`SELECT * FROM memory_facts WHERE id = ?`).get<Raw>(id);
      return r ? toRow(r) : undefined;
    },
    /** Rows of a scope in the given statuses (all statuses with text when `statuses` is omitted). */
    byScope(scope: string, statuses: readonly FactStatus[] = ['active', 'pending_confirm']): FactRow[] {
      return db
        .prepare(`SELECT * FROM memory_facts WHERE scope = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, id DESC`)
        .all<Raw>(scope, JSON.stringify(statuses))
        .map(toRow);
    },
    /** Every row of a scope that still holds ciphertext (for generation rotation). */
    withText(scope: string): FactRow[] {
      return db.prepare(`SELECT * FROM memory_facts WHERE scope = ? AND text_enc IS NOT NULL`).all<Raw>(scope).map(toRow);
    },
    /** The generations that still hold ciphertext in a scope. */
    gensWithText(scope: string): number[] {
      return db.prepare(`SELECT DISTINCT dek_gen AS g FROM memory_facts WHERE scope = ? AND text_enc IS NOT NULL`).all<{ g: number }>(scope).map((r) => Number(r.g));
    },
    /** Deletes the rows of a scope that still hold ciphertext under one of `gens` (orphans of a destroyed DEK). */
    deleteWithTextInGens(scope: string, gens: readonly number[]): number {
      if (!gens.length) return 0;
      return Number(
        db.prepare(`DELETE FROM memory_facts WHERE scope = ? AND text_enc IS NOT NULL AND dek_gen IN (SELECT value FROM json_each(?))`).run(scope, JSON.stringify(gens)).changes,
      );
    },
    /** Group scopes and generations that still hold ciphertext (the retention sweep checks their DEKs). */
    groupGensWithText(): Array<{ scope: string; gen: number }> {
      return db
        .prepare(`SELECT DISTINCT scope, dek_gen AS g FROM memory_facts WHERE scope LIKE 'grp:%' AND text_enc IS NOT NULL`)
        .all<{ scope: string; g: number }>()
        .map((r) => ({ scope: r.scope, gen: Number(r.g) }));
    },
    countActive(scope: string): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM memory_facts WHERE scope = ? AND status = 'active'`).get<{ n: number }>(scope)?.n ?? 0);
    },
    maxGen(scope: string): number {
      return Number(db.prepare(`SELECT COALESCE(MAX(dek_gen), 0) AS g FROM memory_facts WHERE scope = ?`).get<{ g: number }>(scope)?.g ?? 0);
    },
    distinctGens(scope: string): number[] {
      return db.prepare(`SELECT DISTINCT dek_gen AS g FROM memory_facts WHERE scope = ?`).all<{ g: number }>(scope).map((r) => Number(r.g));
    },
    /** The overflow victim (§9 cap): the oldest unpinned, least-used active fact. */
    overflowVictim(scope: string): string | undefined {
      return db
        .prepare(`SELECT id FROM memory_facts WHERE scope = ? AND status = 'active' AND pinned = 0 ORDER BY use_count, COALESCE(last_used_at, created_at), created_at LIMIT 1`)
        .get<{ id: string }>(scope)?.id;
    },
    setStatus(id: string, status: FactStatus, now: Ms): boolean {
      return Number(db.prepare(`UPDATE memory_facts SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id).changes) > 0;
    },
    /** A status change guarded by the current status (CAS). */
    casStatus(id: string, from: FactStatus, to: FactStatus, now: Ms): boolean {
      return Number(db.prepare(`UPDATE memory_facts SET status = ?, updated_at = ? WHERE id = ? AND status = ?`).run(to, now, id, from).changes) > 0;
    },
    setText(id: string, textEnc: Uint8Array, subjectEnc: Uint8Array | null, quoteEnc: Uint8Array | null, dekGen: number, now: Ms | null): void {
      if (now === null) db.prepare(`UPDATE memory_facts SET text_enc = ?, subject_enc = ?, quote_enc = ?, dek_gen = ? WHERE id = ?`).run(textEnc, subjectEnc, quoteEnc, dekGen, id);
      else db.prepare(`UPDATE memory_facts SET text_enc = ?, subject_enc = ?, quote_enc = ?, dek_gen = ?, updated_at = ? WHERE id = ?`).run(textEnc, subjectEnc, quoteEnc, dekGen, now, id);
    },
    setPinned(id: string, pinned: boolean, now: Ms): void {
      db.prepare(`UPDATE memory_facts SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, now, id);
    },
    /** §9 forget step 1: status forgotten, every ciphertext nulled. */
    markForgotten(id: string, now: Ms): boolean {
      return (
        Number(
          db
            .prepare(`UPDATE memory_facts SET status = 'forgotten', text_enc = NULL, subject_enc = NULL, quote_enc = NULL, forgotten_at = ?, updated_at = ? WHERE id = ? AND status <> 'forgotten'`)
            .run(now, now, id).changes,
        ) > 0
      );
    },
    bumpUses(ids: readonly string[], now: Ms): void {
      if (!ids.length) return;
      db.prepare(`UPDATE memory_facts SET use_count = use_count + 1, last_used_at = ? WHERE id IN (SELECT value FROM json_each(?))`).run(now, JSON.stringify(ids));
    },
    bySourceConversation(scope: string, conversationId: string): FactRow[] {
      return db.prepare(`SELECT * FROM memory_facts WHERE scope = ? AND source_conversation_id = ? AND status <> 'forgotten'`).all<Raw>(scope, conversationId).map(toRow);
    },
    /** Facts written from a conversation by the extractor since `since` (the [📝 Remembered N · Review] list). */
    extractedSince(conversationId: string, since: Ms): FactRow[] {
      return db
        .prepare(`SELECT * FROM memory_facts WHERE source_conversation_id = ? AND created_by = 'extractor' AND created_at >= ? AND status IN ('active','pending_confirm') ORDER BY created_at, id`)
        .all<Raw>(conversationId, since)
        .map(toRow);
    },
    /** One import batch (all rows of one importText call share created_at). */
    importBatch(scope: string, createdAt: Ms): FactRow[] {
      return db.prepare(`SELECT * FROM memory_facts WHERE scope = ? AND source_kind = 'import' AND created_at = ? ORDER BY rowid`).all<Raw>(scope, createdAt).map(toRow);
    },
    allOfUser(scope: string, userId: UserId): FactRow[] {
      return db.prepare(`SELECT * FROM memory_facts WHERE scope = ? OR user_id = ? ORDER BY created_at`).all<Raw>(scope, userId).map(toRow);
    },

    /** Rows with text whose TTL passed (B1 mood/context facts): the retention sweep deletes them. */
    expired(now: Ms, limit = 500): Array<{ id: string; scope: string }> {
      return db
        .prepare(`SELECT id, scope FROM memory_facts WHERE expires_at IS NOT NULL AND expires_at <= ? AND status <> 'forgotten' LIMIT ?`)
        .all<{ id: string; scope: string }>(now, limit);
    },
    /** Hard delete (expiry only: an expired mood/context fact is not "forgotten", so no fingerprints). Embeddings go first. */
    deleteFacts(ids: readonly string[]): number {
      if (!ids.length) return 0;
      const j = JSON.stringify(ids);
      db.prepare(`DELETE FROM fact_embeddings WHERE fact_id IN (SELECT value FROM json_each(?))`).run(j);
      return Number(db.prepare(`DELETE FROM memory_facts WHERE id IN (SELECT value FROM json_each(?))`).run(j).changes);
    },
    /** Active facts of a scope created after `since` (the "after 15 new facts" consolidation trigger). */
    countActiveSince(scope: string, since: Ms): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM memory_facts WHERE scope = ? AND status = 'active' AND created_at > ?`).get<{ n: number }>(scope, since)?.n ?? 0);
    },
    /** The newest change to the active facts of a scope (nightly consolidation skips an unchanged memory). */
    lastActiveChange(scope: string): Ms | null {
      const r = db.prepare(`SELECT MAX(updated_at) AS t FROM memory_facts WHERE scope = ? AND status IN ('active','forgotten','superseded')`).get<{ t: number | null }>(scope);
      return r?.t === null || r?.t === undefined ? null : Number(r.t);
    },

    // ── fingerprints
    addFingerprints(scope: string, hmacs: readonly string[], now: Ms): void {
      const st = db.prepare(`INSERT OR IGNORE INTO memory_fingerprints (scope, fp_hmac, created_at) VALUES (?, ?, ?)`);
      for (const h of hmacs) st.run(scope, h, now);
    },
    fingerprints(scope: string): Set<string> {
      return new Set(db.prepare(`SELECT fp_hmac FROM memory_fingerprints WHERE scope = ?`).all<{ fp_hmac: string }>(scope).map((r) => r.fp_hmac));
    },

    // ── extraction watermarks
    watermark(conversationId: string): { lastInputCreatedAt: Ms; lastRunAt: Ms } | undefined {
      const r = db.prepare(`SELECT last_input_created_at AS a, last_run_at AS b FROM extraction_watermarks WHERE conversation_id = ?`).get<{ a: number; b: number }>(conversationId);
      return r ? { lastInputCreatedAt: Number(r.a), lastRunAt: Number(r.b) } : undefined;
    },
    setWatermark(conversationId: string, lastInputCreatedAt: Ms, now: Ms): void {
      db.prepare(
        `INSERT INTO extraction_watermarks (conversation_id, last_input_created_at, last_run_at) VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET last_input_created_at = MAX(last_input_created_at, excluded.last_input_created_at), last_run_at = excluded.last_run_at`,
      ).run(conversationId, lastInputCreatedAt, now);
    },
  };
}
export type MemoryRepo = ReturnType<typeof createMemoryRepo>;
