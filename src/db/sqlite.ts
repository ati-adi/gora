// db/sqlite.ts (WP0) — node:sqlite wrapper: cached statements, IMMEDIATE transactions with SAVEPOINT nesting,
// the §4.5 pragmas and a single-writer lockfile.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Db, SqlValue, Stmt } from '../contracts/storage.ts';
import { systemClock } from '../kernel/clock.ts';

export interface OpenDbOptions {
  /** Default true: journal_mode=WAL (skipped for ':memory:'). */
  wal?: boolean;
  /** Statement cache size (LRU by insertion); default 500. */
  cacheSize?: number;
}

export const DEFAULT_PRAGMAS: readonly string[] = ['synchronous = NORMAL', 'foreign_keys = ON', 'busy_timeout = 5000', 'secure_delete = ON'];

export function openDb(path: string, o: OpenDbOptions = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  if (path !== ':memory:' && o.wal !== false) raw.exec('PRAGMA journal_mode = WAL');
  for (const p of DEFAULT_PRAGMAS) raw.exec(`PRAGMA ${p}`);
  return wrapDb(raw, o.cacheSize ?? 500);
}

export function wrapDb(raw: DatabaseSync, cacheSize = 500): Db {
  const cache = new Map<string, Stmt>();
  let depth = 0;
  let spSeq = 0;

  const toStmt = (st: StatementSync): Stmt => ({
    run: (...p: SqlValue[]) => {
      const r = st.run(...p);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    get: <T,>(...p: SqlValue[]) => st.get(...p) as T | undefined,
    all: <T,>(...p: SqlValue[]) => st.all(...p) as T[],
  });

  const db: Db = {
    raw,
    prepare(sql) {
      let s = cache.get(sql);
      if (!s) {
        s = toStmt(raw.prepare(sql));
        if (cache.size >= cacheSize) cache.delete(cache.keys().next().value as string);
        cache.set(sql, s);
      }
      return s;
    },
    exec(sql) {
      raw.exec(sql);
    },
    tx<T>(fn: () => T): T {
      const nested = depth > 0;
      const sp = `sp_${++spSeq}`;
      raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
      depth++;
      let ok = false;
      try {
        const r = fn();
        if (r && typeof (r as { then?: unknown }).then === 'function') {
          throw new Error('db.tx(): fn must be synchronous (never await inside a transaction)');
        }
        ok = true;
        return r;
      } finally {
        depth--;
        const rollback = nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK';
        if (ok) {
          try {
            raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
          } catch (e) {
            // e.g. SQLITE_BUSY on COMMIT: never leave the transaction open (the next tx() would fail forever).
            try {
              if (nested || raw.isTransaction) raw.exec(rollback);
            } catch {
              /* the commit error is the one that matters */
            }
            throw e;
          }
        } else {
          try {
            if (nested || raw.isTransaction) raw.exec(rollback);
          } catch {
            /* keep fn's original error (it propagates from the try block) */
          }
        }
      }
    },
    close() {
      cache.clear();
      if (raw.isOpen) raw.close();
    },
  };
  return db;
}

/** The holder refreshes the lockfile's mtime this often… */
export const LOCK_HEARTBEAT_MS = 10_000;
/** …and a lock whose mtime is older than this (and whose pid is not visibly alive here) is stale. */
export const LOCK_STALE_MS = 60_000;
/** Identifies this process's own locks (a pid alone does not: every container's Gora is PID 1). */
const PROCESS_NONCE = randomBytes(8).toString('hex');
/** The lock compares against file mtimes, so it always uses wall time (never an injected test clock). */
const wall = systemClock();

interface LockInfo { pid: number; host: string | null; nonce: string | null }

function parseLock(text: string): LockInfo {
  try {
    const v = JSON.parse(text) as { pid?: unknown; host?: unknown; nonce?: unknown };
    if (v && typeof v === 'object' && typeof v.pid === 'number') {
      return { pid: v.pid, host: typeof v.host === 'string' ? v.host : null, nonce: typeof v.nonce === 'string' ? v.nonce : null };
    }
  } catch {
    /* legacy format: the bare pid */
  }
  return { pid: Number(text), host: null, nonce: null };
}

/**
 * Single-writer lockfile (`gora.db.lock`): JSON {pid, host, nonce}, its mtime refreshed every LOCK_HEARTBEAT_MS while
 * held. A pid alone cannot tell holders apart across containers sharing the volume (each Gora is PID 1 in its own
 * namespace, and process.kill(pid, 0) only probes ours), so an existing lock is taken over only when it is ours (same
 * process nonce), or when its heartbeat is older than LOCK_STALE_MS and its pid is not alive in this namespace (or is
 * our own pid, i.e. a dead predecessor). Returns a release function.
 */
export function acquireLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const host = hostname();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, host, nonce: PROCESS_NONCE, startedAt: wall.now() }));
      closeSync(fd);
      let released = false;
      let beat: unknown = null;
      const heartbeat = () => {
        if (released) return;
        try {
          const sec = wall.now() / 1000;
          utimesSync(lockPath, sec, sec);
        } catch {
          /* removed under us: nothing to refresh */
        }
        beat = wall.setTimeout(heartbeat, LOCK_HEARTBEAT_MS); // unref'd: never keeps the process alive
      };
      beat = wall.setTimeout(heartbeat, LOCK_HEARTBEAT_MS);
      return () => {
        if (released) return;
        released = true;
        wall.clearTimeout(beat);
        try {
          // Only remove our own lock (never one another process took over meanwhile).
          if (parseLock(readSafe(lockPath)).nonce === PROCESS_NONCE) rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const info = parseLock(readSafe(lockPath));
      if (info.nonce !== PROCESS_NONCE) {
        const ageMs = lockAgeMs(lockPath);
        const heartbeatFresh = ageMs !== null && ageMs < LOCK_STALE_MS;
        const validPid = Number.isInteger(info.pid) && info.pid > 0;
        const aliveHere = validPid && info.pid !== process.pid && (info.host === null || info.host === host) && isAlive(info.pid);
        if (heartbeatFresh || aliveHere) {
          const who = `pid ${validPid ? info.pid : '?'}${info.host && info.host !== host ? ` on ${info.host}` : ''}`;
          throw new Error(
            `database is locked by another Gora process (${who}): ${lockPath}. If no other instance is running, wait ${Math.ceil(LOCK_STALE_MS / 1000)} s or delete the lockfile.`,
          );
        }
      }
      rmSync(lockPath, { force: true }); // stale, or our own from a previous in-process open
    }
  }
  throw new Error(`could not acquire lock: ${lockPath}`);
}

function lockAgeMs(p: string): number | null {
  try {
    return Math.max(0, wall.now() - statSync(p).mtimeMs);
  } catch {
    return null;
  }
}

function readSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
