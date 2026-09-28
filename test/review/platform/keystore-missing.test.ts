// Review (platform): boot does not notice that keys.db is missing/empty while gora.db already holds sealed data.
// openKeyStore() silently creates a brand-new keys.db (src/db/keystore.ts: `if (!v || !chk)` → fresh check value) and
// createApp() proceeds (src/app.ts step 3). keys.db lives on a SEPARATE volume in production (01 §4.5 step 3); an
// unmounted volume / wrong KEYS_DB_PATH therefore boots "healthy" and every existing user is broken: users.getByTg()
// throws CryptoError('unknown DEK') (only DekDestroyedError is tolerated), so each Mini App call 500s, while new data
// gets sealed under throw-away DEKs in the wrong keys.db. The process should refuse to start instead.
// FIXED: createApp (src/app.ts step 3) refuses to boot when keys.db is uninitialised but gora.db holds sealed rows.
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir, removeDir, tmpPaths } from '../../harness/tmpDb.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

let t: TestApp | undefined;
let dir: string | undefined;
afterEach(async () => {
  await t?.close().catch(() => {});
  t = undefined;
  if (dir) removeDir(dir);
  dir = undefined;
});

describe('keys.db must match the populated gora.db', () => {
  it('refuses to boot against existing sealed data when keys.db is brand new', async () => {
    dir = makeTmpDir();
    t = await createTestApp({ dir });
    expect((await t.api('GET', '/api/me')).status).toBe(200); // a user with a sealed first_name now exists
    await t.close();
    t = undefined;

    // The keys volume is not mounted (or KEYS_DB_PATH points elsewhere): keys.db is gone.
    const p = tmpPaths(dir);
    for (const s of ['', '-wal', '-shm']) rmSync(p.keysDbPath + s, { force: true });

    let bootError: unknown = null;
    try {
      t = await createTestApp({ dir });
    } catch (e) {
      bootError = e;
    }
    if (bootError === null) {
      // It booted: show the consequence — the existing user can no longer use the Mini App at all.
      const r = await t!.api('GET', '/api/me');
      expect({ booted: true, meStatus: r.status }).toEqual({ booted: false, meStatus: 'n/a' });
    }
    expect(bootError).toBeTruthy();
    expect(String((bootError as Error).message)).toMatch(/keys\.db/);
    // The refusal leaves no fresh keys.db behind, so the next boot (still unmounted) refuses again…
    expect(existsSync(p.keysDbPath)).toBe(false);
    await expect(createTestApp({ dir })).rejects.toThrow(/keys\.db/);
  });
});
