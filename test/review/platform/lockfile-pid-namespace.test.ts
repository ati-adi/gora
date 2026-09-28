// Review (platform): the single-writer lock (src/db/sqlite.ts acquireLock) identifies the holder only by PID and treats
// a lock holding OUR OWN pid as stale ("pid !== process.pid"). The shipped image runs `CMD ["node", "src/main.ts"]`, so
// Gora is PID 1 in every container. When a second container starts on the same /data volume while the first is still
// running (compose recreate / rolling deploy / an accidental second `docker run`), it reads "1" from gora.db.lock,
// 1 === its own process.pid, deletes the live lock and boots: two writers on gora.db, two getUpdates pollers, doubled
// reminders/outbox sends. (Even without that shortcut, process.kill(1, 0) inside a container always probes itself.)
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// FIXED: the lockfile carries {pid, host, nonce} with an mtime heartbeat; a same-pid lock is only taken over once its
// heartbeat is stale (src/db/sqlite.ts acquireLock).
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../../src/db/sqlite.ts';
import { makeTmpDir, removeDir } from '../../harness/tmpDb.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir) removeDir(dir);
  dir = undefined;
});

describe('single-writer lockfile across containers', () => {
  it('does not take over a lock written by another live process that happens to have the same pid', () => {
    dir = makeTmpDir();
    const lock = join(dir, 'gora.db.lock');
    // Container A (PID 1 in its namespace) holds the lock; container B is also PID 1 → same number as process.pid here.
    writeFileSync(lock, String(process.pid));
    let release: (() => void) | undefined;
    let err: unknown = null;
    try {
      release = acquireLock(lock);
    } catch (e) {
      err = e;
    }
    release?.();
    expect(err, 'second instance acquired a lock held by another process with the same pid').toBeTruthy();
  });

  it('a live lock from another container (other host, fresh heartbeat) is refused; a dead one is taken over', () => {
    dir = makeTmpDir();
    const lock = join(dir, 'gora.db.lock');
    writeFileSync(lock, JSON.stringify({ pid: 1, host: 'container-a', nonce: 'aaaa' }));
    expect(() => acquireLock(lock)).toThrow(/locked by another Gora process \(pid 1 on container-a\)/);
    // Container A crashed a while ago: no heartbeat → stale.
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const release = acquireLock(lock);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: process.pid });
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('release never removes a lock another process took over', () => {
    dir = makeTmpDir();
    const lock = join(dir, 'gora.db.lock');
    const release = acquireLock(lock);
    writeFileSync(lock, JSON.stringify({ pid: 1, host: 'container-b', nonce: 'bbbb' }));
    release();
    expect(existsSync(lock)).toBe(true);
  });
});
