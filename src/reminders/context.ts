// reminders/context.ts (WP6a) — the "next reminders" item of the `open` context line (01 §5.9), for the run's scope.
import type { ContextPart, ContextProvider } from '../contracts/agent.ts';
import type { Scope } from '../contracts/common.ts';
import type { ConversationRow } from '../contracts/storage.ts';
import { neutralizeReservedTags } from '../kernel/tags.ts';
import type { ReminderServiceImpl } from './service.ts';

export const CONTEXT_REMINDERS = 3;

export function scopeOfConversation(conv: ConversationRow): Scope | null {
  if (conv.kind === 'group') return conv.tgChatId !== null ? { kind: 'group', chatId: conv.tgChatId } : null;
  if (conv.kind === 'dm' || conv.kind === 'topic' || conv.kind === 'mission') return conv.userId ? { kind: 'user', userId: conv.userId } : null;
  return null;
}

export function createReminderContext(svc: ReminderServiceImpl): ContextProvider {
  return {
    name: 'reminders',
    surfaces: ['dm', 'topic', 'mission', 'group'],
    async parts(conv): Promise<ContextPart[]> {
      const scope = scopeOfConversation(conv);
      if (!scope) return [];
      const next = svc.list(scope, false).filter((r) => r.status !== 'paused').slice(0, CONTEXT_REMINDERS);
      if (!next.length) return [];
      const items = next.map((r) => {
        const text = neutralizeReservedTags(r.text.replace(/\s+/g, ' '));
        return `${r.id} ${r.display.replace(/ · cron .*$/, '')} ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`;
      });
      return [{ key: 'open', lines: [`next reminders [${items.join(' · ')}]`] }];
    },
  };
}
