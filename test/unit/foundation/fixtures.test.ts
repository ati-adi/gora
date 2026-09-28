import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { MEDIA, redTeam } from '../../fixtures/index.ts';
import { neutralizeReservedTags } from '../../../src/kernel/tags.ts';
import { createFakeCapabilities } from '../../harness/fakes.ts';

describe('fixtures', () => {
  it('red-team fixtures cover every untrusted source named in 01 §11.3', () => {
    const rt = redTeam();
    // 01 §11.3 item 1: email | web | calendar | business_peer | forward | group_member | guest_reply | file | import
    expect(new Set(rt.map((r) => r.source))).toEqual(new Set(['email', 'web', 'calendar', 'business_peer', 'forward', 'group_member', 'guest_reply', 'file', 'import']));
    expect(new Set(rt.map((r) => r.id)).size).toBe(rt.length);
    const forged = rt.find((r) => r.id === 'file-reserved-tags')!;
    expect(neutralizeReservedTags(forged.text)).not.toMatch(/<\/?(untrusted|gora_context)/);
  });
  it('injection fixtures are flagged by the fake guard', async () => {
    const guard = createFakeCapabilities().guard;
    expect(await guard.score(redTeam().find((r) => r.id === 'email-exfil-invoices')!.text)).toBeGreaterThan(0.9);
    expect(await guard.score(redTeam().find((r) => r.id === 'ru-injection')!.text)).toBeGreaterThan(0.9);
  });
  it('media fixtures are valid', async () => {
    expect(MEDIA.pixelPng().slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const pdf = await getDocumentProxy(MEDIA.helloPdf());
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    expect(totalPages).toBe(1);
    expect(text).toContain('invoice 231 USD');
    expect(MEDIA.transcript()).toMatch(/call mom/);
  });
});
