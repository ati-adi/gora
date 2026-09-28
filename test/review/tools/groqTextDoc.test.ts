// REVIEW (tools): on Groq, txt/md/csv/json documents up to 200 KB are inlined verbatim (media.ts:160-163); only PDFs go
// through summarizeLong(). 02 §C: "PDF / text documents ... Documents over the context budget are summarized by fast in
// chunks." With groq-free maxPromptTokens 5,200 a ~20 KB CSV (~6K tokens) lands in the run-start user row, which the
// GroqTransport hard ceiling may never drop or truncate (03 R2) -> BadRequestLlmError('prompt_budget') -> the owner gets
// "That was too long for me to process" for an ordinary spreadsheet export.
import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createMediaIngest } from '../../../src/capabilities/media.ts';
import { CHARS_PER_TOKEN } from '../../../src/kernel/tokens.ts';
import { capEnv } from '../../unit/capabilities/env.ts';

const base = { message_id: 7, date: 1, chat: { id: 1001, type: 'private' as const, first_name: 'A' }, from: { id: 1001, is_bot: false, first_name: 'A' } };

describe('Groq text documents over the context budget', () => {
  it('a 60 KB CSV is summarized (or cut) to the document budget like a PDF, not inlined whole', async () => {
    const e = capEnv({ provider: 'groq' });
    const bytes = new TextEncoder().encode(Array.from({ length: 2000 }, (_, i) => `row${i},Almaty,${i * 17},paid`).join('\n').padEnd(60_000, 'x'));
    (e.s as unknown as { telegram: unknown }).telegram = { files: { download: async () => ({ bytes, size: bytes.length, ext: 'csv' }) } };
    let parses = 0;
    (e.s as unknown as { transport: unknown }).transport = { parse: async () => (parses++, { parsed: { summary: 'summary' } }) };
    const media = createMediaIngest(e.s);
    const r = await media.fromMessage({ ...base, document: { file_id: 'd1', file_unique_id: 'x', file_name: 'export.csv', mime_type: 'text/csv', file_size: bytes.length } } as unknown as Message, { userId: 'u1', dek: 'u:u1', lang: 'en' });
    expect('blocks' in r).toBe(true);
    const text = 'blocks' in r ? r.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('') : '';
    const budgetChars = Math.floor(Math.max(1500, Math.floor(e.s.profile.maxPromptTokens / 3)) * CHARS_PER_TOKEN);
    expect(text.length, `inlined ${text.length} chars (~${Math.round(text.length / CHARS_PER_TOKEN)} tokens) vs maxPromptTokens ${e.s.profile.maxPromptTokens}; parse calls ${parses}`).toBeLessThanOrEqual(budgetChars * 2);
  });
});
