// db/keystore.ts (WP1) — keys.db: per-purpose data-encryption keys (DEKs), wrapped with the KEK (01 §11.7).
//
// keys.db lives apart from gora.db (a separate file, in production a separate volume). Each DEK is 32 random bytes,
// stored wrapped: AES-256-GCM under the KEK with AAD 'deks|<id>|v<kekVersion>', laid out as iv(12) ‖ tag(16) ‖ ct(32).
// A destroyed DEK keeps a tombstone row (wrapped = NULL, destroyed_at set), so it can never be re-created: that is what
// makes crypto-shredding final. Unwrapped DEKs are cached in an LRU (10k entries, 10 min TTL).
// The KEK is never written to disk; a check value (a wrapped constant) detects a wrong KEK at open time.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../contracts/common.ts';
import type { DekId, KeyStore } from '../contracts/storage.ts';
import { systemClock } from '../kernel/clock.ts';
import { DekDestroyedError, GoraError } from '../kernel/errors.ts';

export class KeyStoreError extends GoraError {
  override name = 'KeyStoreError';
}

export interface KeyStoreOptions {
  clock?: Clock;
  /** LRU size (default 10 000). */
  cacheSize?: number;
  /** LRU TTL (default 10 min). */
  cacheTtlMs?: number;
}

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const CHECK_PLAINTEXT = new TextEncoder().encode('gora-keystore-check-v1');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS deks (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, purpose TEXT NOT NULL,
  wrapped BLOB, kek_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, destroyed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS deks_owner ON deks(owner) WHERE wrapped IS NOT NULL;
`;

function assertKek(kek: Uint8Array): void {
  if (!(kek instanceof Uint8Array) || kek.length !== KEY_LEN) throw new KeyStoreError('KEK must be 32 bytes');
}

function wrap(kek: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
}

function unwrap(kek: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (b.length < IV_LEN + TAG_LEN) throw new KeyStoreError('keys.db: malformed wrapped key');
  const d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, IV_LEN));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(b.subarray(IV_LEN, IV_LEN + TAG_LEN));
  try {
    return new Uint8Array(Buffer.concat([d.update(b.subarray(IV_LEN + TAG_LEN)), d.final()]));
  } catch {
    throw new KeyStoreError('keys.db: cannot unwrap key (wrong KEK or corrupted keys.db)');
  }
}

/** Consistent online copy of `raw` to `destPath` (which must not exist; a leftover file is replaced). */
export function vacuumInto(raw: DatabaseSync, destPath: string): void {
  rmSync(destPath, { force: true });
  raw.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

/**
 * True when `path` holds an initialised keys.db (its KEK check value exists). Read-only probe: never creates the file.
 * An unreadable file counts as initialised, so openKeyStore reports the real error.
 */
export function keyStoreInitialized(path: string): boolean {
  if (path === ':memory:') return false;
  if (!existsSync(path)) return false;
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(path, { readOnly: true });
    const t = raw.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
    if (!t) return false;
    return raw.prepare(`SELECT 1 AS x FROM meta WHERE key = 'kek_check'`).get() !== undefined;
  } catch {
    return true;
  } finally {
    raw?.close();
  }
}

const dekAad = (id: string, version: number) => `deks|${id}|v${version}`;
const checkAad = (version: number) => `meta|kek_check|v${version}`;

interface DekRow { id: string; owner: string; wrapped: Uint8Array | null; kek_version: number }

/**
 * Opens (creating when missing) keys.db at `path`, unlocked with `kek`. Throws KeyStoreError when the KEK does not match
 * the one keys.db was created with (or last re-wrapped to).
 */
export function openKeyStore(path: string, kek: Uint8Array, o: KeyStoreOptions = {}): KeyStore {
  assertKek(kek);
  const clock = o.clock ?? systemClock();
  const cacheSize = o.cacheSize ?? 10_000;
  const ttlMs = o.cacheTtlMs ?? 10 * 60_000;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  try {
    if (path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = FULL');
    raw.exec('PRAGMA secure_delete = ON');
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec(SCHEMA);
  } catch (e) {
    raw.close();
    throw e;
  }

  let currentKek = new Uint8Array(kek);
  let version: number;
  // ── KEK check value: created on first open, verified on every later open.
  {
    const v = raw.prepare(`SELECT value FROM meta WHERE key = 'kek_version'`).get() as { value: string } | undefined;
    const chk = raw.prepare(`SELECT value FROM meta WHERE key = 'kek_check'`).get() as { value: string } | undefined;
    if (!v || !chk) {
      version = 1;
      const c = wrap(currentKek, CHECK_PLAINTEXT, checkAad(version));
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('kek_version', ?)`).run(String(version));
        raw.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('kek_check', ?)`).run(Buffer.from(c).toString('base64'));
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        raw.close();
        throw e;
      }
    } else {
      version = Number(v.value);
      try {
        const got = unwrap(currentKek, new Uint8Array(Buffer.from(chk.value, 'base64')), checkAad(version));
        if (Buffer.compare(Buffer.from(got), Buffer.from(CHECK_PLAINTEXT)) !== 0) throw new KeyStoreError('bad check');
      } catch {
        raw.close();
        throw new KeyStoreError('keys.db: wrong KEK (GORA_KEK does not unlock this key store)');
      }
    }
  }

  // ── LRU of unwrapped DEKs (Map insertion order = recency).
  const cache = new Map<string, { key: Uint8Array; at: number }>();
  const cacheGet = (id: string): Uint8Array | undefined => {
    const e = cache.get(id);
    if (!e) return undefined;
    cache.delete(id);
    if (clock.now() - e.at > ttlMs) return undefined;
    cache.set(id, e);
    return e.key;
  };
  const cachePut = (id: string, key: Uint8Array) => {
    cache.delete(id);
    if (cache.size >= cacheSize) {
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(id, { key, at: clock.now() });
  };
  const evict = (id: string) => {
    const e = cache.get(id);
    if (e) {
      e.key.fill(0);
      cache.delete(id);
    }
  };

  const selRow = raw.prepare('SELECT id, owner, wrapped, kek_version FROM deks WHERE id = ?');
  const insRow = raw.prepare('INSERT OR IGNORE INTO deks(id, owner, purpose, wrapped, kek_version, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const destroyRow = raw.prepare('UPDATE deks SET wrapped = NULL, destroyed_at = ? WHERE id = ?');
  const tombstone = raw.prepare(`INSERT OR IGNORE INTO deks(id, owner, purpose, wrapped, kek_version, created_at, destroyed_at) VALUES (?, '?', 'tombstone', NULL, ?, ?, ?)`);

  const readRow = (id: string) => selRow.get(id) as DekRow | undefined;
  const unwrapRow = (r: DekRow): Uint8Array => {
    if (!r.wrapped) throw new DekDestroyedError(r.id);
    const key = unwrap(currentKek, r.wrapped, dekAad(r.id, r.kek_version));
    if (key.length !== KEY_LEN) throw new KeyStoreError(`keys.db: bad key length for ${r.id}`);
    return key;
  };
  /** Lets keys.db's WAL pages holding destroyed keys be overwritten promptly (secure_delete covers the main file). */
  const checkpoint = () => {
    if (path === ':memory:') return;
    try {
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* busy: the next checkpoint will do it */
    }
  };
  const validId = (id: DekId) => {
    if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > 255) throw new KeyStoreError('invalid DEK id');
  };

  const ks: KeyStore = {
    path,
    get kekVersion() {
      return version;
    },
    getOrCreate(id, owner, purpose) {
      validId(id);
      const hit = cacheGet(id);
      if (hit) return hit;
      let r = readRow(id);
      if (!r) {
        const key = new Uint8Array(randomBytes(KEY_LEN));
        insRow.run(id, owner, purpose, wrap(currentKek, key, dekAad(id, version)), version, clock.now());
        r = readRow(id);
        if (!r) throw new KeyStoreError(`keys.db: could not create ${id}`);
      }
      const key = unwrapRow(r);
      cachePut(id, key);
      return key;
    },
    get(id) {
      validId(id);
      const hit = cacheGet(id);
      if (hit) return hit;
      const r = readRow(id);
      if (!r) return undefined;
      const key = unwrapRow(r);
      cachePut(id, key);
      return key;
    },
    destroy(id) {
      validId(id);
      evict(id);
      const now = clock.now();
      const r = readRow(id);
      if (r) {
        if (r.wrapped) destroyRow.run(now, id);
      } else {
        // never existed: record a tombstone so the id can never be created later (e.g. a late seal after a shred)
        tombstone.run(id, version, now, now);
      }
      checkpoint();
    },
    destroyOwner(owner) {
      const ids = (raw.prepare('SELECT id FROM deks WHERE owner = ? AND wrapped IS NOT NULL').all(owner) as Array<{ id: string }>).map((x) => x.id);
      if (!ids.length) return 0;
      const now = clock.now();
      raw.exec('BEGIN IMMEDIATE');
      try {
        for (const id of ids) destroyRow.run(now, id);
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
      for (const id of ids) evict(id);
      checkpoint();
      return ids.length;
    },
    isDestroyed(id) {
      const r = readRow(id);
      return !!r && r.wrapped === null;
    },
    rewrap(newKek, newVersion) {
      assertKek(newKek);
      if (!Number.isInteger(newVersion) || newVersion <= version) throw new KeyStoreError(`rewrap: new KEK version must be > ${version}`);
      const rows = raw.prepare('SELECT id, owner, wrapped, kek_version FROM deks WHERE wrapped IS NOT NULL').all() as unknown as DekRow[];
      const upd = raw.prepare('UPDATE deks SET wrapped = ?, kek_version = ? WHERE id = ?');
      const setMeta = raw.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
      const nk = new Uint8Array(newKek);
      raw.exec('BEGIN IMMEDIATE');
      try {
        for (const r of rows) {
          const key = unwrapRow(r);
          upd.run(wrap(nk, key, dekAad(r.id, newVersion)), newVersion, r.id);
          key.fill(0);
        }
        setMeta.run('kek_version', String(newVersion));
        setMeta.run('kek_check', Buffer.from(wrap(nk, CHECK_PLAINTEXT, checkAad(newVersion))).toString('base64'));
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
      currentKek.fill(0);
      currentKek = nk;
      version = newVersion;
      checkpoint();
      return rows.length;
    },
    async backup(destPath) {
      mkdirSync(dirname(destPath), { recursive: true });
      // VACUUM INTO, not node:sqlite backup(): on Node 26.8 backup() can hang forever (its step loop never resolves).
      // VACUUM INTO is a consistent snapshot of the committed state (WAL included) and copies no freed pages.
      vacuumInto(raw, destPath);
    },
    close() {
      for (const e of cache.values()) e.key.fill(0);
      cache.clear();
      currentKek.fill(0);
      if (raw.isOpen) raw.close();
    },
  };
  return ks;
}
