// capabilities/oggopus.ts (WP5) — 03 R4: a port of docs/reference/oggopus.ts. Pure-JS/WASM WAV (PCM16) → OGG/Opus
// for Telegram sendVoice (opusscript = libopus 1.4 as WASM; no ffmpeg). Also joins several WAVs (TTS pieces) into one PCM.
import { randomInt } from 'node:crypto';
import OpusScript from 'opusscript';

export interface Pcm { rate: number; channels: number; samples: Int16Array }

export function parseWav(buf: Uint8Array): Pcm {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let fmt = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    let size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = b.readUInt16LE(body);
      channels = b.readUInt16LE(body + 2);
      rate = b.readUInt32LE(body + 4);
      bits = b.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (size === 0xffffffff || body + size > b.length) size = b.length - body; // streamed WAV
      if (!(fmt === 1 || fmt === 0xfffe) || bits !== 16) throw new Error(`unsupported WAV fmt=${fmt} bits=${bits}`);
      if (!rate || !channels) throw new Error('WAV without a fmt chunk');
      const bytes = b.subarray(body, body + (size & ~1));
      const samples = new Int16Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      return { rate, channels, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/** A PCM16 WAV file (tests and fixtures). */
export function makeWav(p: Pcm): Uint8Array {
  const data = p.samples.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(p.channels, 22);
  b.writeUInt32LE(p.rate, 24);
  b.writeUInt32LE(p.rate * p.channels * 2, 28);
  b.writeUInt16LE(p.channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < p.samples.length; i++) b.writeInt16LE(p.samples[i]!, 44 + i * 2);
  return new Uint8Array(b);
}

const OPUS_RATES = [8000, 12000, 16000, 24000, 48000] as const;
type OpusRate = (typeof OPUS_RATES)[number];

export function toMono(p: Pcm): Int16Array {
  if (p.channels === 1) return p.samples;
  const out = new Int16Array(Math.floor(p.samples.length / p.channels));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let c = 0; c < p.channels; c++) s += p.samples[i * p.channels + c]!;
    out[i] = s / p.channels;
  }
  return out;
}

export function resampleLinear(x: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Int16Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const t = i * r;
    const i0 = Math.floor(t);
    const f = t - i0;
    out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? x[i0] ?? 0) * f;
  }
  return out;
}

/** Joins several WAVs into one mono PCM at the first piece's rate (later pieces are resampled if needed). */
export function concatWavs(wavs: readonly Uint8Array[]): Pcm {
  if (!wavs.length) throw new Error('no audio');
  const parts = wavs.map(parseWav);
  const rate = parts[0]!.rate;
  const monos = parts.map((p) => resampleLinear(toMono(p), p.rate, rate));
  const total = monos.reduce((a, m) => a + m.length, 0);
  const samples = new Int16Array(total);
  let off = 0;
  for (const m of monos) {
    samples.set(m, off);
    off += m.length;
  }
  return { rate, channels: 1, samples };
}

// Ogg CRC32: poly 0x04C11DB7, no reflection, init 0.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
export function oggCrc32(b: Uint8Array): number {
  let c = 0;
  for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]!) >>> 0;
  return c;
}

function oggPage(packets: Buffer[], granule: bigint, serial: number, seq: number, flags: number): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let l = p.length;
    while (l >= 255) {
      lacing.push(255);
      l -= 255;
    }
    lacing.push(l);
  }
  if (lacing.length > 255) throw new Error('too many segments');
  const h = Buffer.alloc(27 + lacing.length);
  h.write('OggS', 0, 'ascii');
  h[4] = 0;
  h[5] = flags;
  h.writeBigInt64LE(granule, 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h.writeUInt32LE(0, 22);
  h[26] = lacing.length;
  lacing.forEach((v, i) => (h[27 + i] = v));
  const page = Buffer.concat([h, ...packets]);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

/** Mono/stereo PCM16 → OGG/Opus (mono, 20 ms frames, VOIP). */
export function pcmToOggOpus(pcm: Pcm, bitrate = 32000): { ogg: Uint8Array; durationSec: number } {
  let mono = toMono(pcm);
  let rate = pcm.rate;
  if (!(OPUS_RATES as readonly number[]).includes(rate)) {
    mono = resampleLinear(mono, rate, 48000);
    rate = 48000;
  }
  const enc = new OpusScript(rate as OpusRate, 1, OpusScript.Application.VOIP);
  try {
    enc.setBitrate(bitrate);
    const frame = rate / 50; // 20 ms
    const scale = 48000 / rate; // granule is always in 48 kHz units
    const preSkip = 312; // libopus default lookahead at 48k (6.5 ms)
    const serial = randomInt(0, 0xffffffff);
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head[8] = 1;
    head[9] = 1;
    head.writeUInt16LE(preSkip, 10);
    head.writeUInt32LE(pcm.rate, 12);
    head.writeInt16LE(0, 16);
    head[18] = 0;
    const vendor = Buffer.from('gora');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    const pages: Buffer[] = [oggPage([head], 0n, serial, 0, 0x02), oggPage([tags], 0n, serial, 1, 0)];
    let seq = 2;
    let granule = BigInt(preSkip);
    let batch: Buffer[] = [];
    let segs = 0;
    const total = Math.max(1, Math.ceil(mono.length / frame));
    for (let i = 0; i < total; i++) {
      const chunk = new Int16Array(frame);
      chunk.set(mono.subarray(i * frame, (i + 1) * frame));
      const pkt = Buffer.from(enc.encode(Buffer.from(chunk.buffer), frame));
      const need = Math.floor(pkt.length / 255) + 1;
      if (segs + need > 255 || batch.length >= 50) {
        pages.push(oggPage(batch, granule, serial, seq++, 0));
        batch = [];
        segs = 0;
      }
      batch.push(pkt);
      segs += need;
      granule = BigInt(preSkip) + BigInt(Math.round(Math.min((i + 1) * frame, mono.length) * scale));
    }
    pages.push(oggPage(batch, granule, serial, seq++, 0x04));
    return { ogg: new Uint8Array(Buffer.concat(pages)), durationSec: mono.length / rate };
  } finally {
    enc.delete();
  }
}

export function wavToOggOpus(wav: Uint8Array, bitrate = 32000): { ogg: Uint8Array; durationSec: number } {
  return pcmToOggOpus(parseWav(wav), bitrate);
}
