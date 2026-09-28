// reminders/callbacks.ts (WP6a) — `rm:<id>:d|10|60|tm` (the fired reminder's buttons) and `td:<todoId>` (to-do toggles,
// re-rendered in place with editMessageText(rich_message), 01 F6).
import type { Scope } from '../contracts/common.ts';
import { parseScopeKey } from '../contracts/common.ts';
import type { CallbackAnswer, CallbackCtx } from '../contracts/telegram.ts';
import type { Services } from '../contracts/services.ts';
import { uiLang } from '../contracts/i18n.ts';
import { errorMessage } from '../kernel/errors.ts';
import { addDaysToDate, formatDisplay, wallTimeOf, zonedToInstant } from '../kernel/timeMath.ts';
import type { ReminderServiceImpl } from './service.ts';
import { ReminderError } from './service.ts';
import type { TodoServiceImpl } from './todos.ts';

const T = {
  done: { en: '✓ Done', ru: '✓ Готово' },
  snoozed: { en: '⏰ Snoozed until {when}', ru: '⏰ Отложено до {when}' },
  gone: { en: 'This reminder no longer exists.', ru: 'Этого напоминания больше нет.' },
  notYours: { en: 'This isn’t yours.', ru: 'Это не ваше.' },
  todoGone: { en: 'This item is no longer on the list.', ru: 'Этого пункта больше нет в списке.' },
} as const;
const tr = (k: keyof typeof T, lang: string | null | undefined, vars: Record<string, string> = {}) =>
  T[k][uiLang(lang)].replace(/\{(\w+)\}/g, (m, v: string) => vars[v] ?? m);

/** "Tomorrow": the reminder's own local time of day, on the next local day (DST-aware); at least one minute ahead. */
export function tomorrowAt(base: number, now: number, tz: string): number {
  const b = wallTimeOf(base, tz);
  const today = wallTimeOf(now, tz);
  let d = addDaysToDate(today.year, today.month, today.day, 1);
  let at = zonedToInstant({ ...d, hour: b.hour, minute: b.minute }, tz).instant;
  if (at <= now + 60_000) {
    d = addDaysToDate(d.year, d.month, d.day, 1);
    at = zonedToInstant({ ...d, hour: b.hour, minute: b.minute }, tz).instant;
  }
  return at;
}

export function registerReminderCallbacks(s: Services, reminders: ReminderServiceImpl, todos: TodoServiceImpl): void {
  const log = () => s.log.child({ mod: 'reminders' });

  const clearButtons = (c: CallbackCtx): void => {
    if (!c.message) return;
    s.telegram.outbox.enqueue({
      idempotencyKey: `rmclr:${c.message.chatId}:${c.message.messageId}:${c.callbackQueryId}`,
      ...(c.user ? { userId: c.user.id } : {}),
      chatId: c.message.chatId,
      method: 'editMessageReplyMarkup',
      payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: [] } },
      priority: 0,
    });
  };

  const allowed = (scope: Scope, c: CallbackCtx): boolean => (scope.kind === 'user' ? c.user?.id === scope.userId : true);

  s.telegram.callbacks.register('rm', async (c): Promise<CallbackAnswer> => {
    const lang = c.user?.languageCode;
    const [id, action] = c.parts;
    const r = id ? reminders.repo().getReminder(id) : undefined;
    const scope = r ? parseScopeKey(r.scope) : null;
    if (!r || !scope) return { text: tr('gone', lang) };
    if (!allowed(scope, c)) return { text: tr('notYours', lang), alert: true };
    try {
      const now = s.clock.now();
      if (action === 'd') {
        reminders.markDone(r.id, scope);
        clearButtons(c);
        return { text: tr('done', lang) };
      }
      let at: number;
      if (action === '10') at = now + 10 * 60_000;
      else if (action === '60') at = now + 60 * 60_000;
      else if (action === 'tm') at = tomorrowAt(r.scheduleKind === 'once' && r.fireAt ? r.fireAt : now, now, r.tz);
      else return { text: tr('gone', lang) };
      reminders.snoozeUntil(r.id, scope, at);
      clearButtons(c);
      return { text: tr('snoozed', lang, { when: formatDisplay(at, r.tz, lang ?? 'en') }) };
    } catch (e) {
      if (e instanceof ReminderError) return { text: e.message.slice(0, 180) };
      log().warn({ reminderId: r.id, err: errorMessage(e) }, 'rm callback failed');
      throw e;
    }
  });

  s.telegram.callbacks.register('td', async (c): Promise<CallbackAnswer> => {
    const lang = c.user?.languageCode;
    const [id] = c.parts;
    const t = id ? todos.repo().getTodo(id) : undefined;
    const scope = t ? parseScopeKey(t.scope) : null;
    if (!t || !scope) return { text: tr('todoGone', lang) };
    if (!allowed(scope, c)) return { text: tr('notYours', lang), alert: true };
    todos.toggle(t.id, scope);
    if (c.message) {
      const now = s.clock.now();
      todos.repo().recordTodoMessage(t.scope, c.message.chatId, c.message.messageId, now);
      const view = todos.render(scope, lang ?? 'en');
      s.telegram.outbox.enqueue({
        idempotencyKey: `td:${c.message.chatId}:${c.message.messageId}:${c.callbackQueryId}`,
        ...(c.user ? { userId: c.user.id } : {}),
        chatId: c.message.chatId,
        method: 'editMessageText',
        payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: view.buttons } },
        markdown: view.markdown,
        priority: 0,
      });
    }
    return;
  });
}
