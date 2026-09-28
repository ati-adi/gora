// test/harness/tmpDb.ts (WP0) — temporary gora.db / keys.db locations, reusable across restarts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../src/contracts/storage.ts';
import { migrate } from '../../src/db/migrate.ts';
import { openDb } from '../../src/db/sqlite.ts';

export function makeTmpDir(prefix = 'gora-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TmpPaths { dir: string; dataDir: string; dbPath: string; keysDbPath: string; backupDir: string }
/** Layout used by createTestApp: <dir>/data/gora.db, <dir>/keys/keys.db and <dir>/backups (different directories, as in production). */
export function tmpPaths(dir: string): TmpPaths {
  return { dir, dataDir: join(dir, 'data'), dbPath: join(dir, 'data', 'gora.db'), keysDbPath: join(dir, 'keys', 'keys.db'), backupDir: join(dir, 'backups') };
}

export interface TmpDb extends TmpPaths { db: Db; close(): void; cleanup(): void }

/** Opens (and by default migrates) a gora.db in a temp dir. Pass `dir` again to reopen the same files after close(). */
export function openTmpDb(o: { dir?: string; migrate?: boolean; now?: number } = {}): TmpDb {
  const dir = o.dir ?? makeTmpDir();
  const p = tmpPaths(dir);
  const db = openDb(p.dbPath);
  if (o.migrate !== false) migrate(db, { now: o.now ?? 0 });
  return {
    ...p,
    db,
    close: () => db.close(),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
