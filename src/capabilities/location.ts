// capabilities/location.ts (WP5) — location_state: the last shared point per user, sealed under u:<userId>, kept 1 h
// (or until live_until for live locations). Written by WP7 (shares, live edits), read by weather_get / brief / context.
import type { Clock, Crypto, Db, LocationService, Logger, Ms, PrivacyHook, UserId } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';

const HOUR = 3_600_000;
const aad = (col: 'lat_enc' | 'lon_enc', userId: UserId) => `location_state|${col}|${userId}`;

interface Row { lat_enc: Uint8Array; lon_enc: Uint8Array; accuracy_m: number | null; live_until: number | null; updated_at: number; expires_at: number }

export function createLocationService(deps: { db: Db; crypto: Crypto; clock: Clock; log: Logger }): LocationService & { sweep(now: Ms): number } {
  const { db, crypto, clock, log } = deps;
  return {
    set(userId, p) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return;
      const now = clock.now();
      const liveUntil = p.livePeriodSec && p.livePeriodSec > 0 ? now + Math.min(p.livePeriodSec, 86_400) * 1000 : null;
      const expires = Math.max(now + HOUR, liveUntil ?? 0);
      const dek = `u:${userId}`;
      const lat = crypto.seal(dek, String(p.lat), aad('lat_enc', userId));
      const lon = crypto.seal(dek, String(p.lon), aad('lon_enc', userId));
      // A live-location edit keeps the original live_until when no new period is given.
      db.prepare(
        `INSERT INTO location_state (user_id, lat_enc, lon_enc, accuracy_m, live_until, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET lat_enc = excluded.lat_enc, lon_enc = excluded.lon_enc, accuracy_m = excluded.accuracy_m,
           live_until = COALESCE(excluded.live_until, CASE WHEN location_state.live_until > excluded.updated_at THEN location_state.live_until END),
           updated_at = excluded.updated_at, expires_at = MAX(excluded.expires_at, COALESCE(location_state.live_until, 0))`,
      ).run(userId, lat, lon, p.accuracyM ?? null, liveUntil, now, expires);
    },
    get(userId) {
      const r = db.prepare('SELECT lat_enc, lon_enc, accuracy_m, live_until, updated_at, expires_at FROM location_state WHERE user_id = ?').get<Row>(userId);
      if (!r) return null;
      const now = clock.now();
      const until = Math.max(r.updated_at + HOUR, r.live_until ?? 0);
      if (now > until || now > r.expires_at) return null;
      try {
        const lat = Number(crypto.openText(r.lat_enc, aad('lat_enc', userId)));
        const lon = Number(crypto.openText(r.lon_enc, aad('lon_enc', userId)));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon, accuracyM: r.accuracy_m, updatedAt: r.updated_at, liveUntil: r.live_until };
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'location_state unreadable');
        return null;
      }
    },
    clear(userId) {
      db.prepare('DELETE FROM location_state WHERE user_id = ?').run(userId);
    },
    sweep(now) {
      return Number(db.prepare('DELETE FROM location_state WHERE expires_at < ?').run(now).changes);
    },
  };
}

/** Privacy hook: delete on /deletemydata, drop expired rows in the retention sweep (§11.9: location after 1 h). */
export function locationPrivacyHook(loc: LocationService & { sweep(now: Ms): number }): PrivacyHook {
  return {
    name: 'location',
    async onDeleteUser(userId) {
      loc.clear(userId);
    },
    async retentionSweep(now) {
      loc.sweep(now);
    },
  };
}
