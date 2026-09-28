// tools/impl/place.ts (WP5) — share_place (01 §6, F4): Photon geocode; effect `venue` after the text. No pin if nothing
// is found (the model must not invent coordinates).
import { z } from 'zod';
import type { GeoPlace, ToolSpec } from '../../contracts/index.ts';
import { errorMessage } from '../../kernel/errors.ts';
import { FULL_GROUP_SURFACES, L, ownerOf, round1, toolError, truncate, UI } from './common.ts';

const input = z.object({
  name: z.string().min(1).max(120),
  address: z.string().max(200).optional(),
  near: z.string().max(120).optional().describe('City or area to search near'),
});
type In = z.infer<typeof input>;

export const placeTool: ToolSpec<In, GeoPlace> = {
  name: 'share_place',
  description: 'Send a map pin for a named place after your answer. Call when recommending or naming a specific venue or address.',
  input,
  surfaces: FULL_GROUP_SURFACES,
  parallelSafe: true,
  classify: () => UI,
  statusLabel: (_i, lang) => L(lang, '📍 Finding the place…', '📍 Ищу место…'),
  async execute(i, ctx) {
    const s = ctx.services;
    try {
      let near: { lat: number; lon: number } | undefined;
      if (i.near) {
        const c = (await s.caps.geo.geocodeCity(i.near, ctx.lang))[0];
        if (c) near = { lat: c.lat, lon: c.lon };
      } else {
        const uid = ownerOf(ctx);
        const loc = uid && ctx.surface !== 'group' ? s.location.get(uid) : null;
        // 01 §12: Photon gets rounded coordinates only (0.1°, like weather_get), never the exact shared point.
        if (loc) near = { lat: round1(loc.lat), lon: round1(loc.lon) };
      }
      const q = [i.name, i.address].filter(Boolean).join(', ');
      const hit = (await s.caps.geo.searchPlace(q, near))[0];
      if (!hit) return toolError('PLACE_NOT_FOUND', `no map result for "${i.name}"; do not send a pin`);
      const address = truncate(hit.address ?? i.address ?? [hit.name, hit.country].filter(Boolean).join(', '), 200);
      ctx.effects.push({ kind: 'venue', lat: hit.lat, lon: hit.lon, title: truncate(i.name, 120), address });
      return { content: JSON.stringify({ pinned: true, name: hit.name, address }), data: hit };
    } catch (e) {
      ctx.log.warn({ tool: 'share_place', err: errorMessage(e) }, 'geocode failed');
      return toolError('GEO_UNAVAILABLE', 'the map service is unavailable right now; no pin sent');
    }
  },
};
