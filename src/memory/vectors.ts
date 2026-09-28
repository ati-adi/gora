// memory/vectors.ts (friend mode, spec 05 B2) — local semantic embeddings of facts in `fact_embeddings`.
// Each vector is the fact text embedded as an e5 'passage' by s.caps.embedder, stored as Float32 LE bytes sealed like the
// fact text: under the scope's memory DEK generation ('m:<userId>:<gen>' | 'mg:<chatId>:<gen>'), AAD
// 'fact_embeddings|vec_enc|<factId>'. Derived data, still personal: a forget / supersede / edit / expiry drops the vector
// with the text, and the forget rotation re-seals the survivors under the new generation before the old DEK is destroyed.
// Embedding never blocks a save: the `memory_embed` job (per scope, dedupe 'me:<scopeKey>', no LLM) backfills missing
// vectors in batches of 32, and a vector of another model is ignored and re-embedded.
import type { Ms, Scope } from '../contracts/common.ts';
import { scopeKey } from '../contracts/common.ts';
import type { Embedder } from '../contracts/capabilities.ts';
import type { Services } from '../contracts/services.ts';
import type { Db } from '../contracts/storage.ts';
import { bytesToVec, vecToBytes } from '../capabilities/embedder.ts';
import { errorMessage } from '../kernel/errors.ts';

export const EMBED_BATCH = 32;
const CACHE_SCOPES = 200;

export const embedKey = (scope: Scope): string => `me:${scopeKey(scope)}`;

export interface VectorRow { factId: string; scope: string; model: string; dim: number; dekGen: number; vecEnc: Uint8Array }

export function createVectorRepo(db: Db) {
  return {
    upsert(r: VectorRow & { userId: string | null; now: Ms }): void {
      db.prepare(
        `INSERT INTO fact_embeddings (fact_id, user_id, scope, model, dim, dek_gen, vec_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fact_id) DO UPDATE SET user_id = excluded.user_id, scope = excluded.scope, model = excluded.model, dim = excluded.dim,
           dek_gen = excluded.dek_gen, vec_enc = excluded.vec_enc, created_at = excluded.created_at`,
      ).run(r.factId, r.userId, r.scope, r.model, r.dim, r.dekGen, r.vecEnc, r.now);
    },
    byScope(scope: string): VectorRow[] {
      return db
        .prepare(`SELECT fact_id, scope, model, dim, dek_gen, vec_enc FROM fact_embeddings WHERE scope = ?`)
        .all<{ fact_id: string; scope: string; model: string; dim: number; dek_gen: number; vec_enc: Uint8Array }>(scope)
        .map((r) => ({ factId: r.fact_id, scope: r.scope, model: r.model, dim: Number(r.dim), dekGen: Number(r.dek_gen), vecEnc: r.vec_enc }));
    },
    setSealed(factId: string, vecEnc: Uint8Array, dekGen: number): void {
      db.prepare(`UPDATE fact_embeddings SET vec_enc = ?, dek_gen = ? WHERE fact_id = ?`).run(vecEnc, dekGen, factId);
    },
    delete(ids: readonly string[]): number {
      if (!ids.length) return 0;
      return Number(db.prepare(`DELETE FROM fact_embeddings WHERE fact_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids)).changes);
    },
    /** Vectors whose fact no longer holds active text (forgotten / superseded / pending): never searched, so dropped. */
    deleteStale(scope: string): number {
      return Number(
        db
          .prepare(`DELETE FROM fact_embeddings WHERE scope = ? AND fact_id NOT IN (SELECT id FROM memory_facts WHERE scope = ? AND status = 'active' AND text_enc IS NOT NULL)`)
          .run(scope, scope).changes,
      );
    },
    deleteInGens(scope: string, gens: readonly number[]): number {
      if (!gens.length) return 0;
      return Number(db.prepare(`DELETE FROM fact_embeddings WHERE scope = ? AND dek_gen IN (SELECT value FROM json_each(?))`).run(scope, JSON.stringify(gens)).changes);
    },
    countOfUser(userId: string): number {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM fact_embeddings WHERE user_id = ? AND scope = ?`).get<{ n: number }>(userId, `user:${userId}`)?.n ?? 0);
    },
  };
}
export type VectorRepo = ReturnType<typeof createVectorRepo>;

export interface VectorDeps {
  dekFor(scope: Scope, gen: number): string;
  ownerOf(scope: Scope): string;
}

/** The embedder, or null when the app has none wired (unit environments without capabilities). */
export function embedderOf(s: Services): Embedder | null {
  const e = (s as { caps?: { embedder?: Embedder } }).caps?.embedder;
  return e && typeof e.embed === 'function' ? e : null;
}

export function createVectors(s: Services, d: VectorDeps) {
  let repoCache: VectorRepo | null = null;
  const repo = (): VectorRepo => (repoCache ??= createVectorRepo(s.db));
  const log = () => s.log.child({ mod: 'memory', sub: 'vectors' });
  const aad = (factId: string) => `fact_embeddings|vec_enc|${factId}`;
  // decrypted vectors per scope, keyed like the fact LRU: (generation, model, write version)
  const cache = new Map<string, { gen: number; model: string; version: number; vecs: Map<string, Float32Array> }>();
  const versions = new Map<string, number>();
  const bump = (sk: string) => {
    versions.set(sk, (versions.get(sk) ?? 0) + 1);
    cache.delete(sk);
  };

  const seal = (scope: Scope, gen: number, factId: string, v: Float32Array): Uint8Array => {
    const dek = d.dekFor(scope, gen);
    s.crypto.ensureDek(dek, d.ownerOf(scope), 'memory');
    return s.crypto.seal(dek, vecToBytes(v), aad(factId));
  };

  return {
    repo,
    /** Decrypted vectors of the scope for the embedder's current model (other models are ignored → re-embedded). */
    load(scope: Scope, gen: number, model: string, dim: number): Map<string, Float32Array> {
      const sk = scopeKey(scope);
      const version = versions.get(sk) ?? 0;
      const hit = cache.get(sk);
      if (hit && hit.gen === gen && hit.model === model && hit.version === version) {
        cache.delete(sk);
        cache.set(sk, hit);
        return hit.vecs;
      }
      const vecs = new Map<string, Float32Array>();
      for (const r of repo().byScope(sk)) {
        if (r.model !== model || r.dim !== dim) continue;
        try {
          const v = bytesToVec(s.crypto.open(r.vecEnc, aad(r.factId)));
          if (v.length === dim) vecs.set(r.factId, v);
        } catch (e) {
          log().warn({ factId: r.factId, err: errorMessage(e) }, 'embedding could not be decrypted');
        }
      }
      cache.set(sk, { gen, model, version, vecs });
      while (cache.size > CACHE_SCOPES) cache.delete(cache.keys().next().value as string);
      return vecs;
    },
    put(scope: Scope, userId: string | null, factId: string, gen: number, model: string, v: Float32Array): void {
      const sk = scopeKey(scope);
      repo().upsert({ factId, userId, scope: sk, model, dim: v.length, dekGen: gen, vecEnc: seal(scope, gen, factId, v), now: s.clock.now() });
      const c = cache.get(sk);
      if (c && c.gen === gen && c.model === model && c.version === (versions.get(sk) ?? 0)) c.vecs.set(factId, v);
    },
    drop(scope: Scope, ids: readonly string[]): void {
      if (!ids.length) return;
      repo().delete(ids);
      bump(scopeKey(scope));
    },
    dropStale(scope: Scope): void {
      if (repo().deleteStale(scopeKey(scope))) bump(scopeKey(scope));
    },
    /**
     * Forget step 3 companion (inside the rotation transaction, before the old DEKs are destroyed): every remaining
     * vector is re-sealed under `newGen`; a vector that cannot be opened any more is deleted (re-embedded later).
     */
    reseal(scope: Scope, newGen: number): void {
      const sk = scopeKey(scope);
      for (const r of repo().byScope(sk)) {
        try {
          const raw = s.crypto.open(r.vecEnc, aad(r.factId));
          const dek = d.dekFor(scope, newGen);
          s.crypto.ensureDek(dek, d.ownerOf(scope), 'memory');
          repo().setSealed(r.factId, s.crypto.seal(dek, raw, aad(r.factId)), newGen);
        } catch {
          repo().delete([r.factId]);
        }
      }
      bump(sk);
    },
    invalidate(scope: Scope): void {
      bump(scopeKey(scope));
    },
  };
}
export type Vectors = ReturnType<typeof createVectors>;
