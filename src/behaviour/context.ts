// behaviour/context.ts (friend set B, spec 05 C3) — the `behaviour` context provider: one `<user_model>` line
// `style: reply_length=… emoji=… register=… lang=…` from the learned hints, with the owner's explicit settings.style
// overriding field by field. Private surfaces only; nothing when neither hints nor overrides exist.
import type { ContextProvider, Services } from '../contracts/index.ts';
import { styleLine } from './style.ts';

export function createBehaviourContext(s: Services): ContextProvider {
  return {
    name: 'behaviour',
    surfaces: ['dm', 'topic', 'mission'],
    async parts(conv, run) {
      const userId = run.userId ?? conv.userId;
      if (!userId) return [];
      const line = styleLine(s.signals.styleHints(userId), s.repos.users.settings(userId).style);
      return line ? [{ key: 'user_model', lines: [line] }] : [];
    },
  };
}
