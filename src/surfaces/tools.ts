// src/surfaces/tools.ts (WP7a) — 01 §6 `poll_create` (GROUP): `sendPoll` in the same group only, idempotent per
// ctx.idemKey (the outbox dedupes by idempotency key). app.ts passes TOOLS to createToolRegistry (WP5).
import { z } from 'zod';
import type { ToolSpec } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';

const pollInput = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
  allows_multiple_answers: z.boolean().optional(),
  allows_revoting: z.boolean().optional(),
});
export type PollInput = z.infer<typeof pollInput>;

export const pollCreate: ToolSpec<PollInput> = {
  name: 'poll_create',
  description: 'Call when the group wants to vote or decide between options (where to eat, which date works). Posts a native Telegram poll in this group; members vote there. Not for private chats.',
  input: pollInput,
  surfaces: ['group'],
  parallelSafe: false,
  classify: () => ({ actionClass: 'ui', risk: 0 }),
  statusLabel: (_i, lang) => (uiLang(lang) === 'ru' ? 'Создаю опрос' : 'Creating a poll'),
  async execute(input, ctx) {
    if (ctx.surface !== 'group' || ctx.scope?.kind !== 'group' || ctx.scope.chatId !== ctx.chat.chatId) {
      return { content: JSON.stringify({ error: 'poll_create works only in the group this conversation belongs to' }), isError: true };
    }
    const options = [...new Set(input.options.map((o) => o.trim()))].filter(Boolean);
    if (options.length < 2) return { content: JSON.stringify({ error: 'need at least 2 distinct options' }), isError: true };
    // Idempotent per idemKey even if the outbox row was already purged (an executor retry after a crash).
    const doneKey = `poll:${ctx.idemKey}`;
    const prior = ctx.services.repos.kv.get<{ messageId: number | null; options: number }>(doneKey);
    if (prior) return { content: JSON.stringify({ status: 'posted', message_id: prior.messageId, options: prior.options }) };
    const refs = await ctx.services.telegram.outbox.sendNow({
      idempotencyKey: `poll:${ctx.idemKey}`,
      chatId: ctx.chat.chatId,
      ...(ctx.chat.threadId ? { threadId: ctx.chat.threadId } : {}),
      method: 'sendPoll',
      payload: {
        question: input.question,
        options: options.map((text) => ({ text })),
        is_anonymous: false,
        allows_multiple_answers: input.allows_multiple_answers ?? false,
        allows_revoting: input.allows_revoting ?? true,
      },
      priority: 0,
    });
    ctx.services.repos.kv.set(doneKey, { messageId: refs[0]?.messageId ?? null, options: options.length });
    return { content: JSON.stringify({ status: 'posted', message_id: refs[0]?.messageId ?? null, options: options.length }) };
  },
};

export const TOOLS: readonly ToolSpec[] = [pollCreate];
