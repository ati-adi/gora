// db/migrate.ts (WP0) — applies src/db/migrations/NNN_*.sql in order, each in its own transaction,
// recording versions in schema_migrations (created by 001 itself).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../contracts/storage.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export interface Migration { version: number; name: string; sql: string }

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f, sql: readFileSync(dir + f, 'utf8') }));
}

export function appliedVersions(db: Db): Set<number> {
  const exists = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!exists) return new Set();
  return new Set(db.prepare('SELECT version FROM schema_migrations').all<{ version: number }>().map((r) => Number(r.version)));
}

/** Applies pending migrations; returns the versions applied now. `now` stamps rows the migration did not stamp itself. */
export function migrate(db: Db, o: { dir?: string; now?: number } = {}): number[] {
  const done = appliedVersions(db);
  const applied: number[] = [];
  for (const m of loadMigrations(o.dir)) {
    if (done.has(m.version)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(m.version, o.now ?? 0);
    });
    applied.push(m.version);
  }
  return applied;
}
