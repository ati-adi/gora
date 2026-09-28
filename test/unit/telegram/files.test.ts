// WP2 — telegram/files.ts: downloads through the injected fetch, the size cap, and the URL (it carries the token) never
// appears in errors or logs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.ts';

let e: Env;
beforeEach(async () => {
  e = await makeEnv();
});
afterEach(async () => {
  await e.close();
});

describe('telegram files', () => {
  it('downloads the bytes of a file id and reports the extension', async () => {
    e.tg.addFile('f_voice', new Uint8Array([1, 2, 3, 4]), 'voice/file_9.oga');
    const r = await e.s.telegram.files.download('f_voice', 20 * 1024 * 1024);
    expect([...r.bytes]).toEqual([1, 2, 3, 4]);
    expect(r).toMatchObject({ size: 4, ext: 'oga' });
  });

  it('refuses files over the limit (declared size or body) without leaking the URL', async () => {
    e.tg.addFile('f_big', new Uint8Array(2048), 'documents/big.pdf');
    await expect(e.s.telegram.files.download('f_big', 1024)).rejects.toThrow(/limit|exceeds/);
    e.tg.setResult('getFile', (p: { file_id: string }) => ({ file_id: p.file_id, file_unique_id: 'u', file_path: 'documents/big.pdf' })); // no declared size
    await expect(e.s.telegram.files.download('f_big', 1024)).rejects.toThrow(/limit|exceeds/);
    try {
      await e.s.telegram.files.download('f_missing', 1024);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('TEST_TOKEN');
    }
    expect(JSON.stringify(e.log.entries)).not.toContain('/file/bot');
  });
});
