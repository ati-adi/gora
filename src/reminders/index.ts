// reminders/index.ts (WP6a) — createReminderModule: ReminderService + TodoService, the reminder_fire / checkin_fire job
// handlers, the rm:/td: callbacks, the "next reminders" context, the to-do message hook and the privacy hook.
import type { ReminderModule, Services } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { registerNamed } from '../kernel/registries.ts';
import { registerReminderCallbacks } from './callbacks.ts';
import { createReminderContext } from './context.ts';
import { createFireHandlers } from './fire.ts';
import { bindImpls } from './impl.ts';
import { createReminderService } from './service.ts';
import { createTodoService } from './todos.ts';

/** todo_messages rows (which messages show a list) are kept this long. */
const TODO_MESSAGE_RETENTION_MS = 30 * 86_400_000;

export function createReminderModule(s: Services): ReminderModule {
  const reminders = createReminderService(s);
  const todos = createTodoService(s);
  bindImpls(s, { reminders, todos });

  const fire = createFireHandlers(s, reminders);
  s.scheduler.register('reminder_fire', fire.reminderFire);
  s.scheduler.register('checkin_fire', fire.checkinFire);
  registerReminderCallbacks(s, reminders, todos);
  registerNamed(s.contextProviders, createReminderContext(reminders));

  // A channel that renders a `todo_list` effect sends it with refKind 'todo' and refId = the scope key; the sent message
  // is remembered so its toggles re-render in place.
  s.telegram.outbox.onSent('todo', (refId, sent) => {
    try {
      for (const m of sent) reminders.repo().recordTodoMessage(refId, m.chatId, m.messageId, s.clock.now());
    } catch (e) {
      s.log.warn({ mod: 'reminders', err: errorMessage(e) }, 'todo message record failed');
    }
  });

  s.privacyHooks.push({
    name: 'reminders',
    async onDeleteUser(userId) {
      // WP1 deletes the rows (USER_DATA_TABLES); cancelling the jobs first stops a firing racing the deletion.
      for (const r of reminders.repo().remindersOfUser(userId)) {
        s.scheduler.cancel(`rem:${r.id}`);
        s.scheduler.cancel(`rem:${r.id}:snz`);
      }
    },
    async exportUser(userId) {
      return {
        reminders: reminders.repo().remindersOfUser(userId).map((r) => ({
          id: r.id, kind: r.kind, text: r.text, scope: r.scope.startsWith('user:') ? 'personal' : 'group', schedule: r.scheduleKind,
          fireAt: r.fireAt === null ? null : new Date(r.fireAt).toISOString(), cron: r.cron, tz: r.tz, status: r.status,
          createdAt: new Date(r.createdAt).toISOString(),
        })),
        todos: reminders.repo().todosOfUser(userId).map((t) => ({ id: t.id, text: t.text, done: t.done, createdAt: new Date(t.createdAt).toISOString() })),
      };
    },
    async retentionSweep(now) {
      reminders.repo().purgeTodoMessages(now - TODO_MESSAGE_RETENTION_MS);
      // Group to-dos / reminders whose DEK the surfaces retention destroyed (the bot left the group) are unreadable orphans.
      for (const scope of reminders.repo().shreddedGroupScopes()) reminders.repo().purgeOrphans(scope, now);
    },
  });

  return { reminders, todos };
}
