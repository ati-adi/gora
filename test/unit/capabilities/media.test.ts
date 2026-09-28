// WP5 — media ingestion (01 F3; 03 R4): voice/audio/video_note → STT text; >20 MB refused; photo → @blob image block;
// PDF ≤ 10 MB → base64 document block (Anthropic) or extracted untrusted text (Groq); text files; office files refused.
import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createMediaIngest } from '../../../src/capabilities/media.ts';
import { capEnv } from './env.ts';

const MB = 1024 * 1024;
const base = { message_id: 7, date: 1, chat: { id: 1001, type: 'private' as const, first_name: 'A' }, from: { id: 1001, is_bot: false, first_name: 'A' } };
const msg = (m: Record<string, unknown>) => ({ ...base, ...m }) as unknown as Message;

function env(provider: 'anthropic' | 'groq' = 'anthropic') {
  const e = capEnv({ provider });
  const files = new Map<string, Uint8Array>();
  const downloads: Array<{ fileId: string; maxBytes: number }> = [];
  (e.s as unknown as { telegram: unknown }).telegram = {
    files: {
      download: async (fileId: string, maxBytes: number) => {
        downloads.push({ fileId, maxBytes });
        const b = files.get(fileId);
        if (!b) throw new Error('file not found');
        return { bytes: b, size: b.length, ext: 'bin' };
      },
    },
  };
  const blobs: Array<{ id: string; mime: string; dek: string }> = [];
  const repoMsgs = e.s.repos.messages as unknown as { putBlob: (b: { mime: string; dek: string; bytes: Uint8Array }) => string };
  const put = repoMsgs.putBlob.bind(repoMsgs);
  repoMsgs.putBlob = (b) => {
    const id = put(b as never);
    blobs.push({ id, mime: b.mime, dek: b.dek });
    return id;
  };
  const media = createMediaIngest(e.s);
  const ctx = { userId: 'u1', dek: 'u:u1', lang: 'en' };
  return { ...e, files, downloads, blobs, media, ctx };
}

describe('media ingestion', () => {
  it('voice → STT with voice.ogg/audio/ogg and a "[voice 0:14]" user text block', async () => {
    const t = env();
    t.files.set('v1', new Uint8Array(2000));
    const r = await t.media.fromMessage(msg({ voice: { file_id: 'v1', file_unique_id: 'x', duration: 14, mime_type: 'audio/ogg', file_size: 2000 } }), t.ctx);
    expect(r).toEqual({ blocks: [{ type: 'text', text: '[voice 0:14] Remind me to call mom tomorrow at 10' }], kind: 'voice', sttSeconds: 14, untrusted: false });
    expect(t.s.caps.stt.calls[0]).toMatchObject({ filename: 'voice.ogg', mime: 'audio/ogg', bytes: 2000 });
    expect(t.downloads[0]).toEqual({ fileId: 'v1', maxBytes: 20 * MB });
  });

  it('audio mp3 → audio.mp3; video_note → video.mp4/video/mp4', async () => {
    const t = env();
    t.files.set('a1', new Uint8Array(10));
    t.files.set('n1', new Uint8Array(10));
    await t.media.fromMessage(msg({ audio: { file_id: 'a1', file_unique_id: 'x', duration: 3, mime_type: 'audio/mpeg', file_name: 'x.mp3' } }), t.ctx);
    await t.media.fromMessage(msg({ video_note: { file_id: 'n1', file_unique_id: 'y', duration: 5, length: 240 } }), t.ctx);
    expect(t.s.caps.stt.calls.map((c) => [c.filename, c.mime])).toEqual([['audio.mp3', 'audio/mpeg'], ['video.mp4', 'video/mp4']]);
  });

  it('no speech and files over 20 MB are refused politely (no download for a declared size)', async () => {
    const t = env();
    t.s.caps.stt.noSpeech = true;
    t.files.set('v1', new Uint8Array(10));
    expect(await t.media.fromMessage(msg({ voice: { file_id: 'v1', file_unique_id: 'x', duration: 2 } }), t.ctx)).toHaveProperty('rejected');
    const big = await t.media.fromMessage(msg({ document: { file_id: 'd1', file_unique_id: 'z', file_name: 'x.pdf', mime_type: 'application/pdf', file_size: 25 * MB } }), t.ctx);
    expect('rejected' in big && big.rejected).toMatch(/10 MB|20 MB/);
    const hugeVoice = await t.media.fromMessage(msg({ voice: { file_id: 'v9', file_unique_id: 'x', duration: 2, file_size: 21 * MB } }), t.ctx);
    expect('rejected' in hugeVoice && hugeVoice.rejected).toMatch(/20 MB/);
    expect(t.downloads.map((d) => d.fileId)).toEqual(['v1']);
  });

  it('photo → encrypted blob and an @blob image block (largest size), caption kept', async () => {
    const t = env();
    t.files.set('p_big', new Uint8Array([0xff, 0xd8, 1, 2]));
    const r = await t.media.fromMessage(msg({ photo: [{ file_id: 'p_small', file_unique_id: 's', width: 90, height: 90 }, { file_id: 'p_big', file_unique_id: 'b', width: 1280, height: 960 }], caption: 'what is this?' }), t.ctx);
    if ('rejected' in r) throw new Error(r.rejected);
    expect(t.blobs).toHaveLength(1);
    expect(t.blobs[0]).toMatchObject({ mime: 'image/jpeg', dek: 'u:u1' });
    expect(r.blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: `@blob:${t.blobs[0]!.id}` } });
    expect(r.blocks[1]).toEqual({ type: 'text', text: 'what is this?' });
    expect(JSON.stringify(r.blocks)).not.toMatch(/https?:|file\/bot/);
  });

  it('PDF ≤ 10 MB → base64 document block via @blob; text files → untrusted text; office → "send as PDF/CSV"', async () => {
    const t = env();
    t.files.set('d1', new TextEncoder().encode('%PDF-1.7 fake'));
    const r = await t.media.fromMessage(msg({ document: { file_id: 'd1', file_unique_id: 'z', file_name: 'Report.pdf', mime_type: 'application/pdf', file_size: 13 } }), t.ctx);
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.kind).toBe('document');
    expect(r.blocks[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: `@blob:${t.blobs[0]!.id}` } });
    t.files.set('c1', new TextEncoder().encode('a,b\n1,2\n'));
    const csv = await t.media.fromMessage(msg({ document: { file_id: 'c1', file_unique_id: 'c', file_name: 'data.csv', mime_type: 'text/csv', file_size: 8 } }), t.ctx);
    expect(csv).toMatchObject({ kind: 'document', untrusted: true, blocks: [{ type: 'text', text: '[file: data.csv]\na,b\n1,2\n' }] });
    const docx = await t.media.fromMessage(msg({ document: { file_id: 'x', file_unique_id: 'x', file_name: 'a.docx', file_size: 10 } }), t.ctx);
    expect('rejected' in docx && docx.rejected).toMatch(/PDF or CSV/);
  });

  it('on Groq: photos are described by vision, PDFs become untrusted extracted text', async () => {
    const t = env('groq');
    t.files.set('p', new Uint8Array([1]));
    const r = await t.media.fromMessage(msg({ photo: [{ file_id: 'p', file_unique_id: 'b', width: 10, height: 10 }] }), t.ctx);
    expect(r).toMatchObject({ kind: 'photo', untrusted: false, blocks: [{ type: 'text', text: `[image: ${t.s.caps.vision.description}]` }] });
    expect(t.blobs).toHaveLength(0);
    t.files.set('d', new TextEncoder().encode('Invoice 1042: 12 000 KZT'));
    const pdf = await t.media.fromMessage(msg({ document: { file_id: 'd', file_unique_id: 'z', file_name: 'inv.pdf', mime_type: 'application/pdf', file_size: 24 } }), t.ctx);
    expect(pdf).toMatchObject({ kind: 'document', untrusted: true });
    expect('blocks' in pdf && (pdf.blocks[0] as { text: string }).text).toContain('Invoice 1042');
  });
});
