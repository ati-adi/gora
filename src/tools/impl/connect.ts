// tools/impl/connect.ts (WP5) — integration_connect (01 §6, F9): sends the Connect card (url button) saying what will be read.
import { z } from 'zod';
import type { ToolSpec } from '../../contracts/index.ts';
import { errorMessage } from '../../kernel/errors.ts';
import { FULL_SURFACES, L, ownerOf, toolError, UI } from './common.ts';

const input = z.object({ integration: z.enum(['gmail', 'gcal']), reason: z.string().min(1).max(200).describe('What you will read and why, shown on the card') });
type In = z.infer<typeof input>;

export const connectTool: ToolSpec<In> = {
  name: 'integration_connect',
  description: 'Send a Connect button for Gmail or Google Calendar. Call when a task needs mail or calendar and it is not connected.',
  input,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => UI,
  statusLabel: (i, lang) => L(lang, `🔗 Preparing ${i.integration === 'gmail' ? 'Gmail' : 'Calendar'} connect…`, `🔗 Готовлю подключение ${i.integration === 'gmail' ? 'Gmail' : 'Календаря'}…`),
  async execute(i, ctx) {
    const s = ctx.services;
    const userId = ownerOf(ctx);
    if (!userId || ctx.scope?.kind !== 'user') return toolError('NOT_ALLOWED', 'integrations can only be connected by the owner in a private chat');
    if (s.integrations.status(userId)[i.integration].connected) return { content: `${i.integration} is already connected` };
    try {
      await s.integrations.sendConnectCard(userId, i.integration, { chatId: ctx.chat.chatId, ...(ctx.chat.threadId !== undefined ? { threadId: ctx.chat.threadId } : {}) }, i.reason);
    } catch (e) {
      ctx.log.warn({ tool: 'integration_connect', err: errorMessage(e) }, 'connect card failed');
      return toolError('CONNECT_UNAVAILABLE', 'connecting is not available right now');
    }
    return { content: `Connect card for ${i.integration} sent; the user must tap it. Do not retry the task until it is connected.` };
  },
};
