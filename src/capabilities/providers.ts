// capabilities/providers.ts (WP5) — keyless public-data adapters on allowlisted fixed hosts (01 F4, §11.5):
// Open-Meteo forecast + geocoding, MET Norway (weather fallback), open.er-api.com (FX, covers KZT/RUB), Photon (places),
// @photostructure/tz-lookup (tz for a point). All take an injected fetchImpl; every timer goes through Clock.
import tzlookup from '@photostructure/tz-lookup';
import type { Clock, Forecast, FxProvider, GeoPlace, GeoProvider, Logger, WeatherProvider } from '../contracts/index.ts';
import { errorMessage, GoraError } from '../kernel/errors.ts';

export class ProviderError extends GoraError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface HttpDeps { fetchImpl: typeof fetch; clock: Clock; log: Logger; userAgent: string; timeoutMs?: number }

/** GET JSON from a fixed host with a Clock-driven timeout. Logs the host only. */
export async function getJson<T>(d: HttpDeps, url: string): Promise<T> {
  const ac = new AbortController();
  const timer = d.clock.setTimeout(() => ac.abort(), d.timeoutMs ?? 10_000);
  const host = new URL(url).hostname;
  try {
    const res = await d.fetchImpl(url, { headers: { 'user-agent': d.userAgent, accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new ProviderError(`${host} HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    d.log.warn({ host, err: errorMessage(e) }, 'provider request failed');
    throw e instanceof ProviderError ? e : new ProviderError(`${host}: ${ac.signal.aborted ? 'timeout' : 'network error'}`);
  } finally {
    d.clock.clearTimeout(timer);
  }
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// ── weather
interface OpenMeteoForecast {
  timezone?: string;
  current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
  daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: Array<number | null>; weather_code?: number[] };
}
interface MetNoForecast {
  properties?: { timeseries?: Array<{ time: string; data: { instant: { details: { air_temperature?: number; wind_speed?: number } }; next_1_hours?: { summary?: { symbol_code?: string }; details?: { probability_of_precipitation?: number } }; next_6_hours?: { summary?: { symbol_code?: string }; details?: { air_temperature_max?: number; air_temperature_min?: number; probability_of_precipitation?: number } } } }> };
}
/** MET Norway symbol_code → an approximate WMO weather code (the model only needs the gist). */
export function metSymbolToWmo(sym: string | undefined): number {
  const s = (sym ?? '').replace(/_(day|night|polartwilight)$/, '');
  if (s === 'clearsky') return 0;
  if (s === 'fair') return 1;
  if (s === 'partlycloudy') return 2;
  if (s === 'cloudy') return 3;
  if (s === 'fog') return 45;
  if (s.includes('thunder')) return 95;
  if (s.includes('snow')) return s.includes('heavy') ? 75 : 71;
  if (s.includes('sleet')) return 67;
  if (s.includes('showers')) return s.includes('heavy') ? 82 : 80;
  if (s.includes('rain')) return s.includes('heavy') ? 65 : s.includes('light') ? 61 : 63;
  return 3;
}

export function createWeatherProvider(d: HttpDeps): WeatherProvider {
  async function openMeteo(q: { lat: number; lon: number; days: number }): Promise<Forecast> {
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.search = new URLSearchParams({
      latitude: String(r1(q.lat)), longitude: String(r1(q.lon)), current: 'temperature_2m,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code', timezone: 'auto', forecast_days: String(q.days),
    }).toString();
    const j = await getJson<OpenMeteoForecast>(d, u.toString());
    const c = j.current;
    if (!c || typeof c.temperature_2m !== 'number') throw new ProviderError('open-meteo: malformed response');
    const t = j.daily?.time ?? [];
    return {
      place: `${r1(q.lat)}, ${r1(q.lon)}`, tz: j.timezone ?? 'UTC', source: 'Open-Meteo',
      current: { tempC: c.temperature_2m, code: c.weather_code ?? 0, windKmh: c.wind_speed_10m ?? 0 },
      daily: t.map((date, k) => ({
        date, minC: j.daily?.temperature_2m_min?.[k] ?? NaN, maxC: j.daily?.temperature_2m_max?.[k] ?? NaN,
        precipProb: j.daily?.precipitation_probability_max?.[k] ?? 0, code: j.daily?.weather_code?.[k] ?? 0,
      })),
    };
  }
  async function metNo(q: { lat: number; lon: number; days: number }): Promise<Forecast> {
    const j = await getJson<MetNoForecast>(d, `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${r1(q.lat)}&lon=${r1(q.lon)}`);
    const ts = j.properties?.timeseries ?? [];
    const first = ts[0];
    if (!first) throw new ProviderError('met.no: malformed response');
    const tz = tzlookup(q.lat, q.lon) ?? 'UTC';
    const byDay = new Map<string, { min: number; max: number; p: number; code: number }>();
    for (const x of ts) {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.parse(x.time));
      const temp = x.data.instant.details.air_temperature;
      if (typeof temp !== 'number') continue;
      const cur = byDay.get(date) ?? { min: temp, max: temp, p: 0, code: metSymbolToWmo(x.data.next_6_hours?.summary?.symbol_code ?? x.data.next_1_hours?.summary?.symbol_code) };
      cur.min = Math.min(cur.min, temp);
      cur.max = Math.max(cur.max, temp);
      cur.p = Math.max(cur.p, x.data.next_6_hours?.details?.probability_of_precipitation ?? x.data.next_1_hours?.details?.probability_of_precipitation ?? 0);
      byDay.set(date, cur);
    }
    const det = first.data.instant.details;
    return {
      place: `${r1(q.lat)}, ${r1(q.lon)}`, tz, source: 'MET Norway',
      current: { tempC: det.air_temperature ?? NaN, code: metSymbolToWmo(first.data.next_1_hours?.summary?.symbol_code), windKmh: Math.round((det.wind_speed ?? 0) * 3.6 * 10) / 10 },
      daily: [...byDay.entries()].slice(0, q.days).map(([date, v]) => ({ date, minC: v.min, maxC: v.max, precipProb: v.p, code: v.code })),
    };
  }
  return {
    async forecast(q) {
      const days = Math.min(7, Math.max(1, Math.round(q.days)));
      try {
        return await openMeteo({ ...q, days });
      } catch (e) {
        d.log.info({ err: errorMessage(e) }, 'weather: falling back to MET Norway');
        return metNo({ ...q, days });
      }
    },
  };
}

// ── FX
interface ErApi { result?: string; time_last_update_utc?: string; rates?: Record<string, number> }
export function createFxProvider(d: HttpDeps): FxProvider {
  const cache = new Map<string, { at: number; v: ErApi }>();
  return {
    async rate(from, to) {
      const base = from.toUpperCase();
      const target = to.toUpperCase();
      if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(target)) throw new ProviderError('invalid currency code');
      let hit = cache.get(base);
      if (!hit || d.clock.now() - hit.at > 3_600_000) {
        hit = { at: d.clock.now(), v: await getJson<ErApi>(d, `https://open.er-api.com/v6/latest/${base}`) };
        if (hit.v.result !== 'success') throw new ProviderError(`er-api: no rates for ${base}`);
        cache.set(base, hit);
      }
      const rate = hit.v.rates?.[target];
      if (typeof rate !== 'number') throw new ProviderError(`er-api: no rate ${base}->${target}`);
      const asOf = hit.v.time_last_update_utc ? new Date(Date.parse(hit.v.time_last_update_utc)).toISOString().slice(0, 10) : new Date(d.clock.now()).toISOString().slice(0, 10);
      return { rate, asOf, source: 'open.er-api.com (ExchangeRate-API)' };
    },
  };
}

// ── geo
interface OmGeo { results?: Array<{ name: string; latitude: number; longitude: number; country?: string; country_code?: string; timezone?: string; admin1?: string; feature_code?: string; population?: number }> }
interface PhotonFc { features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: { name?: string; street?: string; housenumber?: string; city?: string; state?: string; country?: string; postcode?: string } }> }

export function safeTzLookup(lat: number, lon: number): string | null {
  try {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? tzlookup(lat, lon) : null;
  } catch {
    return null;
  }
}

export function createGeoProvider(d: HttpDeps): GeoProvider {
  return {
    async geocodeCity(name, lang) {
      const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
      u.search = new URLSearchParams({ name: name.slice(0, 120), count: '5', language: (lang || 'en').slice(0, 2), format: 'json' }).toString();
      const j = await getJson<OmGeo>(d, u.toString());
      return (j.results ?? []).map((r) => ({
        name: r.name, lat: r.latitude, lon: r.longitude, ...(r.country ? { country: r.country } : {}), ...(r.timezone ? { tz: r.timezone } : {}),
        ...(r.admin1 ? { address: [r.name, r.admin1, r.country].filter(Boolean).join(', ') } : {}),
        ...(r.feature_code ? { featureCode: r.feature_code } : {}), ...(typeof r.population === 'number' ? { population: r.population } : {}),
      }));
    },
    async searchPlace(q, near) {
      const u = new URL('https://photon.komoot.io/api/');
      const p = new URLSearchParams({ q: q.slice(0, 200), limit: '5' });
      if (near) {
        p.set('lat', String(near.lat));
        p.set('lon', String(near.lon));
      }
      u.search = p.toString();
      const j = await getJson<PhotonFc>(d, u.toString());
      const out: GeoPlace[] = [];
      for (const f of j.features ?? []) {
        const c = f.geometry?.coordinates;
        const pr = f.properties ?? {};
        if (!c || c.length < 2) continue;
        const street = [pr.street, pr.housenumber].filter(Boolean).join(' ');
        const address = [street, pr.city, pr.country].filter(Boolean).join(', ');
        const tz = safeTzLookup(c[1], c[0]);
        out.push({ name: pr.name ?? (street || q), lat: c[1], lon: c[0], ...(pr.country ? { country: pr.country } : {}), ...(address ? { address } : {}), ...(tz ? { tz } : {}) });
      }
      return out;
    },
    tzForPoint: (lat, lon) => safeTzLookup(lat, lon),
  };
}
