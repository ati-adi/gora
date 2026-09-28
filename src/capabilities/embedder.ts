// capabilities/embedder.ts (friend foundation, spec 05 B2; ownership → the memory-engine builder "M") — the Embedder
// capability. 'local': Xenova/multilingual-e5-small (384-d, q8 ONNX, CPU) through @huggingface/transformers, loaded
// lazily on first use and cached under config.embeddings.cacheDir (DATA_DIR/models). Verified on Node 26.8 darwin-arm64:
// cold load incl. download ≈ 74 s (144 MB), warm load ≈ 0.3 s, 2–7 ms per sentence, RSS ≈ 650 MB (docs/spec/06).
// 'fake': deterministic hashed bag-of-words vectors (no model; tests and demo). 'none': always unavailable.
// Availability is never an error: embed() resolves null and retrieval degrades to lexical only.
// The ONLY runtime importer of @huggingface/transformers (importRules 'transformers-runtime-import').
import { createHash } from 'node:crypto';
import type { Clock, Embedder, Logger } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';

export const E5_DIM = 384;
const BATCH = 32;
const RETRY_AFTER_MS = 60 * 60_000;
const MAX_CHARS = 2_000; // e5-small reads 512 tokens; longer facts are cut before tokenization

export interface LocalEmbedderOptions { model: string; cacheDir: string; clock: Clock; log: Logger; dim?: number }

interface Extractor {
  (texts: string[], o: { pooling: 'mean'; normalize: boolean }): Promise<{ dims: number[]; data: Float32Array | ArrayLike<number> }>;
}

/** The real local embedder (lazy). Never throws from embed(); a failed load is retried after an hour. */
export function createLocalEmbedder(o: LocalEmbedderOptions): Embedder {
  const dim = o.dim ?? E5_DIM;
  let state: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
  let loading: Promise<Extractor | null> | null = null;
  let failedAt: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const log = { info: (x: object, m: string) => o.log.info({ sub: 'embedder', ...x }, m), warn: (x: object, m: string) => o.log.warn({ sub: 'embedder', ...x }, m) };

  const load = (): Promise<Extractor | null> => {
    if (state === 'unavailable' && failedAt !== null && o.clock.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
    if (loading) return loading;
    state = 'loading';
    const started = o.clock.now();
    loading = (async () => {
      try {
        const tf = (await import('@huggingface/transformers')) as unknown as {
          env: { cacheDir: string; allowLocalModels: boolean };
          pipeline(task: 'feature-extraction', model: string, opts: { dtype: 'q8'; device: 'cpu' }): Promise<Extractor>;
        };
        tf.env.cacheDir = o.cacheDir;
        tf.env.allowLocalModels = false;
        const ex = await tf.pipeline('feature-extraction', o.model, { dtype: 'q8', device: 'cpu' });
        state = 'ready';
        log.info({ model: o.model, ms: o.clock.now() - started }, 'embedding model ready');
        return ex;
      } catch (e) {
        state = 'unavailable';
        failedAt = o.clock.now();
        loading = null;
        log.warn({ model: o.model, err: errorMessage(e) }, 'embedding model unavailable; retrieval degrades to lexical only');
        return null;
      }
    })();
    return loading;
  };

  const run = async (texts: readonly string[], kind: 'query' | 'passage', signal?: AbortSignal): Promise<Float32Array[] | null> => {
    const ex = await load();
    if (!ex) return null;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) return null;
      const batch = texts.slice(i, i + BATCH).map((t) => `${kind}: ${t.slice(0, MAX_CHARS)}`);
      const t = await ex(batch, { pooling: 'mean', normalize: true });
      const d = t.dims[t.dims.length - 1] ?? 0;
      if (d !== dim) {
        log.warn({ got: d, want: dim }, 'embedding dimension mismatch');
        return null;
      }
      const flat = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
      for (let k = 0; k < batch.length; k++) out.push(flat.slice(k * dim, (k + 1) * dim));
    }
    return out;
  };

  return {
    model: `${o.model}@q8`,
    dim,
    status: () => state,
    embed(texts, kind, opts) {
      if (!texts.length) return Promise.resolve([]);
      // one inference at a time (the ONNX session is shared); a failure in one call never poisons the queue
      const p = queue.then(() => run(texts, kind, opts?.signal)).catch((e: unknown) => {
        log.warn({ err: errorMessage(e) }, 'embedding failed');
        return null;
      });
      queue = p;
      return p;
    },
  };
}

/**
 * Deterministic hashed bag-of-words embedder: each lower-cased word (and its 6-char prefix, a crude stem shared with
 * memory/text.ts) adds ±1 to a hashed dimension; the vector is L2-normalized. Same words → high cosine; no semantics.
 */
export function createHashEmbedder(dim = 64): Embedder {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    for (const w of text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      for (const tok of new Set([w, w.slice(0, 6)])) {
        const h = createHash('sha256').update(tok).digest();
        v[h.readUInt32LE(0) % dim]! += h[4]! & 1 ? 1 : -1;
      }
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n);
    if (n > 0) for (let i = 0; i < dim; i++) v[i]! /= n;
    return v;
  };
  return { model: `hash-${dim}`, dim, status: () => 'ready', embed: async (texts) => texts.map(vec) };
}

/** EMBEDDINGS_PROVIDER=none. */
export function createNoEmbedder(): Embedder {
  return { model: 'none', dim: 0, status: () => 'unavailable', embed: async () => null };
}

/** Cosine of two L2-normalized vectors (= dot product); 0 on a length mismatch. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Float32Array ↔ bytes (little-endian, as stored sealed in fact_embeddings.vec_enc). */
export function vecToBytes(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i]!, true);
  return out;
}
export function bytesToVec(b: Uint8Array): Float32Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(Math.floor(b.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}
