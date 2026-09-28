// privacy/backup.ts (WP1) — the nightly 'backup' job (01 §11.7): an online copy of gora.db and, separately, of keys.db
// into config.backupDir, retained 7 days. Deviation: the copy is `VACUUM INTO` rather than node:sqlite backup(), which
// hangs on Node 26.8 (its promise never settles); VACUUM INTO is an equally consistent snapshot and is synchronous.
// Because a destroyed DEK is absent from every keys backup taken after the destruction, the crypto-shred reaches the
// backups once the 7-day window has passed.
//
// Layout: <backupDir>/gora/gora-<stamp>.db and <backupDir>/keys/keys-<stamp>.db, stamp = UTC 'YYYYMMDDTHHmmssZ' of the
// Clock. Each copy is written to '<name>.tmp' and renamed, so a half-written file never looks like a backup. Pruning
// reads the stamp from the file name (not mtime) and deletes copies older than 7 days, plus stale .tmp files.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Ms, Services } from '../contracts/index.ts';
import { vacuumInto } from '../db/keystore.ts';

export const BACKUP_RETENTION_MS = 7 * 24 * 3_600_000;
const NAME_RE = /^(gora|keys)-(\d{8}T\d{6}Z)\.db(\.tmp)?$/;

export function backupStamp(now: Ms): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}
export function parseBackupStamp(stamp: string): Ms | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface BackupResult { goraPath: string; keysPath: string; pruned: number }

export async function runBackup(s: Services, now: Ms): Promise<BackupResult> {
  const root = s.config.backupDir;
  const goraDir = join(root, 'gora');
  const keysDir = join(root, 'keys');
  mkdirSync(goraDir, { recursive: true });
  mkdirSync(keysDir, { recursive: true });
  const stamp = backupStamp(now);
  const goraPath = join(goraDir, `gora-${stamp}.db`);
  const keysPath = join(keysDir, `keys-${stamp}.db`);

  const copy = async (dest: string, fn: (tmp: string) => Promise<unknown>): Promise<void> => {
    const tmp = dest + '.tmp';
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    await fn(tmp);
    renameSync(tmp, dest);
  };
  await copy(goraPath, async (tmp) => vacuumInto(s.db.raw, tmp));
  await copy(keysPath, (tmp) => s.keyStore.backup(tmp));

  const pruned = pruneBackups(root, now);
  s.log.info({ stamp, pruned }, 'backup done');
  return { goraPath, keysPath, pruned };
}

/** Deletes backups (and leftover .tmp files) whose stamp is older than 7 days. Returns how many files were removed. */
export function pruneBackups(root: string, now: Ms): number {
  let n = 0;
  for (const sub of ['gora', 'keys']) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = NAME_RE.exec(f);
      if (!m) continue;
      const at = parseBackupStamp(m[2]!);
      if (at === null) continue;
      const stale = now - at > BACKUP_RETENTION_MS || (m[3] !== undefined && now - at > 3_600_000);
      if (!stale) continue;
      rmSync(join(dir, f), { force: true });
      for (const side of ['-wal', '-shm']) rmSync(join(dir, f + side), { force: true });
      n++;
    }
  }
  return n;
}
