// WP5 — STT (01 F3, 03 R4): per-kind names, groq-sdk toFile upload (never a URL field), verbose_json, noSpeech.
import { describe, expect, it } from 'vitest';
import { createCapabilities } from '../../../src/capabilities/index.ts';
import { createGroqCaller } from '../../../src/capabilities/groq/common.ts';
import { createGroqStt, isNoSpeech, normalizeAudioFilename } from '../../../src/capabilities/groq/stt.ts';
import { audioUploadName } from '../../../src/capabilities/media.ts';
import { createNoStt, createOpenAiStt } from '../../../src/capabilities/stt.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { capEnv, fakeGroq } from './env.ts';

describe('speech to text', () => {
  it('per-kind upload names and MIME types (01 F3 table)', () => {
    expect(audioUploadName('voice', 'audio/ogg', 'file_1.oga')).toEqual({ filename: 'voice.ogg', mime: 'audio/ogg' });
    expect(audioUploadName('audio', 'audio/mpeg', 'song.mp3')).toEqual({ filename: 'audio.mp3', mime: 'audio/mpeg' });
    expect(audioUploadName('audio', 'audio/mp4', 'memo.m4a')).toEqual({ filename: 'audio.m4a', mime: 'audio/mp4' });
    expect(audioUploadName('audio', 'audio/ogg', 'x.ogg')).toEqual({ filename: 'audio.ogg', mime: 'audio/ogg' });
    expect(audioUploadName('video_note', undefined, undefined)).toEqual({ filename: 'video.mp4', mime: 'video/mp4' });
    expect(normalizeAudioFilename('file_7.oga', 'audio/ogg')).toBe('voice.ogg');
  });

  it('Groq whisper: toFile upload named voice.ogg, verbose_json, language mapped, cost recorded, no URL field', async () => {
    const g = fakeGroq(() => ({ text: ' Привет, напомни завтра ', language: 'russian', duration: 14.2, segments: [{ no_speech_prob: 0.01 }] }));
    const env = capEnv({ groq: g.client });
    const stt = createGroqStt(createGroqCaller(env.s), () => 'whisper-large-v3-turbo');
    const r = await stt.transcribe(new Uint8Array([1, 2, 3]), { filename: 'file_3.oga', mime: 'audio/ogg', meta: { userId: 'u1' } });
    expect(r).toEqual({ text: 'Привет, напомни завтра', language: 'ru', durationSec: 14.2, noSpeech: false });
    const body = g.calls[0]!.body;
    expect(body['response_format']).toBe('verbose_json');
    expect(body['model']).toBe('whisper-large-v3-turbo');
    expect('url' in body).toBe(false);
    expect((body['file'] as File).name).toBe('voice.ogg');
    expect((body['file'] as File).type).toBe('audio/ogg');
    expect(env.acquired[0]).toMatchObject({ role: 'stt', priority: 'interactive' });
    expect(env.llmCalls[0]).toMatchObject({ purpose: 'stt', userId: 'u1' });
    expect(env.llmCalls[0]!.costMicros).toBeGreaterThan(0);
  });

  it('noSpeech when every segment has no_speech_prob > 0.8', () => {
    expect(isNoSpeech({ segments: [{ no_speech_prob: 0.95 }, { no_speech_prob: 0.81 }] })).toBe(true);
    expect(isNoSpeech({ segments: [{ no_speech_prob: 0.95 }, { no_speech_prob: 0.2 }] })).toBe(false);
    expect(isNoSpeech({ segments: [] })).toBe(false);
  });

  it('OpenAI-compatible class posts multipart through the injected fetch; none refuses', async () => {
    let seen: { url: string; form: FormData } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, form: init.body as FormData };
      return new Response(JSON.stringify({ text: 'hello', language: 'en', duration: 3 }), { status: 200 });
    }) as unknown as typeof fetch;
    const stt = createOpenAiStt({ apiKey: 'k', model: 'gpt-transcribe', fetchImpl, clock: new FakeClock(), log: nullLogger });
    expect(await stt.transcribe(new Uint8Array([1]), { filename: 'voice.ogg', mime: 'audio/ogg' })).toMatchObject({ text: 'hello', language: 'en' });
    expect(seen!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((seen!.form.get('file') as File).name).toBe('voice.ogg');
    await expect(createNoStt().transcribe(new Uint8Array([1]), { filename: 'voice.ogg', mime: 'audio/ogg' })).rejects.toThrow(/not configured/);
  });

  it('createCapabilities picks the configured STT (fake under NODE_ENV=test)', () => {
    const env = capEnv();
    (env.s as unknown as { privacyHooks: unknown[] }).privacyHooks = [];
    const caps = createCapabilities(env.s.config, (async () => new Response('')) as unknown as typeof fetch, env.s);
    expect(caps.stt.name).toBe('fake');
  });
});
