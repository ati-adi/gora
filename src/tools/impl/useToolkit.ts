// tools/impl/useToolkit.ts (WP5) — use_toolkit (03 R3): loads a toolkit for the next 6 user turns (conversation_toolkits
// is WP3's table, written through s.toolkits); the engine rebuilds the tool list before the next model call.
import { z } from 'zod';
import type { ToolkitId, ToolSpec } from '../../contracts/index.ts';
import { TOOLKIT_LINES, TOOLKITS } from '../toolkits.ts';
import { CONTROL, FULL_SURFACES, L } from './common.ts';

const KITS = Object.keys(TOOLKIT_LINES) as Array<Exclude<ToolkitId, 'core'>>;
const input = z.object({
  name: z.enum(KITS as [Exclude<ToolkitId, 'core'>, ...Array<Exclude<ToolkitId, 'core'>>]),
  reason: z.string().max(120),
});
type In = z.infer<typeof input>;

/** 03 R3: one line per toolkit, terse (≤ 160 chars). */
export const USE_TOOLKIT_DESCRIPTION = 'Load tools when one is missing: web (search, URL, weather, fx, places), calendar, email, missions, secretary, files, account, browser.';

export const useToolkitTool: ToolSpec<In> = {
  name: 'use_toolkit',
  description: USE_TOOLKIT_DESCRIPTION,
  input,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  classify: () => CONTROL,
  statusLabel: (_i, lang) => L(lang, '🧰 Loading tools…', '🧰 Подключаю инструменты…'),
  async execute(i, ctx) {
    ctx.services.toolkits.load(ctx.conversationId, i.name);
    const names = TOOLKITS[i.name].filter((n) => n !== 'use_toolkit');
    return { content: `Loaded ${i.name}: ${names.join(', ')}` };
  },
};
