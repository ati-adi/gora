// db/repos/kv.ts (WP1) — small JSON key/value store (reserved keys: contracts/storage.ts KvRepo).
import type { Clock } from '../../contracts/common.ts';
import type { Db, KvRepo } from '../../contracts/storage.ts';

export function createKvRepo(db: Db, clock: Clock): KvRepo & { delete(key: string): void } {
  return {
    get<T>(key: string): T | undefined {
      const r = db.prepare('SELECT value_json FROM kv WHERE key = ?').get<{ value_json: string }>(key);
      if (!r) return undefined;
      try {
        return JSON.parse(r.value_json) as T;
      } catch {
        return undefined;
      }
    },
    set(key, v) {
      const json = JSON.stringify(v);
      if (json === undefined) {
        db.prepare('DELETE FROM kv WHERE key = ?').run(key);
        return;
      }
      db.prepare('INSERT INTO kv(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run(
        key, json, clock.now(),
      );
    },
    delete(key) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    },
  };
}
