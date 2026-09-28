// tools/impl/react.ts (WP5) — react (01 §6): one setMessageReaction on the trigger message, through the outbox.
import { z } from 'zod';
import type { ToolSpec } from '../../contracts/index.ts';
import { FULL_GROUP_SURFACES, L, toolError, UI } from './common.ts';

export const REACTIONS = ['👍', '👌', '✍', '🙏', '🫡', '❤', '🔥', '🎉', '👀'] as const;
const input = z.object({ emoji: z.enum(REACTIONS) });
type In = z.infer<typeof input>;

export const reactTool: ToolSpec<In> = {
  name: 'react',
  description: 'React with an emoji. Call instead of a short text reply.',
  input,
  surfaces: FULL_GROUP_SURFACES,
  parallelSafe: true,
  classify: () => UI,
  statusLabel: () => '',
  async execute(i, ctx) {
    const messageId = ctx.chat.triggerMessageId;
    if (!messageId) return toolError('NO_MESSAGE', 'there is no user message to react to in this run');
    ctx.services.telegram.outbox.enqueue({
      idempotencyKey: `react:${ctx.idemKey}`,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      chatId: ctx.chat.chatId,
      ...(ctx.chat.businessConnectionId ? { businessConnectionId: ctx.chat.businessConnectionId } : {}),
      method: 'setMessageReaction',
      payload: { message_id: messageId, reaction: [{ type: 'emoji', emoji: i.emoji }] },
      priority: 1,
    });
    return { content: `reacted ${i.emoji}` };
  },
};
