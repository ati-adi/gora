// reminders/impl.ts (WP6a) — links a Services object to this module's implementation objects, so the static TOOLS
// (which only see ctx.services) can reach the non-contract methods (restore/snapshot for Undo, to-do resolution).
import type { Services } from '../contracts/services.ts';
import type { ReminderServiceImpl } from './service.ts';
import type { TodoServiceImpl } from './todos.ts';

export interface ReminderImpls { reminders: ReminderServiceImpl; todos: TodoServiceImpl }
const IMPLS = new WeakMap<object, ReminderImpls>();

export function bindImpls(s: Services, i: ReminderImpls): void {
  IMPLS.set(s, i);
}
export function implsOf(s: Services): ReminderImpls | undefined {
  return IMPLS.get(s);
}
