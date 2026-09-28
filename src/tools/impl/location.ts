// tools/impl/location.ts (WP5) — location_request (01 §6, F4): a one-time reply keyboard with request_location.
import { z } from 'zod';
import type { ToolSpec } from '../../contracts/index.ts';
import { FULL_SURFACES, L, UI } from './common.ts';

const input = z.object({ reason: z.string().min(1).max(120).describe('Why the location is needed, shown to the user') });
type In = z.infer<typeof input>;

export const locationTool: ToolSpec<In> = {
  name: 'location_request',
  description: 'Ask the user to share their location with one tap. Call when nearby results or local weather need a position you lack.',
  input,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  classify: () => UI,
  statusLabel: (_i, lang) => L(lang, '📍 Asking for location…', '📍 Прошу геопозицию…'),
  async execute(i, ctx) {
    ctx.effects.push({ kind: 'location_request', text: `📍 ${i.reason}` });
    return { content: 'location request shown; wait for the user to share it' };
  },
};
