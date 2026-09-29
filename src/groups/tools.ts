// groups/tools.ts (GR, spec 07 C6) — group_invite_link {} (surfaces dm/topic, class ui, toolkit 'account'): a url button
// https://t.me/<bot>?startgroup=g&admin= (the add-to-group picker; no admin rights requested) under the reply, and a
// short tool result telling the model to say one line. Idempotent: no side effect besides the button.
import { z } from 'zod';
import type { ToolSpec } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import { addToGroupUrl } from './strings.ts';

const input = z.object({}).strict();
export type GroupInviteInput = z.infer<typeof input>;

const BUTTON = { en: '➕ Add Gora to a group', ru: '➕ Добавить Гору в группу' } as const;

export const groupInviteLink: ToolSpec<GroupInviteInput> = {
  name: 'group_invite_link',
  description: 'Call when the owner talks about a group chat of friends, family or colleagues where Gora could help (planning together, remembering group plans). Shows a button that adds Gora to a group they pick. Say one short line; never paste the link.',
  input,
  surfaces: ['dm', 'topic'],
  parallelSafe: true,
  classify: () => ({ actionClass: 'ui', risk: 0 }),
  statusLabel: (_i, lang) => (uiLang(lang) === 'ru' ? 'Готовлю ссылку' : 'Preparing the link'),
  async execute(_i, ctx) {
    if (!ctx.services.config.features.groups) return { content: JSON.stringify({ error: 'GROUPS_OFF', message: 'group chats are turned off on this server' }), isError: true };
    const username = ctx.services.telegram.botInfo.username;
    const url = addToGroupUrl(username);
    return {
      content: JSON.stringify({ status: 'button_attached', note: 'An "add to group" button is attached under your reply. Say ONE short friendly line; do not paste the link.' }),
      effects: [{ kind: 'buttons', rows: [[{ text: BUTTON[uiLang(ctx.lang)], url }]] }],
    };
  },
};

export const TOOLS: readonly ToolSpec[] = Object.freeze([groupInviteLink]);
