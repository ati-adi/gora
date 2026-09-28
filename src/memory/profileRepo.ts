// memory/profileRepo.ts (friend mode, spec 05 B4) — the only SQL over `user_profile`: one sealed row per card version
// (the latest is current). Payload sealed by memory/profile.ts under the memory DEK 'm:<userId>:<dek_gen>' with AAD
// 'user_profile|profile_enc|<userId>:<version>', so a forget rotation (which destroys the old generation) shreds it.
import type { Ms, UserId } from '../contracts/common.ts';
import type { Db } from '../contracts/storage.ts';

export type ProfileReason = 'nightly' | 'facts' | 'forget' | 'edit' | 'manual';
export interface ProfileRow { userId: UserId; version: number; profileEnc: Uint8Array; dekGen: number; factCount: number; reason: ProfileReason; createdAt: Ms }

export const profileAad = (userId: UserId, version: number): string => `user_profile|profile_enc|${userId}:${version}`;

export function createProfileRepo(db: Db) {
  const toRow = (r: { user_id: string; version: number; profile_enc: Uint8Array; dek_gen: number; fact_count: number; reason: ProfileReason; created_at: number }): ProfileRow => ({
    userId: r.user_id, version: Number(r.version), profileEnc: r.profile_enc, dekGen: Number(r.dek_gen), factCount: Number(r.fact_count), reason: r.reason, createdAt: Number(r.created_at),
  });
  return {
    latest(userId: UserId): ProfileRow | undefined {
      const r = db.prepare(`SELECT * FROM user_profile WHERE user_id = ? ORDER BY version DESC LIMIT 1`).get<Parameters<typeof toRow>[0]>(userId);
      return r ? toRow(r) : undefined;
    },
    /** The newest LLM-written version (nightly / facts / manual / forget): the once-a-day limit looks at it. */
    lastConsolidated(userId: UserId): ProfileRow | undefined {
      const r = db
        .prepare(`SELECT * FROM user_profile WHERE user_id = ? AND reason IN ('nightly','facts','manual','forget') ORDER BY version DESC LIMIT 1`)
        .get<Parameters<typeof toRow>[0]>(userId);
      return r ? toRow(r) : undefined;
    },
    maxVersion(userId: UserId): number {
      return Number(db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM user_profile WHERE user_id = ?`).get<{ v: number }>(userId)?.v ?? 0);
    },
    insert(r: ProfileRow): void {
      db.prepare(`INSERT INTO user_profile (user_id, version, profile_enc, dek_gen, fact_count, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        r.userId, r.version, r.profileEnc, r.dekGen, r.factCount, r.reason, r.createdAt,
      );
    },
    /** Keeps the newest `keep` versions. */
    prune(userId: UserId, keep: number): number {
      return Number(
        db.prepare(`DELETE FROM user_profile WHERE user_id = ? AND version NOT IN (SELECT version FROM user_profile WHERE user_id = ? ORDER BY version DESC LIMIT ?)`).run(userId, userId, keep).changes,
      );
    },
    deleteAll(userId: UserId): number {
      return Number(db.prepare(`DELETE FROM user_profile WHERE user_id = ?`).run(userId).changes);
    },
    count(userId: UserId): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM user_profile WHERE user_id = ?`).get<{ n: number }>(userId)?.n ?? 0);
    },
  };
}
export type ProfileRepo = ReturnType<typeof createProfileRepo>;
