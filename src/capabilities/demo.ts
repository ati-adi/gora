// capabilities/demo.ts (WP5) — deterministic offline providers for WEATHER/FX/GEO = 'fake' (tests, local demo) and for
// search without a Groq key. Every result is labelled as demo data so it can never pass for a live answer.
import type { Clock, Forecast, FxProvider, GeoPlace, GeoProvider, SearchCapability, WeatherProvider } from '../contracts/index.ts';
import { safeTzLookup } from './providers.ts';

const CITIES: readonly GeoPlace[] = [
  { name: 'Almaty', lat: 43.25, lon: 76.95, country: 'Kazakhstan', tz: 'Asia/Almaty' },
  { name: 'Astana', lat: 51.17, lon: 71.43, country: 'Kazakhstan', tz: 'Asia/Almaty' },
  { name: 'Moscow', lat: 55.76, lon: 37.62, country: 'Russia', tz: 'Europe/Moscow' },
  { name: 'Tashkent', lat: 41.31, lon: 69.24, country: 'Uzbekistan', tz: 'Asia/Tashkent' },
  { name: 'Bishkek', lat: 42.87, lon: 74.59, country: 'Kyrgyzstan', tz: 'Asia/Bishkek' },
  { name: 'Istanbul', lat: 41.01, lon: 28.98, country: 'Türkiye', tz: 'Europe/Istanbul' },
  { name: 'Dubai', lat: 25.2, lon: 55.27, country: 'United Arab Emirates', tz: 'Asia/Dubai' },
  { name: 'London', lat: 51.51, lon: -0.13, country: 'United Kingdom', tz: 'Europe/London' },
  { name: 'Berlin', lat: 52.52, lon: 13.4, country: 'Germany', tz: 'Europe/Berlin' },
  { name: 'Paris', lat: 48.86, lon: 2.35, country: 'France', tz: 'Europe/Paris' },
  { name: 'New York', lat: 40.71, lon: -74.01, country: 'United States', tz: 'America/New_York' },
  { name: 'San Francisco', lat: 37.77, lon: -122.42, country: 'United States', tz: 'America/Los_Angeles' },
  { name: 'Tokyo', lat: 35.68, lon: 139.69, country: 'Japan', tz: 'Asia/Tokyo' },
];
const ALIASES: Record<string, string> = { алматы: 'Almaty', 'алма-ата': 'Almaty', астана: 'Astana', москва: 'Moscow', ташкент: 'Tashkent', бишкек: 'Bishkek', стамбул: 'Istanbul', лондон: 'London', берлин: 'Berlin', париж: 'Paris', токио: 'Tokyo', 'нью-йорк': 'New York', nyc: 'New York', sf: 'San Francisco' };

/** USD per unit (demo table). */
const USD_PER: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, KZT: 1 / 480, RUB: 1 / 92, UZS: 1 / 12600, KGS: 1 / 87, TRY: 1 / 34, AED: 1 / 3.6725, JPY: 1 / 150, CNY: 1 / 7.2 };

export function createDemoWeather(clock: Clock): WeatherProvider {
  return {
    async forecast(q) {
      const days = Math.min(7, Math.max(1, Math.round(q.days)));
      const base = Math.round(25 - Math.abs(q.lat) * 0.35);
      const start = clock.now();
      return {
        place: `${Math.round(q.lat * 10) / 10}, ${Math.round(q.lon * 10) / 10}`,
        tz: safeTzLookup(q.lat, q.lon) ?? 'UTC',
        current: { tempC: base, code: 2, windKmh: 9 },
        daily: Array.from({ length: days }, (_, k) => ({ date: new Date(start + k * 86_400_000).toISOString().slice(0, 10), minC: base - 6 + k, maxC: base + 3 + k, precipProb: (k * 20) % 80, code: k % 2 ? 61 : 2 })),
        source: 'demo data (WEATHER_PROVIDER=fake)',
      } satisfies Forecast;
    },
  };
}

export function createDemoFx(clock: Clock): FxProvider {
  return {
    async rate(from, to) {
      const a = USD_PER[from.toUpperCase()];
      const b = USD_PER[to.toUpperCase()];
      if (a === undefined || b === undefined) throw new Error(`demo fx: no rate ${from}->${to}`);
      return { rate: Math.round((a / b) * 1e6) / 1e6, asOf: new Date(clock.now()).toISOString().slice(0, 10), source: 'demo rates (FX_PROVIDER=fake)' };
    },
  };
}

export function createDemoGeo(): GeoProvider {
  const find = (name: string): GeoPlace[] => {
    const key = name.trim().toLowerCase();
    const canonical = ALIASES[key] ?? name.trim();
    return CITIES.filter((c) => c.name.toLowerCase() === canonical.toLowerCase() || c.name.toLowerCase().startsWith(key));
  };
  return {
    async geocodeCity(name) {
      return find(name).map((c) => ({ ...c }));
    },
    async searchPlace(q, near) {
      const city = CITIES.find((c) => q.toLowerCase().includes(c.name.toLowerCase())) ?? (near ? null : CITIES[0]!);
      const at = near ?? { lat: city!.lat, lon: city!.lon };
      const name = q.split(',')[0]!.trim().slice(0, 120);
      if (!name) return [];
      const tz = safeTzLookup(at.lat, at.lon);
      return [{ name, lat: Math.round((at.lat + 0.004) * 1e5) / 1e5, lon: Math.round((at.lon + 0.004) * 1e5) / 1e5, address: `${name} (demo location)`, ...(tz ? { tz } : {}) }];
    },
    tzForPoint: (lat, lon) => safeTzLookup(lat, lon),
  };
}

export function createDemoSearch(): SearchCapability {
  return {
    async search(q) {
      return { answer: `Web search is not configured (no GROQ_API_KEY), so I have no live results for "${q.query.slice(0, 100)}".`, sources: [] };
    },
    async open(q) {
      return { answer: `Opening web pages is not configured (no GROQ_API_KEY); ${q.url} was not opened.`, sources: [] };
    },
  };
}
