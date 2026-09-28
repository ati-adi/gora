// reminders/todos.ts (WP6a) — TodoService (01 F6): a personal list (user scope) or a group list (group scope), rendered
// as a Rich Markdown task list (`- [ ]` / `- [x]`) with `td:<id>` toggle buttons.
import type { InlineKeyboardButton } from 'grammy/types';
import type { Scope, UserId } from '../contracts/common.ts';
import { scopeKey } from '../contracts/common.ts';
import type { TodoService, TodoView } from '../contracts/proactive.ts';
import type { Services } from '../contracts/services.ts';
import { uiLang } from '../contracts/i18n.ts';
import { createReminderRepo, type ReminderRepo, type TodoRow } from './repo.ts';
import { ReminderError } from './service.ts';

export const MAX_TODO_TEXT = 200;
export const MAX_OPEN_TODOS = 100;
export const KEEP_DONE_TODOS = 30;
export const MAX_TODO_BUTTONS = 20;

export interface TodoServiceImpl extends TodoService {
  repo(): ReminderRepo;
  /** Resolves an id (`T…`) or a 1-based list number to an item of the scope. */
  resolve(scope: Scope, ref: string): TodoRow | undefined;
}

export function createTodoService(s: Services): TodoServiceImpl {
  let repoCache: ReminderRepo | null = null;
  const repo = (): ReminderRepo => (repoCache ??= createReminderRepo(s.db, s.crypto));

  const views = (scope: Scope): TodoView[] => repo().listTodos(scopeKey(scope)).map((t, i) => ({ id: t.id, text: t.text, done: t.done, position: i + 1 }));

  const resolve = (scope: Scope, ref: string): TodoRow | undefined => {
    const sk = scopeKey(scope);
    const r = ref.trim();
    if (/^\d{1,3}$/.test(r)) {
      const n = Number(r);
      const t = repo().listTodos(sk)[n - 1];
      return t;
    }
    const t = repo().getTodo(r.toUpperCase()) ?? repo().getTodo(r);
    return t && t.scope === sk ? t : undefined;
  };
  const must = (scope: Scope, ref: string | undefined): TodoRow => {
    if (!ref) throw new ReminderError('bad_input', 'id is required for this action');
    const t = resolve(scope, ref);
    if (!t) throw new ReminderError('not_found', `No to-do ${ref} in this list`);
    return t;
  };

  const ownerTgOf = (scope: Scope): number => {
    if (scope.kind === 'group') return 0; // any member of the group may tick the shared list
    return s.repos.users.getById(scope.userId)?.tgUserId ?? 0;
  };

  const svc: TodoServiceImpl = {
    repo,
    resolve,
    apply(scope, authorUserId: UserId | null, a) {
      const sk = scopeKey(scope);
      const now = s.clock.now();
      switch (a.action) {
        case 'add': {
          const text = (a.text ?? '').replace(/\s+/g, ' ').trim();
          if (!text) throw new ReminderError('bad_input', 'text is required to add a to-do');
          if (text.length > MAX_TODO_TEXT) throw new ReminderError('bad_input', `to-do text is longer than ${MAX_TODO_TEXT} characters`);
          // Idempotent: an identical open item is not added twice (a retried tool call, or "add milk" said twice).
          if (repo().listTodos(sk).some((t) => !t.done && t.text.toLowerCase() === text.toLowerCase())) break;
          if (repo().countOpenTodos(sk) >= MAX_OPEN_TODOS) throw new ReminderError('too_many', `the list already has ${MAX_OPEN_TODOS} open items`);
          repo().insertTodo(sk, authorUserId, text, now);
          break;
        }
        case 'complete':
          repo().setTodoDone(must(scope, a.id).id, true, now);
          repo().pruneDone(sk, KEEP_DONE_TODOS);
          break;
        case 'reopen':
          repo().setTodoDone(must(scope, a.id).id, false, now);
          break;
        case 'remove':
          repo().deleteTodo(must(scope, a.id).id);
          break;
        case 'list':
          break;
      }
      return views(scope);
    },
    toggle(id, scope) {
      const t = must(scope, id);
      repo().setTodoDone(t.id, !t.done, s.clock.now());
      return views(scope);
    },
    setDone(id, scope, done) {
      const t = must(scope, id);
      repo().setTodoDone(t.id, done, s.clock.now());
      return views(scope);
    },
    render(scope, lang) {
      const list = views(scope);
      const ru = uiLang(lang) === 'ru';
      const esc = (x: string) => s.telegram.render.escape(x);
      const title = scope.kind === 'group' ? (ru ? '**Список группы**' : '**Group list**') : ru ? '**Мои дела**' : '**To-dos**';
      const lines = list.length ? list.map((t) => `- [${t.done ? 'x' : ' '}] ${esc(t.text)}`) : [ru ? '_Список пуст._' : '_The list is empty._'];
      const owner = ownerTgOf(scope);
      const buttons: InlineKeyboardButton[][] = [];
      let row: InlineKeyboardButton[] = [];
      for (const t of list.slice(0, MAX_TODO_BUTTONS)) {
        row.push({ text: `${t.done ? '✅' : '☐'} ${t.position}`, callback_data: s.telegram.codec.encode('td', [t.id], owner) });
        if (row.length === 5) {
          buttons.push(row);
          row = [];
        }
      }
      if (row.length) buttons.push(row);
      return { markdown: `${title}\n${lines.join('\n')}`, buttons };
    },
  };
  return svc;
}
