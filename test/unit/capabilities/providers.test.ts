// WP5 — public-data adapters (01 F4): Open-Meteo → MET Norway fallback, er-api, Open-Meteo geocoding, Photon, tz lookup;
// demo providers; location_state (sealed, 1 h expiry, live periods, sweep).
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoFx, createDemoGeo, createDemoWeather } from '../../../src/capabilities/demo.ts';
import { createLocationService } from '../../../src/capabilities/location.ts';
import { createFxProvider, createGeoProvider, createWeatherProvider, metSymbolToWmo } from '../../../src/capabilities/providers.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { createFakeCrypto, createFakeKeyStore } from '../../harness/fakes.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';

function fakeFetch(routes: Record<string, unknown | ((u: URL) => unknown)>) {
  const seen: string[] = [];
  const f = (async (input: string) => {
    const u = new URL(input);
    seen.push(u.toString());
    const key = Object.keys(routes).find((k) => u.toString().startsWith(k));
    if (!key) return new Response('not found', { status: 500 });
    const v = routes[key];
    return new Response(JSON.stringify(typeof v === 'function' ? (v as (u: URL) => unknown)(u) : v), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, clock: new FakeClock(), log: nullLogger, userAgent: 'GoraTest/1' });

describe('weather', () => {
  it('Open-Meteo with rounded coordinates', async () => {
    const { f, seen } = fakeFetch({
      'https://api.open-meteo.com/v1/forecast': { timezone: 'Asia/Almaty', current: { temperature_2m: 17.3, weather_code: 2, wind_speed_10m: 9 }, daily: { time: ['2026-09-28', '2026-09-29'], temperature_2m_min: [8, 9], temperature_2m_max: [19, 21], precipitation_probability_max: [10, 60], weather_code: [2, 61] } },
    });
    const w = await createWeatherProvider(deps(f)).forecast({ lat: 43.2389, lon: 76.8897, days: 2 });
    expect(w).toMatchObject({ tz: 'Asia/Almaty', source: 'Open-Meteo', current: { tempC: 17.3, code: 2 } });
    expect(w.daily[1]).toEqual({ date: '2026-09-29', minC: 9, maxC: 21, precipProb: 60, code: 61 });
    const q = new URL(seen[0]!).searchParams;
    expect([q.get('latitude'), q.get('longitude'), q.get('forecast_days')]).toEqual(['43.2', '76.9', '2']);
  });

  it('falls back to MET Norway when Open-Meteo fails', async () => {
    const { f, seen } = fakeFetch({
      'https://api.met.no/weatherapi/locationforecast/2.0/compact': {
        properties: { timeseries: [
          { time: '2026-09-28T09:00:00Z', data: { instant: { details: { air_temperature: 15, wind_speed: 3 } }, next_1_hours: { summary: { symbol_code: 'lightrain' }, details: { probability_of_precipitation: 40 } } } },
          { time: '2026-09-28T15:00:00Z', data: { instant: { details: { air_temperature: 19 } }, next_6_hours: { summary: { symbol_code: 'cloudy' }, details: { probability_of_precipitation: 20 } } } },
        ] },
      },
    });
    const w = await createWeatherProvider(deps(f)).forecast({ lat: 43.24, lon: 76.95, days: 1 });
    expect(seen[0]).toContain('open-meteo');
    expect(w.source).toBe('MET Norway');
    expect(w.current).toEqual({ tempC: 15, code: 61, windKmh: 10.8 });
    expect(w.daily[0]).toMatchObject({ minC: 15, maxC: 19, precipProb: 40 });
    expect(metSymbolToWmo('clearsky_day')).toBe(0);
  });
});

describe('fx and geo', () => {
  it('er-api rates (cached per base) and errors for unknown codes', async () => {
    const { f, seen } = fakeFetch({ 'https://open.er-api.com/v6/latest/USD': { result: 'success', time_last_update_utc: 'Mon, 28 Sep 2026 00:02:31 +0000', rates: { KZT: 481.5, RUB: 92.1 } } });
    const fx = createFxProvider(deps(f));
    expect(await fx.rate('USD', 'KZT')).toEqual({ rate: 481.5, asOf: '2026-09-28', source: 'open.er-api.com (ExchangeRate-API)' });
    await fx.rate('USD', 'RUB');
    expect(seen).toHaveLength(1);
    await expect(fx.rate('USD', 'XYZ')).rejects.toThrow();
  });

  it('geocoding (Open-Meteo), places (Photon) and tz for a point', async () => {
    const { f, seen } = fakeFetch({
      'https://geocoding-api.open-meteo.com/v1/search': { results: [{ name: 'Almaty', latitude: 43.25, longitude: 76.92, country: 'Kazakhstan', timezone: 'Asia/Almaty', admin1: 'Almaty' }] },
      'https://photon.komoot.io/api/': { features: [{ geometry: { coordinates: [76.945, 43.238] }, properties: { name: 'Ramen Bar', street: 'Abay Ave', housenumber: '10', city: 'Almaty', country: 'Kazakhstan' } }] },
    });
    const geo = createGeoProvider(deps(f));
    expect((await geo.geocodeCity('Almaty', 'ru'))[0]).toMatchObject({ name: 'Almaty', tz: 'Asia/Almaty', country: 'Kazakhstan' });
    expect(new URL(seen[0]!).searchParams.get('language')).toBe('ru');
    const p = (await geo.searchPlace('ramen', { lat: 43.2, lon: 76.9 }))[0]!;
    expect(p).toMatchObject({ name: 'Ramen Bar', lat: 43.238, lon: 76.945, address: 'Abay Ave 10, Almaty, Kazakhstan', tz: 'Asia/Almaty' });
    expect(new URL(seen[1]!).searchParams.get('lat')).toBe('43.2');
    expect(geo.tzForPoint(51.5, -0.12)).toBe('Europe/London');
    expect(geo.tzForPoint(999, 0)).toBeNull();
  });

  it('demo providers are deterministic and labelled', async () => {
    const clock = new FakeClock();
    expect((await createDemoWeather(clock).forecast({ lat: 43.2, lon: 76.9, days: 3 })).daily).toHaveLength(3);
    expect((await createDemoWeather(clock).forecast({ lat: 43.2, lon: 76.9, days: 1 })).source).toMatch(/demo/);
    expect((await createDemoFx(clock).rate('USD', 'KZT')).rate).toBe(480);
    expect((await createDemoGeo().geocodeCity('алматы', 'ru'))[0]?.name).toBe('Almaty');
  });
});

describe('location_state', () => {
  let t: TmpDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });
  it('seals the point, expires after 1 h (or live_until), and sweeps', async () => {
    t = openTmpDb();
    const clock = new FakeClock();
    t.db.prepare("INSERT INTO users (id, tg_user_id, created_at, updated_at) VALUES ('u1', 1001, 0, 0)").run();
    const loc = createLocationService({ db: t.db, crypto: createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(1)), clock, log: nullLogger });
    loc.set('u1', { lat: 43.2389, lon: 76.8897, accuracyM: 20 });
    const raw = t.db.prepare('SELECT lat_enc FROM location_state WHERE user_id = ?').get<{ lat_enc: Uint8Array }>('u1')!;
    expect(Buffer.from(raw.lat_enc).toString('utf8')).not.toContain('43.2389');
    expect(loc.get('u1')).toMatchObject({ lat: 43.2389, lon: 76.8897, accuracyM: 20, liveUntil: null });
    await clock.advance(61 * 60_000);
    expect(loc.get('u1')).toBeNull();
    loc.set('u1', { lat: 1, lon: 2, livePeriodSec: 8 * 3600 });
    await clock.advance(3 * 3600_000);
    expect(loc.get('u1')).toMatchObject({ lat: 1, lon: 2 });
    loc.set('u1', { lat: 1.5, lon: 2.5 }); // a live edit keeps live_until
    await clock.advance(3 * 3600_000);
    expect(loc.get('u1')).toMatchObject({ lat: 1.5 });
    await clock.advance(3 * 3600_000);
    expect(loc.get('u1')).toBeNull();
    expect(loc.sweep(clock.now())).toBe(1);
    loc.set('u1', { lat: 1, lon: 2 });
    loc.clear('u1');
    expect(loc.get('u1')).toBeNull();
  });
});
