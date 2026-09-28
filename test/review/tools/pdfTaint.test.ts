// REVIEW (tools): on the Anthropic profile a PDF is ingested with untrusted:false (media.ts:189-190), while the same PDF
// on Groq (media.ts:182) and any txt/csv/json file (media.ts:163) are untrusted:true (taint 'file'). A third-party PDF
// (invoice, CV, contract) carrying hidden instructions therefore leaves the run UNtainted on Anthropic, so S14 ("tainted
// run: sends ask, standing grants ignored") does not apply and a matching standing grant (S15) can auto-send.
import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createMediaIngest } from '../../../src/capabilities/media.ts';
import { capEnv } from '../../unit/capabilities/env.ts';

const base = { message_id: 7, date: 1, chat: { id: 1001, type: 'private' as const, first_name: 'A' }, from: { id: 1001, is_bot: false, first_name: 'A' } };

function ingest(provider: 'anthropic' | 'groq', fileName: string, mime: string, bytes: Uint8Array) {
  const e = capEnv({ provider });
  (e.s as unknown as { telegram: unknown }).telegram = { files: { download: async () => ({ bytes, size: bytes.length, ext: 'bin' }) } };
  const media = createMediaIngest(e.s);
  return media.fromMessage({ ...base, document: { file_id: 'd1', file_unique_id: 'x', file_name: fileName, mime_type: mime, file_size: bytes.length } } as unknown as Message, { userId: 'u1', dek: 'u:u1', lang: 'en' });
}

describe('document taint consistency', () => {
  it('a PDF is third-party content on every provider, like a .txt', async () => {
    const txt = await ingest('anthropic', 'invoice.txt', 'text/plain', new TextEncoder().encode('Pay to IBAN ...'));
    const pdf = await ingest('anthropic', 'invoice.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4 ...'));
    expect('untrusted' in txt && txt.untrusted).toBe(true);
    expect('untrusted' in pdf && pdf.untrusted, 'anthropic PDF is not tainting').toBe(true);
  });
});
