// capabilities/groq/stt.ts (WP5) — Groq Whisper (01 F3, 03 R4): groq-sdk audio.transcriptions.create with toFile and the
// per-kind filename (Groq validates by extension: '.oga' is rejected, so it is renamed '.ogg'), response_format
// verbose_json, noSpeech when every segment has no_speech_prob > 0.8.
import { toFile } from 'groq-sdk';
import type { SpeechToText } from '../../contracts/index.ts';
import { STT_USD_PER_HOUR, type GroqCaller } from './common.ts';

interface Verbose { text?: string; language?: string; duration?: number; segments?: Array<{ no_speech_prob?: number }> }

/** Whisper reports full language names in verbose_json; map the common ones to ISO-639-1. */
const LANG: Record<string, string> = { english: 'en', russian: 'ru', kazakh: 'kk', ukrainian: 'uk', german: 'de', french: 'fr', spanish: 'es', turkish: 'tr', uzbek: 'uz', italian: 'it', chinese: 'zh', arabic: 'ar' };

export function normalizeAudioFilename(filename: string, mime: string): string {
  const f = filename.toLowerCase();
  if (f.endsWith('.oga') || (!/\.[a-z0-9]{2,4}$/.test(f) && mime === 'audio/ogg')) return 'voice.ogg';
  return filename;
}

export function isNoSpeech(v: Verbose): boolean {
  const segs = v.segments ?? [];
  return segs.length > 0 && segs.every((s) => (s.no_speech_prob ?? 0) > 0.8);
}

export function createGroqStt(caller: GroqCaller, model: () => string): SpeechToText {
  return {
    get name() {
      return `groq:${model()}`;
    },
    async transcribe(audio, o) {
      const filename = normalizeAudioFilename(o.filename, o.mime);
      const v = await caller.run<Verbose>({
        role: 'stt', model: model(), purpose: 'stt', estTokens: 1, priority: o.priority ?? 'interactive', ...(o.meta ? { meta: o.meta } : {}), ...(o.signal ? { signal: o.signal } : {}),
        call: async (c, served) =>
          (await c.audio.transcriptions
            .create({ file: await toFile(Buffer.from(audio), filename, { type: o.mime }), model: served, response_format: 'verbose_json', temperature: 0, ...(o.language ? { language: o.language } : {}) } as never, o.signal ? { signal: o.signal } : undefined)
            .withResponse()) as unknown as { data: Verbose; response: Response },
        usage: (d) => ({ costMicros: Math.round((Math.max(10, d.duration ?? 10) / 3600) * STT_USD_PER_HOUR * 1e6) }),
      });
      const lang = v.language ? (LANG[v.language.toLowerCase()] ?? (v.language.length === 2 ? v.language.toLowerCase() : undefined)) : undefined;
      return { text: (v.text ?? '').trim(), ...(lang ? { language: lang } : {}), ...(typeof v.duration === 'number' ? { durationSec: v.duration } : {}), noSpeech: isNoSpeech(v) };
    },
  };
}
