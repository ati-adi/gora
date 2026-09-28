// WP5 — oggopus (03 R4, port of docs/reference/oggopus.ts): WAV → OGG/Opus pages that parse, with valid CRCs, BOS/EOS
// flags, OpusHead/OpusTags and a final granule matching the duration.
import { describe, expect, it } from 'vitest';
import { concatWavs, makeWav, oggCrc32, parseWav, wavToOggOpus } from '../../../src/capabilities/oggopus.ts';

function pages(ogg: Uint8Array) {
  const b = Buffer.from(ogg);
  const out: Array<{ flags: number; granule: bigint; seq: number; body: Buffer; crcOk: boolean }> = [];
  let off = 0;
  while (off < b.length) {
    expect(b.toString('ascii', off, off + 4)).toBe('OggS');
    const nseg = b[off + 26]!;
    const lacing = b.subarray(off + 27, off + 27 + nseg);
    const bodyLen = lacing.reduce((a, x) => a + x, 0);
    const len = 27 + nseg + bodyLen;
    const page = Buffer.from(b.subarray(off, off + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    out.push({ flags: b[off + 5]!, granule: b.readBigInt64LE(off + 6), seq: b.readUInt32LE(off + 18), body: b.subarray(off + 27 + nseg, off + len), crcOk: oggCrc32(page) === crc });
    off += len;
  }
  return out;
}

const tone = (rate: number, channels: number, sec: number) => {
  const n = Math.round(rate * sec) * channels;
  return makeWav({ rate, channels, samples: new Int16Array(n).map((_, i) => Math.round(Math.sin(i / 7) * 6000)) });
};

describe('oggopus', () => {
  it('encodes 24 kHz mono WAV into valid OGG/Opus pages', () => {
    const { ogg, durationSec } = wavToOggOpus(tone(24000, 1, 2.5));
    expect(durationSec).toBeCloseTo(2.5, 3);
    const ps = pages(ogg);
    expect(ps.every((p) => p.crcOk)).toBe(true);
    expect(ps[0]!.flags).toBe(0x02);
    expect(ps[0]!.body.toString('ascii', 0, 8)).toBe('OpusHead');
    expect(ps[1]!.body.toString('ascii', 0, 8)).toBe('OpusTags');
    expect(ps.at(-1)!.flags & 0x04).toBe(0x04);
    expect(ps.map((p) => p.seq)).toEqual(ps.map((_, i) => i));
    expect(Number(ps.at(-1)!.granule)).toBe(312 + 2.5 * 48000);
  });

  it('resamples 22.05 kHz stereo to 48 kHz and joins several WAVs (TTS pieces)', () => {
    const { durationSec } = wavToOggOpus(tone(22050, 2, 1));
    expect(durationSec).toBeCloseTo(1, 2);
    const joined = concatWavs([tone(24000, 1, 1), tone(24000, 1, 0.5)]);
    expect(joined.samples.length).toBe(36000);
    expect(parseWav(tone(16000, 1, 0.1)).rate).toBe(16000);
    expect(() => parseWav(new TextEncoder().encode('not a wav at all'))).toThrow(/WAV/);
  });
});
