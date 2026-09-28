// WP5 — pdfText (03 R4): unpdf extracts text from a real (minimal) PDF; maxChars truncates.
import { describe, expect, it } from 'vitest';
import { createPdfText } from '../../../src/capabilities/pdfText.ts';

function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('pdfText', () => {
  it('extracts text and pages; truncates at maxChars', async () => {
    const pdf = createPdfText();
    const r = await pdf.extract(minimalPdf('Invoice 1042 total 12000 KZT'), 10_000);
    expect(r.pages).toBe(1);
    expect(r.text).toContain('Invoice 1042 total 12000 KZT');
    expect(r.truncated).toBe(false);
    const cut = await pdf.extract(minimalPdf('Invoice 1042 total 12000 KZT'), 7);
    expect(cut).toMatchObject({ text: 'Invoice', truncated: true });
  });
});
