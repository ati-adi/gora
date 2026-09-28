// trust/guard.ts (WP4) — 03 R5 PromptGuard over untrusted text (defense in depth; can only make things stricter).
// Chunking: LIMITS.guardChunkChars (1 500) with LIMITS.guardChunkOverlap (200); the first LIMITS.guardMaxChunks (6) are
// scanned; the rest are scanned only when those were clean and there are at most 2× that many chunks, otherwise the
// remainder is left unscanned (the wrapper then marks the block suspicious). Scores are cached per chunk in kv
// under 'guard:<sha256>' (reserved key, 04 §8). A null score means the guard is unavailable: the text passes.
import { createHash } from 'node:crypto';
import type { GuardCapability, KvRepo, Logger, Priority, UserId } from '../contracts/index.ts';

export const GUARD_BLOCK_AT = 0.9;
export const GUARD_SUSPICIOUS_AT = 0.5;
export const REMOVED_MARKER = '[removed: likely prompt injection]';

export interface GuardLimits { chunkChars: number; overlap: number; maxChunks: number }
export interface GuardOutcome {
  text: string;
  /** Any chunk ≥ 0.5, or part of the text left unscanned. */
  suspicious: boolean;
  removedChunks: number;
  unscanned: boolean;
  maxScore: number | null;
}

export function chunkRanges(len: number, chunkChars: number, overlap: number): Array<[number, number]> {
  if (len <= 0) return [];
  const step = Math.max(1, chunkChars - overlap);
  const out: Array<[number, number]> = [];
  for (let start = 0; ; start += step) {
    const end = Math.min(len, start + chunkChars);
    out.push([start, end]);
    if (end >= len) break;
  }
  return out;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface GuardDeps { guard: GuardCapability | undefined; kv: KvRepo | undefined; log: Logger; limits: GuardLimits }

async function scoreChunk(d: GuardDeps, chunk: string, o: { priority?: Priority; userId?: UserId | null; runId?: string | null }): Promise<number | null> {
  const key = `guard:${sha256(chunk)}`;
  try {
    const cached = d.kv?.get<number>(key);
    if (typeof cached === 'number') return cached;
  } catch {
    /* kv unavailable: score live */
  }
  let score: number | null;
  try {
    score = d.guard ? await d.guard.score(chunk, { ...(o.priority ? { priority: o.priority } : {}), userId: o.userId ?? null, runId: o.runId ?? null }) : null;
  } catch (e) {
    d.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'guard: score failed; passing through');
    return null;
  }
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  try {
    d.kv?.set(key, score);
  } catch {
    /* cache is best-effort */
  }
  return score;
}

/** Scores `text` chunk by chunk and replaces every chunk scoring ≥ 0.9 with REMOVED_MARKER (overlaps merged). */
export async function guardText(d: GuardDeps, text: string, o: { priority?: Priority; userId?: UserId | null; runId?: string | null } = {}): Promise<GuardOutcome> {
  const ranges = chunkRanges(text.length, d.limits.chunkChars, d.limits.overlap);
  if (ranges.length === 0 || !d.guard) return { text, suspicious: false, removedChunks: 0, unscanned: false, maxScore: null };
  const scores: Array<number | null | undefined> = new Array(ranges.length).fill(undefined);
  const head = Math.min(ranges.length, d.limits.maxChunks);
  let unavailable = false;
  for (let i = 0; i < head; i++) {
    const s = await scoreChunk(d, text.slice(ranges[i]![0], ranges[i]![1]), o);
    scores[i] = s;
    if (s === null) {
      unavailable = true;
      break; // the guard is down: stop spending calls, the text passes (03 R5)
    }
  }
  let unscanned = false;
  if (!unavailable && ranges.length > head) {
    const headClean = scores.slice(0, head).every((s) => typeof s === 'number' && s < GUARD_SUSPICIOUS_AT);
    if (headClean && ranges.length <= d.limits.maxChunks * 2) {
      for (let i = head; i < ranges.length; i++) {
        const s = await scoreChunk(d, text.slice(ranges[i]![0], ranges[i]![1]), o);
        scores[i] = s;
        if (s === null) break;
      }
    } else {
      unscanned = true;
    }
  }
  const numeric = scores.filter((s): s is number => typeof s === 'number');
  const maxScore = numeric.length ? Math.max(...numeric) : null;
  const blocked: Array<[number, number]> = [];
  scores.forEach((s, i) => {
    if (typeof s === 'number' && s >= GUARD_BLOCK_AT) blocked.push(ranges[i]!);
  });
  let out = text;
  if (blocked.length) {
    const merged: Array<[number, number]> = [];
    for (const r of blocked) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    out = '';
    let pos = 0;
    for (const [a, b] of merged) {
      out += text.slice(pos, a) + REMOVED_MARKER;
      pos = b;
    }
    out += text.slice(pos);
  }
  const suspicious = (maxScore !== null && maxScore >= GUARD_SUSPICIOUS_AT) || unscanned;
  return { text: out, suspicious, removedChunks: blocked.length, unscanned, maxScore };
}
