// tools/impl/weather.ts (WP5) — weather_get (01 §6, F4): geocode, then forecast (Open-Meteo → MET Norway, coords 0.1°).
// With no place: the shared location (≤ 1 h old), else the owner's home city (settings.homeCity).
import { z } from 'zod';
import type { Forecast, ToolSpec } from '../../contracts/index.ts';
import { errorMessage } from '../../kernel/errors.ts';
import { L, ownerOf, PUBLIC_SURFACES, READ_PUBLIC, round1, toolError } from './common.ts';

const input = z.object({
  place: z.string().min(1).max(120).optional().describe('City or place; omit for the user location or home city'),
  days: z.number().int().min(1).max(7).default(2),
});
type In = z.input<typeof input>;

export const weatherTool: ToolSpec<In, Forecast> = {
  name: 'weather_get',
  description: 'Get current weather and a 1-7 day forecast for a place (default: user location or home city). Call for any weather question.',
  input,
  surfaces: PUBLIC_SURFACES,
  parallelSafe: true,
  classify: () => READ_PUBLIC,
  statusLabel: (i, lang) => L(lang, `🌦 Weather${i.place ? ` in ${i.place}` : ''}…`, `🌦 Погода${i.place ? `: ${i.place}` : ''}…`),
  async execute(i, ctx) {
    const s = ctx.services;
    const days = i.days ?? 2;
    let point: { lat: number; lon: number; name: string } | null = null;
    try {
      if (i.place) {
        const hits = await s.caps.geo.geocodeCity(i.place, ctx.lang);
        const h = hits[0];
        if (!h) return toolError('PLACE_NOT_FOUND', `no place named "${i.place}" was found`);
        point = { lat: h.lat, lon: h.lon, name: h.country ? `${h.name}, ${h.country}` : h.name };
      } else {
        const uid = ownerOf(ctx);
        const loc = uid && ctx.surface !== 'guest' && ctx.surface !== 'group' ? s.location.get(uid) : null;
        if (loc) point = { lat: loc.lat, lon: loc.lon, name: 'your location' };
        else if (uid && ctx.surface !== 'guest') {
          const home = s.repos.users.settings(uid).homeCity;
          if (home) point = { lat: home.lat, lon: home.lon, name: home.name };
        }
        if (!point) return toolError('NO_PLACE', 'no place given and no known location; ask for a city or call location_request');
      }
      const f = await s.caps.weather.forecast({ lat: round1(point.lat), lon: round1(point.lon), days });
      const data: Forecast = { ...f, place: f.place || point.name, daily: f.daily.slice(0, days) };
      return { content: JSON.stringify(data), data };
    } catch (e) {
      ctx.log.warn({ tool: 'weather_get', err: errorMessage(e) }, 'weather failed');
      return toolError('WEATHER_UNAVAILABLE', 'the weather service is unavailable right now');
    }
  },
};
