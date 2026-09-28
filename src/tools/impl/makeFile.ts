// tools/impl/makeFile.ts (WP5) — make_file (01 §6, F3; 03 R4): an isolated CodeFiles sub-call; effect document/photo.
// On Groq the enum is csv|md|txt|json|png (xlsx/docx/pdf would return "not available"); quota `file`.
import { basename } from 'node:path';
import { z } from 'zod';
import type { BetaContentBlockParam, MakeFileType, ProviderProfile, ToolCtx, ToolSpec } from '../../contracts/index.ts';
import { AbortedError, errorMessage } from '../../kernel/errors.ts';
import { FULL_SURFACES, L, toolError } from './common.ts';

export const ANTHROPIC_FILE_TYPES = ['xlsx', 'csv', 'docx', 'pdf', 'png', 'md', 'txt', 'json'] as const satisfies readonly MakeFileType[];
export const GROQ_FILE_TYPES = ['csv', 'md', 'txt', 'json', 'png'] as const satisfies readonly MakeFileType[];
export const NOT_AVAILABLE_ON_GROQ = 'Not available on the current model — I can make a CSV instead';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type In = { file_type: MakeFileType; filename: string; instructions: string; attachment_input_ids?: string[] | undefined };

function schemaFor(types: readonly [MakeFileType, ...MakeFileType[]]) {
  return z.object({
    file_type: z.enum(types),
    filename: z.string().min(1).max(80),
    instructions: z.string().min(1).max(8000).describe('Exactly what the file must contain, including all data'),
    attachment_input_ids: z.array(z.string().max(64)).max(5).optional(),
  });
}

/** Safe file name: basename, no control/format chars (bidi overrides, zero-width: extension spoofing), no leading
 *  dots, the requested extension. */
export function safeFilename(name: string, type: MakeFileType): string {
  const base = basename(name.replace(/\\/g, '/'))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"|?*]/gu, '')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 80);
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[.\s]+$/, '');
  return `${stem || 'file'}.${type}`;
}

function blobIdOf(b: BetaContentBlockParam): string | null {
  const src = (b as { source?: { type?: string; data?: unknown } }).source;
  if ((b.type === 'image' || b.type === 'document') && src?.type === 'base64' && typeof src.data === 'string' && src.data.startsWith('@blob:')) return src.data.slice(6);
  return null;
}

/** Loads the bytes of the given conversation inputs (images/PDFs from blobs, text files as text). */
function loadAttachments(ids: readonly string[], ctx: ToolCtx): Array<{ bytes: Uint8Array; filename: string; mime: string }> | string {
  const s = ctx.services;
  const out: Array<{ bytes: Uint8Array; filename: string; mime: string }> = [];
  for (const id of ids) {
    const row = s.repos.inputs.get(id);
    if (!row || row.conversationId !== ctx.conversationId) return `attachment ${id} was not found in this conversation`;
    let n = 0;
    for (const b of row.content) {
      const blobId = blobIdOf(b);
      if (blobId) {
        const blob = s.repos.messages.getBlob(blobId);
        if (!blob) continue;
        if (blob.bytes.byteLength > MAX_ATTACHMENT_BYTES) return `attachment ${id} is too large`;
        const ext = blob.mime === 'application/pdf' ? 'pdf' : (blob.mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/g, '');
        out.push({ bytes: blob.bytes, filename: `input_${out.length + 1}.${ext}`, mime: blob.mime });
        n++;
      } else if (b.type === 'text' && row.kind !== 'text') {
        out.push({ bytes: new TextEncoder().encode(b.text), filename: `input_${out.length + 1}.txt`, mime: 'text/plain' });
        n++;
      }
    }
    if (n === 0) return `attachment ${id} has no file content`;
  }
  return out;
}

export function makeFileTool(profile: Pick<ProviderProfile, 'provider'>): ToolSpec<In> {
  const groq = profile.provider === 'groq';
  const input = schemaFor(groq ? GROQ_FILE_TYPES : ANTHROPIC_FILE_TYPES) as unknown as z.ZodType<In>;
  return {
    name: 'make_file',
    description: groq
      ? 'Create a downloadable file (csv, md, txt, json, or a png chart). Call when the user asks for a file, table export or chart.'
      : 'Create a downloadable file (xlsx, csv, docx, pdf, png chart, md, txt, json). Call when the user asks for a file or chart.',
    input,
    surfaces: FULL_SURFACES,
    parallelSafe: false,
    classify: () => ({ actionClass: 'compute', risk: 0, quotaKind: 'file' }),
    statusLabel: (i, lang) => L(lang, `📄 Making ${i.file_type.toUpperCase()}…`, `📄 Готовлю ${i.file_type.toUpperCase()}…`),
    async execute(i, ctx) {
      if (groq && !(GROQ_FILE_TYPES as readonly string[]).includes(i.file_type)) return toolError('NOT_AVAILABLE', NOT_AVAILABLE_ON_GROQ);
      const userId = ctx.userId;
      if (!userId) return toolError('NOT_ALLOWED', 'files can only be made in a private chat');
      const inputs = i.attachment_input_ids?.length ? loadAttachments(i.attachment_input_ids, ctx) : [];
      if (typeof inputs === 'string') return toolError('ATTACHMENT', inputs);
      const filename = safeFilename(i.filename, i.file_type);
      try {
        const f = await ctx.services.caps.codeFiles.make({ userId, fileType: i.file_type, filename, instructions: i.instructions, inputs, signal: ctx.signal });
        const name = safeFilename(f.filename || filename, i.file_type);
        if (i.file_type === 'png' && f.mime === 'image/png') ctx.effects.push({ kind: 'photo', bytes: f.bytes, filename: name });
        else ctx.effects.push({ kind: 'document', bytes: f.bytes, filename: name, mime: f.mime });
        return { content: JSON.stringify({ sent: name, bytes: f.bytes.byteLength }), data: { filename: name, mime: f.mime, bytes: f.bytes.byteLength } };
      } catch (e) {
        if (e instanceof AbortedError || ctx.signal.aborted) throw e;
        const msg = errorMessage(e);
        ctx.log.warn({ tool: 'make_file', err: msg }, 'make_file failed');
        if (/not available/i.test(msg)) return toolError('NOT_AVAILABLE', NOT_AVAILABLE_ON_GROQ);
        return toolError('FILE_FAILED', 'the file could not be generated; tell the user and offer a simpler format');
      }
    },
  };
}
