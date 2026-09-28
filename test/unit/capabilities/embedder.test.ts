// Spec 05 B2: the local embedder (capabilities/embedder.ts) without the real model — @huggingface/transformers is mocked,
// so no download and no ONNX session: e5 prefixes, batching, one inference at a time, dimension check, lazy load, a
// failed load resolving null (lexical fallback) and retried after an hour.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalEmbedder } from '../../../src/capabilities/embedder.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';

const h = vi.hoisted(() => ({
  fail: 0,
  dim: 4,
  loads: 0,
  batches: [] as string[][],
  active: 0,
  maxActive: 0,
  env: { cacheDir: '', allowLocalModels: true } as { cacheDir: string; allowLocalModels: boolean },
}));

vi.mock('@huggingface/transformers', () => ({
  env: h.env,
  async pipeline(task: string, model: string, opts: { dtype: string; device: string }) {
    h.loads++;
    if (h.fail > 0) {
      h.fail--;
      throw new Error('download failed');
    }
    expect([task, model, opts]).toEqual(['feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8', device: 'cpu' }]);
    return async (texts: string[]) => {
      h.batches.push(texts);
      h.active++;
      h.maxActive = Math.max(h.maxActive, h.active);
      await new Promise((r) => setImmediate(r));
      h.active--;
      const d = h.dim;
      const data = new Float32Array(texts.length * d);
      texts.forEach((t, i) => (data[i * d + (t.length % d)] = 1));
      return { dims: [texts.length, d], data };
    };
  },
}));

const mk = (clock = new FakeClock()) => ({ clock, e: createLocalEmbedder({ model: 'Xenova/multilingual-e5-small', cacheDir: '/tmp/gora-test-models', clock, log: createMemoryLogger(), dim: 4 }) });

beforeEach(() => {
  Object.assign(h, { fail: 0, dim: 4, loads: 0, batches: [], active: 0, maxActive: 0 });
});

describe('createLocalEmbedder (mocked transformers)', () => {
  it('is lazy, uses the e5 prefixes and the cache dir, batches by 32, and runs one inference at a time', async () => {
    const { e } = mk();
    expect(e.status()).toBe('idle');
    expect(h.loads).toBe(0);
    expect(e.model).toBe('Xenova/multilingual-e5-small@q8');
    const texts = Array.from({ length: 40 }, (_, i) => `fact ${i}`);
    const [a, b] = await Promise.all([e.embed(texts, 'passage'), e.embed(['where does my sister live?'], 'query')]);
    expect(h.loads).toBe(1);
    expect(e.status()).toBe('ready');
    expect(h.env).toEqual({ cacheDir: '/tmp/gora-test-models', allowLocalModels: false });
    expect(h.batches.map((x) => x.length)).toEqual([32, 8, 1]);
    expect(h.batches[0]![0]).toBe('passage: fact 0');
    expect(h.batches[2]).toEqual(['query: where does my sister live?']);
    expect(h.maxActive).toBe(1);
    expect(a).toHaveLength(40);
    expect(b![0]).toHaveLength(4);
    expect(await e.embed([], 'query')).toEqual([]);
  });

  it('a failed load resolves null (never throws), stays unavailable for an hour, then retries', async () => {
    h.fail = 1;
    const { e, clock } = mk();
    expect(await e.embed(['x'], 'query')).toBeNull();
    expect(e.status()).toBe('unavailable');
    expect(await e.embed(['x'], 'query')).toBeNull();
    expect(h.loads).toBe(1);
    await clock.advance(61 * 60_000);
    expect(await e.embed(['x'], 'query')).toHaveLength(1);
    expect(h.loads).toBe(2);
    expect(e.status()).toBe('ready');
  });

  it('a dimension mismatch returns null instead of storing wrong vectors', async () => {
    h.dim = 6;
    const { e } = mk();
    expect(await e.embed(['x'], 'passage')).toBeNull();
  });
});
