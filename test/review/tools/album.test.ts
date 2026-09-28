// F11 regression (02 §C "up to 3 images per album"): on Groq each photo of an album arrives as its own message; only the
// first ALBUM_MAX_DESCRIBED photos of one media_group_id go to vision, the rest become a short "not described" line
// (no download, no vision call). The DM surface now merges albums into one input + one vision call (media.fromAlbum,
// test/review/integration/albumMerge.test.ts); this per-message cap remains the fallback.
import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { ALBUM_MAX_DESCRIBED, createMediaIngest } from '../../../src/capabilities/media.ts';
import { capEnv } from '../../unit/capabilities/env.ts';

const base = { date: 1, chat: { id: 1001, type: 'private' as const, first_name: 'A' }, from: { id: 1001, is_bot: false, first_name: 'A' } };
const photo = (k: number, group?: string) =>
  ({ ...base, message_id: 10 + k, ...(group ? { media_group_id: group } : {}), photo: [{ file_id: `p${k}`, file_unique_id: `u${k}`, width: 800, height: 600, file_size: 10 }] }) as unknown as Message;

describe('Groq album photos', () => {
  it('describes at most 3 photos of one album; other albums and single photos are unaffected', async () => {
    const e = capEnv({ provider: 'groq' });
    let downloads = 0;
    (e.s as unknown as { telegram: unknown }).telegram = { files: { download: async () => (downloads++, { bytes: new Uint8Array([1, 2, 3]), size: 3, ext: 'jpg' }) } };
    let described = 0;
    const vision = e.s.caps.vision;
    const orig = vision.describe.bind(vision);
    vision.describe = async (q) => (described++, orig(q));
    const media = createMediaIngest(e.s);
    const ctx = { userId: 'u1', dek: 'u:u1', lang: 'en' };
    const results = await Promise.all(Array.from({ length: 10 }, (_, k) => media.fromMessage(photo(k, 'album-1'), ctx)));
    expect(described).toBe(ALBUM_MAX_DESCRIBED);
    expect(downloads).toBe(ALBUM_MAX_DESCRIBED);
    const texts = results.map((r) => ('blocks' in r ? (r.blocks[0] as { text: string }).text : ''));
    expect(texts.filter((t) => t.includes('not described'))).toHaveLength(10 - ALBUM_MAX_DESCRIBED);
    await media.fromMessage(photo(20, 'album-2'), ctx);
    await media.fromMessage(photo(21), ctx);
    expect(described).toBe(ALBUM_MAX_DESCRIBED + 2);
  });
});
