// tools/impl/fx.ts (WP5) — fx_convert (01 §6, F4): open.er-api.com via caps.fx.
import { z } from 'zod';
import type { ToolSpec } from '../../contracts/index.ts';
import { errorMessage } from '../../kernel/errors.ts';
import { L, PUBLIC_SURFACES, READ_PUBLIC, toolError } from './common.ts';

const CCY = z.string().regex(/^[A-Z]{3}$/, { message: 'ISO 4217 code such as USD' });
const input = z.object({ amount: z.number().finite(), from: CCY, to: CCY });
type In = z.infer<typeof input>;
export interface FxOut { amount: number; from: string; to: string; rate: number; result: number; asOf: string; source: string }

export const fxTool: ToolSpec<In, FxOut> = {
  name: 'fx_convert',
  description: 'Convert money between currencies at the latest rate (incl. KZT, RUB). Call for any exchange-rate or conversion question.',
  input,
  surfaces: PUBLIC_SURFACES,
  parallelSafe: true,
  classify: () => READ_PUBLIC,
  statusLabel: (_i, lang) => L(lang, '💱 Checking the rate…', '💱 Смотрю курс…'),
  async execute(i, ctx) {
    try {
      const r = i.from === i.to ? { rate: 1, asOf: new Date(ctx.now).toISOString().slice(0, 10), source: 'identity' } : await ctx.services.caps.fx.rate(i.from, i.to);
      const result = Math.round(i.amount * r.rate * 100) / 100;
      const data: FxOut = { amount: i.amount, from: i.from, to: i.to, rate: r.rate, result, asOf: r.asOf, source: r.source };
      return { content: JSON.stringify(data), data };
    } catch (e) {
      ctx.log.warn({ tool: 'fx_convert', err: errorMessage(e) }, 'fx failed');
      return toolError('FX_UNAVAILABLE', `rate ${i.from}->${i.to} is unavailable right now`);
    }
  },
};
