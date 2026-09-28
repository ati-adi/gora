// tools/impl/choices.ts (WP5) — offer_choices (01 §6): buttons `ch:<setId>:<i>`; a tap becomes owner input (WP7 handles it).
import type { InlineKeyboardButton } from 'grammy/types';
import { z } from 'zod';
import type { ToolSpec } from '../../contracts/index.ts';
import { FULL_GROUP_SURFACES, L, toolError, UI } from './common.ts';

const input = z.object({ options: z.array(z.object({ label: z.string().min(1).max(40) })).min(2).max(6) });
type In = z.infer<typeof input>;
export const CHOICE_TTL_MS = 24 * 60 * 60 * 1000;

export const choicesTool: ToolSpec<In> = {
  name: 'offer_choices',
  description: 'Show 2-6 reply buttons when the user must pick one.',
  input,
  surfaces: FULL_GROUP_SURFACES,
  parallelSafe: true,
  classify: () => UI,
  statusLabel: (_i, lang) => L(lang, '🔘 Preparing options…', '🔘 Готовлю варианты…'),
  async execute(i, ctx) {
    const s = ctx.services;
    const labels = i.options.map((o) => o.label.trim()).filter((x) => x.length > 0);
    if (labels.length < 2) return toolError('INVALID_INPUT', 'at least two non-empty options are needed');
    const setId = s.choices.create({ userId: ctx.userId, conversationId: ctx.conversationId, chatId: ctx.chat.chatId, options: labels, ttlMs: CHOICE_TTL_MS });
    const owner = ctx.surface === 'group' ? 0 : (ctx.tgUserId ?? 0);
    const buttons: InlineKeyboardButton[] = labels.map((label, idx) => ({ text: label, callback_data: s.telegram.codec.encode('ch', [setId, String(idx)], owner) }));
    const rows: InlineKeyboardButton[][] = [];
    for (let k = 0; k < buttons.length; k += 2) rows.push(buttons.slice(k, k + 2));
    ctx.effects.push({ kind: 'buttons', rows });
    return { content: `buttons shown: ${labels.join(' | ')}; stop and wait for the tap` };
  },
};
