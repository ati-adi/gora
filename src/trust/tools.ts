// trust/tools.ts (WP4) — 01 §6: revise_pending_action and task_wait (FULL toolset only).
// task_wait's park semantics live in the executor (§5.6 step 6); its execute is never reached through a round.
import { z } from 'zod';
import type { ToolSpec } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';

const FULL_SURFACES = ['dm', 'topic', 'mission'] as const;

const reviseInput = z.object({
  approval_id: z.string().regex(/^[A-Z0-9]{6}$/),
  new_input: z.record(z.string(), z.unknown()),
});

export const revisePendingAction: ToolSpec<z.infer<typeof reviseInput>> = {
  name: 'revise_pending_action',
  description:
    'Call when the owner replies to an approval card asking for changes. Pass the card id and the COMPLETE new input for the same tool. A new card replaces the old one; the owner must tap Approve again.',
  input: reviseInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }),
  statusLabel: (_i, lang) => (uiLang(lang) === 'ru' ? 'Обновляю карточку' : 'Updating the card'),
  async execute(input, ctx) {
    const r = await ctx.services.approvals.revise(input.approval_id, input.new_input, ctx);
    if ('error' in r) {
      let body: unknown = { error: r.error };
      try {
        const parsed = JSON.parse(r.error) as unknown;
        if (parsed && typeof parsed === 'object') body = parsed;
      } catch {
        /* plain error code */
      }
      return { content: JSON.stringify(body), isError: true };
    }
    return {
      content: JSON.stringify({
        status: 'pending_approval',
        approval_id: r.newId,
        replaces: input.approval_id,
        performed: false,
        note: 'A new card replaced the old one. Waiting for the owner to tap Approve. Do not say it is done.',
      }),
    };
  },
};

const WAIT_TOKEN = /^(approval:[A-Z0-9]{6}|watcher:[A-Za-z0-9_-]+|user_input)$/;
const waitInput = z.object({
  on: z.array(z.string().regex(WAIT_TOKEN)).min(1).max(5),
  until_local: z.string().max(40).optional(),
  timeout_hours: z.number().min(0.05).max(336),
});

export const taskWait: ToolSpec<z.infer<typeof waitInput>> = {
  name: 'task_wait',
  description:
    'Call inside a mission to pause until an approval is decided, a watcher fires, or the owner replies, instead of polling. DM waits are capped at 24 h.',
  input: waitInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }),
  statusLabel: (_i, lang) => (uiLang(lang) === 'ru' ? 'Жду' : 'Waiting'),
  async execute() {
    // Reached only if a caller bypasses the executor's park path; the round itself never executes task_wait.
    return { content: JSON.stringify({ status: 'waiting' }) };
  },
};

export const TOOLS: readonly ToolSpec[] = [revisePendingAction, taskWait];
