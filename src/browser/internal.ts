// browser/internal.ts (s07 BR) — the module-private handle the browser tools use. Tools are a static TOOLS array that
// only sees ctx.services, so createBrowserModule registers its task core here, keyed by the Services object (the same
// pattern as missions/internal.ts). Nothing outside src/browser/ imports this file.
import type { Services } from '../contracts/index.ts';
import type { TaskCore } from './tasks.ts';

const registry = new WeakMap<Services, TaskCore>();

export function registerBrowserInternals(s: Services, core: TaskCore): void {
  registry.set(s, core);
}
export function browserInternals(s: Services): TaskCore | undefined {
  return registry.get(s);
}
