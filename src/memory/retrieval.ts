// memory/retrieval.ts (friend mode, spec 05 B3) — hybrid ranking of a scope's active facts for one query, pure and
// deterministic (no LLM, no randomness):
//   leg A (lexical): BM25-lite over the decrypted facts (store.ts bm25; no FTS5 table, the texts are encrypted at rest),
//                    every fact with a positive score, ranked by score;
//   leg B (semantic): cosine of the e5 'query:' vector against each fact's 'passage:' vector, only the facts within
//                    SEM_WINDOW of the best cosine (e5 cosines are compressed around 0.6–0.9, so the cut is RELATIVE to the
//                    best match, never an absolute threshold), at most SEM_TOP of them;
//   fusion: weighted reciprocal-rank fusion Σ w_leg / (k + rank_leg) with k = 60 (tied scores share a rank), then
//           × importance weight (0.5 + importance, so 0.5–1.5) × recency decay 0.5^(age / half-life) (30 days;
//           pinned and profile-kind facts do not decay).
// The semantic leg weighs 1 and the lexical leg 0.8 when both exist: a fact that only shares a keyword must not outrank
// the paraphrase the embedding found. Without vectors (model unavailable) the lexical leg alone decides, silently.
import type { Ms } from '../contracts/common.ts';
import type { FactKind } from '../contracts/memory.ts';

export const RRF_K = 60;
export const SEM_WINDOW = 0.1;
export const SEM_TOP = 20;
export const W_SEMANTIC = 1;
export const W_LEXICAL = 0.8;
const DAY = 86_400_000;

export interface RankInput {
  id: string;
  kind: FactKind;
  pinned: boolean;
  importance: number;
  /** the fact's last change (created, edited, re-activated) */
  updatedAt: Ms;
  /** BM25-lite raw score (0 = no keyword match) */
  bm: number;
  /** cosine to the query vector, or null when the fact has no vector (or the query was not embedded) */
  cos: number | null;
}

export interface Ranked { id: string; score: number; rrf: number; lexRank: number | null; semRank: number | null }

/** Competition ranking (1-based; equal values share the best rank) of the entries with a value, highest first. */
export function ranks(values: ReadonlyArray<number | null>, keep: (v: number) => boolean = () => true): Array<number | null> {
  const idx = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null && keep(x.v));
  idx.sort((a, b) => b.v - a.v);
  const out: Array<number | null> = values.map(() => null);
  let rank = 0;
  let prev: number | null = null;
  idx.forEach((x, n) => {
    if (prev === null || x.v !== prev) rank = n + 1;
    prev = x.v;
    out[x.i] = rank;
  });
  return out;
}

/** 0.5^(age / half-life); pinned and profile-kind facts never decay. */
export function decay(f: Pick<RankInput, 'kind' | 'pinned' | 'updatedAt'>, now: Ms, halfLifeDays: number): number {
  if (f.pinned || f.kind === 'profile') return 1;
  const ageDays = Math.max(0, now - f.updatedAt) / DAY;
  return 0.5 ** (ageDays / Math.max(1e-9, halfLifeDays));
}

export function importanceWeight(importance: number): number {
  const i = Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5;
  return 0.5 + i;
}

/**
 * Scores every fact (score 0 = matched neither leg); the caller sorts / filters. `semantic` false = lexical only.
 */
export function hybridRank(facts: readonly RankInput[], o: { now: Ms; halfLifeDays: number; k?: number }): Ranked[] {
  const k = o.k ?? RRF_K;
  const lex = ranks(facts.map((f) => (f.bm > 0 ? f.bm : null)));
  const cosVals = facts.map((f) => f.cos);
  const best = Math.max(-Infinity, ...cosVals.filter((c): c is number => c !== null));
  const inWindow = ranks(cosVals, (c) => Number.isFinite(best) && c >= best - SEM_WINDOW && c > 0);
  const sem = inWindow.map((r) => (r !== null && r <= SEM_TOP ? r : null));
  const semantic = sem.some((r) => r !== null);
  const wLex = semantic ? W_LEXICAL : 1;
  return facts.map((f, i) => {
    const lr = lex[i] ?? null;
    const sr = sem[i] ?? null;
    const rrf = (lr !== null ? wLex / (k + lr) : 0) + (sr !== null ? W_SEMANTIC / (k + sr) : 0);
    return { id: f.id, rrf, lexRank: lr, semRank: sr, score: rrf * importanceWeight(f.importance) * decay(f, o.now, o.halfLifeDays) };
  });
}
