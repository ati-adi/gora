// scripts/check-schema.ts — `node scripts/check-schema.ts [path/to/gora.db]` (default: $DATA_DIR/gora.db, else
// ./data/gora.db). READ-ONLY: opens the database with readOnly and compares its schema (sqlite_master: every table,
// index and trigger, whitespace-normalized) with the schema the migrations in src/db/migrations/ produce on an empty
// in-memory database. Exits 0 when they match, 1 with a diff otherwise.
// Why: a live bot that booted while an earlier draft of a migration file was on disk records the version as applied,
// and the final file never runs there. Fix a drift with a NEW migration (never by editing an applied one).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadMigrations } from '../src/db/migrate.ts';

type Row = { type: string; name: string; sql: string | null };
const norm = (sql: string | null) => (sql ?? '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

function schemaOf(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Row[];
  return new Map(rows.map((r) => [`${r.type} ${r.name}`, norm(r.sql)]));
}

const path = process.argv[2] ?? join(process.env['DATA_DIR'] ?? './data', 'gora.db');
if (!existsSync(path)) {
  process.stderr.write(`check-schema: ${path} does not exist\n`);
  process.exit(2);
}
const live = new DatabaseSync(path, { readOnly: true });
const ref = new DatabaseSync(':memory:');
const migrations = loadMigrations();
for (const m of migrations) ref.exec(m.sql);

const applied = (live.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: number }>).map((r) => Number(r.version));
const expected = migrations.map((m) => m.version);
const a = schemaOf(live);
const b = schemaOf(ref);
const problems: string[] = [];
if (applied.join(',') !== expected.join(',')) problems.push(`schema_migrations: applied [${applied.join(', ')}], files [${expected.join(', ')}]`);
for (const [k, v] of b) {
  if (!a.has(k)) problems.push(`missing in the database: ${k}`);
  else if (a.get(k) !== v) problems.push(`differs: ${k}\n    database:   ${a.get(k)}\n    migrations: ${v}`);
}
for (const k of a.keys()) if (!b.has(k)) problems.push(`not in the migrations: ${k}`);
live.close();
ref.close();

if (problems.length) {
  process.stdout.write(`check-schema: ${path} DIFFERS from src/db/migrations (${problems.length}):\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(`check-schema: ${path} matches migrations ${expected.join(', ')} (${b.size} objects)\n`);
