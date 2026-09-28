// capabilities/pdfText.ts (WP5) — PDF text extraction with unpdf (03 R4). Used on Groq, where PDFs cannot be sent as
// document blocks. The caller wraps the text <untrusted source="file">; nothing is cached in plaintext.
import { extractText, getDocumentProxy } from 'unpdf';
import type { PdfTextCapability } from '../contracts/index.ts';

export function createPdfText(): PdfTextCapability {
  return {
    async extract(bytes, maxChars) {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      try {
        const { totalPages, text } = await extractText(pdf, { mergePages: true });
        const clean = String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        const cap = Math.max(0, maxChars);
        return { text: clean.slice(0, cap), pages: totalPages, truncated: clean.length > cap };
      } finally {
        await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
      }
    },
  };
}
