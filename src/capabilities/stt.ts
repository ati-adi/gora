// capabilities/stt.ts (WP5) — speech-to-text selection (01 F3, 02 §A, 03 R4): Groq whisper (default; groq-sdk in
// capabilities/groq/stt.ts), an OpenAI-compatible multipart class (OpenAI gpt-transcribe) over the injected fetchImpl,
// 'fake' (tests/dev only: a deterministic placeholder), or 'none' (voice is politely refused).
import type { Clock, Logger, SpeechToText } from '../contracts/index.ts';
import { errorMessage, TransientLlmError } from '../kernel/errors.ts';
import { normalizeAudioFilename } from './groq/stt.ts';

export class SttUnavailableError extends Error {
  constructor() {
    super('speech-to-text is not configured');
    this.name = 'SttUnavailableError';
  }
}

export function createNoStt(): SpeechToText {
  return {
    name: 'none',
    async transcribe() {
      throw new SttUnavailableError();
    },
  };
}

/** Deterministic stand-in (NODE_ENV=test or STT_PROVIDER=fake in development; config refuses it with a real bot token). */
export function createPlaceholderStt(): SpeechToText {
  return {
    name: 'fake',
    async transcribe(audio) {
      const durationSec = Math.max(1, Math.round(audio.byteLength / 2000));
      return { text: '(voice message)', durationSec, noSpeech: false };
    },
  };
}

/** OpenAI-compatible transcription endpoint (multipart; same shape as Groq's). */
export function createOpenAiStt(o: { apiKey: string; model: string; fetchImpl: typeof fetch; clock: Clock; log: Logger; baseUrl?: string; timeoutMs?: number }): SpeechToText {
  return {
    name: `openai:${o.model}`,
    async transcribe(audio, t) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: t.mime }), normalizeAudioFilename(t.filename, t.mime));
      form.append('model', o.model);
      form.append('response_format', o.model.startsWith('whisper') ? 'verbose_json' : 'json');
      if (t.language) form.append('language', t.language);
      const ac = new AbortController();
      const timer = o.clock.setTimeout(() => ac.abort(), o.timeoutMs ?? 60_000);
      const onAbort = () => ac.abort();
      t.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await o.fetchImpl(`${o.baseUrl ?? 'https://api.openai.com/v1'}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${o.apiKey}` }, body: form, signal: ac.signal });
        if (res.status === 429) throw new TransientLlmError('rate_limit');
        if (res.status >= 500) throw new TransientLlmError('server');
        if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status}`);
        const j = (await res.json()) as { text?: string; language?: string; duration?: number; segments?: Array<{ no_speech_prob?: number }> };
        const segs = j.segments ?? [];
        return { text: (j.text ?? '').trim(), ...(j.language && j.language.length === 2 ? { language: j.language } : {}), ...(typeof j.duration === 'number' ? { durationSec: j.duration } : {}), noSpeech: segs.length > 0 && segs.every((s) => (s.no_speech_prob ?? 0) > 0.8) };
      } catch (e) {
        o.log.warn({ provider: 'openai', err: errorMessage(e) }, 'stt failed');
        throw e;
      } finally {
        o.clock.clearTimeout(timer);
        t.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
