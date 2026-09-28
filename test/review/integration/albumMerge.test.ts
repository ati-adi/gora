// INTEGRATION (F11, 02 §C): the photos of one album (separate updates sharing media_group_id) become ONE input, with ONE
// vision call over at most 3 images on Groq.
import type { Message } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ALBUM_MAX_DESCRIBED, createMediaIngest } from '../../../src/capabilities/media.ts';
import { ALBUM_WINDOW_MS } from '../../../src/surfaces/dm.ts';
import { capEnv } from '../../unit/capabilities/env.ts';
import { TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, lastButtons, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const base = { date: 1, chat: { id: 1001, type: 'private' as const, first_name: 'A' }, from: { id: 1001, is_bot: false, first_name: 'A' } };
const photo = (k: number, group: string, caption?: string) =>
  ({ ...base, message_id: 10 + k, media_group_id: group, ...(caption ? { caption } : {}), photo: [{ file_id: `p${k}`, file_unique_id: `u${k}`, width: 800, height: 600, file_size: 10 }] }) as unknown as Message;

describe('album merge (F11)', () => {
  it('media.fromAlbum on Groq: one vision call with at most 3 images, captions kept', async () => {
    const e = capEnv({ provider: 'groq' });
    let downloads = 0;
    (e.s as unknown as { telegram: unknown }).telegram = { files: { download: async () => (downloads++, { bytes: new Uint8Array([1, 2, 3]), size: 3, ext: 'jpg' }) } };
    const calls: number[] = [];
    const vision = e.s.caps.vision;
    const orig = vision.describe.bind(vision);
    vision.describe = async (q) => (calls.push(q!.images.length), orig(q!));
    const media = createMediaIngest(e.s);
    const r = await media.fromAlbum!(Array.from({ length: 5 }, (_, k) => photo(k, 'g1', k === 0 ? 'our trip' : undefined)), { userId: 'u1', dek: 'u:u1', lang: 'en' });
    expect(calls).toEqual([ALBUM_MAX_DESCRIBED]);
    expect(downloads).toBe(ALBUM_MAX_DESCRIBED);
    expect('blocks' in r && JSON.stringify(r.blocks)).toContain('album of 5 photos, the first 3 looked at');
    expect('blocks' in r && JSON.stringify(r.blocks)).toContain('our trip');
  });

  it('the DM surface merges the parts of one album into a single input after the window', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(user.id, { onboardingStep: 'done', tz: 'Asia/Almaty', tzSource: 'manual' });
    const conv = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });
    const seen: number[][] = [];
    (app.s.caps.media as { fromAlbum?: unknown }).fromAlbum = async (msgs: readonly Message[]) => {
      seen.push(msgs.map((m) => m.message_id));
      return { blocks: [{ type: 'text', text: `[images: album of ${msgs.length} photos]` }], kind: 'photo', sttSeconds: 0, untrusted: false };
    };
    const kicks = app.runner.kicks.length;
    for (let k = 0; k < 3; k++) {
      const u = U.photo({ fileId: `f${k}` });
      (u.message as unknown as { media_group_id: string }).media_group_id = 'alb-1';
      await app.send(u);
    }
    expect(app.s.repos.inputs.pending(conv.id)).toHaveLength(0); // still inside the window
    await app.advance(ALBUM_WINDOW_MS + 10);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(3);
    const pending = app.s.repos.inputs.pending(conv.id);
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending[0]!.content)).toContain('album of 3 photos');
    expect(app.runner.kicks.length).toBe(kicks + 1);
  });
});
