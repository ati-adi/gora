// kernel/random.ts (friend foundation, spec 05 §E) — the injectable Random and the samplers the proactive bandit needs.
// src/ never calls Math.random (importRules 'no-math-random'): production uses systemRandom() (node:crypto), tests use
// seededRandom(seed) (deterministic). Samplers take a Random, so a seeded test reproduces every Thompson draw.
import { randomBytes } from 'node:crypto';
import type { Random } from '../contracts/common.ts';

/** Cryptographic uniform randomness (buffered 64 KiB at a time). */
export function systemRandom(): Random {
  let buf = randomBytes(0);
  let off = 0;
  const u32 = (): number => {
    if (off + 4 > buf.length) {
      buf = randomBytes(65_536);
      off = 0;
    }
    const v = buf.readUInt32LE(off);
    off += 4;
    return v;
  };
  // 53 random bits → [0, 1)
  const next = () => ((u32() >>> 5) * 67_108_864 + (u32() >>> 6)) / 9_007_199_254_740_992;
  return { next, int: (n) => intFrom(next, n) };
}

/** Deterministic PRNG (sfc32 seeded through splitmix32) for tests and simulations. Same seed → same sequence. */
export function seededRandom(seed: number): Random {
  let s = seed >>> 0;
  const split = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split();
  let b = split();
  let c = split();
  let d = split();
  const u32 = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 12; i++) u32();
  const next = () => u32() / 4_294_967_296;
  return { next, int: (n) => intFrom(next, n) };
}

function intFrom(next: () => number, n: number): number {
  if (!Number.isFinite(n) || n < 1) throw new RangeError('Random.int: maxExclusive must be ≥ 1');
  return Math.floor(next() * Math.floor(n));
}

/** Standard normal (Box–Muller; one value per call). */
export function sampleNormal(r: Random): number {
  let u = 0;
  while (u <= Number.EPSILON) u = r.next();
  const v = r.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) by Marsaglia–Tsang (shape < 1 boosted with U^(1/shape)). */
export function sampleGamma(r: Random, shape: number): number {
  if (!(shape > 0)) throw new RangeError('sampleGamma: shape must be > 0');
  if (shape < 1) {
    let u = 0;
    while (u <= Number.EPSILON) u = r.next();
    return sampleGamma(r, shape + 1) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = sampleNormal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r.next();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(α, β) via two gammas (Thompson sampling of the proactive arms, spec 05 C4). */
export function sampleBeta(r: Random, alpha: number, beta: number): number {
  const x = sampleGamma(r, alpha);
  const y = sampleGamma(r, beta);
  return x + y > 0 ? x / (x + y) : 0.5;
}

/** Uniform jitter in [-maxMs, +maxMs] (spec 05 C4: ±20 min at send time). */
export function jitterMs(r: Random, maxMs: number): number {
  return Math.round((r.next() * 2 - 1) * maxMs);
}
