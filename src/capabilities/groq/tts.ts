// capabilities/groq/tts.ts (WP5) — Orpheus TTS (03 R4): GROQ_MODEL_TTS, voice GROQ_TTS_VOICE, WAV only, ≤ 200 chars per
// request split at sentence boundaries, sequential calls, PCM concatenated, then encoded once to OGG/Opus.
import type { TtsCapability } from '../../contracts/index.ts';
import { concatWavs, pcmToOggOpus } from '../oggopus.ts';
import { TTS_USD_PER_MCHAR, type GroqCaller } from './common.ts';

export const TTS_PIECE_CHARS = 200;

/** Splits text into pieces ≤ max chars at sentence boundaries (then commas/spaces for long sentences). */
export function splitForTts(text: string, max = TTS_PIECE_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…。])\s+/);
  const units: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) {
      units.push(s);
      continue;
    }
    let rest = s;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
      if (cut < max / 3) cut = window.lastIndexOf(' ');
      if (cut < max / 3) cut = max - 1;
      units.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) units.push(rest);
  }
  const out: string[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + 1 + u.length <= max) out[out.length - 1] = `${last} ${u}`;
    else out.push(u);
  }
  return out;
}

export function createGroqTts(caller: GroqCaller, cfg: () => { model: string; voice: string; maxChars: number }): TtsCapability {
  return {
    async speak(text, o = {}) {
      const c = cfg();
      const pieces = splitForTts(text.slice(0, c.maxChars));
      if (!pieces.length) throw new Error('nothing to speak');
      const wavs: Uint8Array[] = [];
      for (const piece of pieces) {
        const res = await caller.run<Response>({
          role: 'tts', model: c.model, purpose: 'tts', estTokens: piece.length, priority: o.priority ?? 'background', ...(o.meta ? { meta: o.meta } : {}),
          call: (client, served) => client.audio.speech.create({ model: served, voice: o.voice ?? c.voice, input: piece, response_format: 'wav' } as never).withResponse(),
          usage: () => ({ costMicros: Math.round(piece.length * TTS_USD_PER_MCHAR) }),
        });
        wavs.push(new Uint8Array(await res.arrayBuffer()));
      }
      return pcmToOggOpus(concatWavs(wavs));
    },
  };
}
