// tools/impl/ledger.ts (WP5) — ledger_query (01 §6, F8): the owner's own ledger summaries (never message bodies).
import { z } from 'zod';
import type { LedgerKind, ToolSpec } from '../../contracts/index.ts';
import { formatDisplay, parseLocal, zonedToInstant } from '../../kernel/timeMath.ts';
import { zLocal } from '../schema.ts';
import { FULL_SURFACES, L, ownerOf, toolError } from './common.ts';

export const LEDGER_KINDS = [
  'tool_call', 'data_read', 'approval_requested', 'approval_resolved', 'message_sent', 'email_sent', 'draft_created', 'calendar_changed', 'memory_saved',
  'memory_forgotten', 'connection', 'permission_change', 'grant_change', 'business_event', 'nudge_sent', 'mission', 'payment', 'export', 'deletion',
  'consent', 'pause', 'refusal', 'fallback_served', 'undo', 'settings', 'guard_block',
] as const satisfies readonly LedgerKind[];

const input = z.object({
  from_local: zLocal.optional(),
  to_local: zLocal.optional(),
  kind: z.enum(LEDGER_KINDS).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
type In = z.input<typeof input>;

export const ledgerTool: ToolSpec<In> = {
  name: 'ledger_query',
  description: 'Look up what Gora did for the owner (actions, reads, approvals). Call for "what did you do / send / read" questions.',
  input,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  classify: () => ({ actionClass: 'read_private', risk: 0 }),
  statusLabel: (_i, lang) => L(lang, '📒 Checking the activity log…', '📒 Смотрю журнал…'),
  async execute(i, ctx) {
    const userId = ownerOf(ctx);
    if (!userId || ctx.scope?.kind !== 'user') return toolError('NOT_ALLOWED', 'the activity log is only available to its owner in a private chat');
    const toMs = (s: string | undefined): number | undefined => {
      if (!s) return undefined;
      const w = parseLocal(s);
      return w ? zonedToInstant(w, ctx.tz).instant : undefined;
    };
    const fromMs = toMs(i.from_local);
    const to = toMs(i.to_local);
    const rows = ctx.services.ledger.list(userId, { limit: i.limit ?? 20, ...(i.kind ? { kinds: [i.kind] } : {}), ...(fromMs !== undefined ? { fromMs } : {}), ...(to !== undefined ? { toMs: to } : {}) });
    const entries = rows.map((r) => ({ seq: r.seq, when: formatDisplay(r.ts, ctx.tz, ctx.lang), kind: r.kind, actor: r.actor, summary: r.summary }));
    return { content: JSON.stringify({ entries, count: entries.length }), data: { entries } };
  },
};
