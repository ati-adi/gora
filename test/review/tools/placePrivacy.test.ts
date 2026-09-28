// REVIEW (tools): share_place (tools/impl/place.ts:30-36) sends the owner's exact shared GPS point to Photon as the
// search bias. 01 §12 lists Photon as a processor with "coordinates rounded" and F4 rounds to 0.1° (weather_get does
// round1()); share_place forwards full precision (a home address) to a third party.
import { describe, expect, it } from 'vitest';
import { placeTool } from '../../../src/tools/impl/place.ts';
import { createToolEnv } from '../../unit/tools/env.ts';

describe('share_place location privacy', () => {
  it('rounds the owner location before sending it to the geocoder', async () => {
    const env = createToolEnv();
    env.s.caps.location.set(env.user.id, { lat: 43.238949, lon: 76.889709 });
    const seen: Array<{ lat: number; lon: number } | undefined> = [];
    const geo = env.s.caps.geo;
    const orig = geo.searchPlace.bind(geo);
    geo.searchPlace = async (q: string, near?: { lat: number; lon: number }) => {
      seen.push(near);
      return orig(q, near);
    };
    await env.run(placeTool, { name: 'Ramen Bar' });
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toEqual({ lat: 43.2, lon: 76.9 });
  });
});
