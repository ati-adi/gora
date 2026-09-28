// kernel/registries.ts (WP0) — small registries used by the composition root and modules:
// callbacks (by CallbackKind), and ordered named registries (context providers, privacy hooks).
import type { Logger } from '../contracts/common.ts';
import type { CallbackAnswer, CallbackCtx, CallbackKind, CallbackRegistry } from '../contracts/telegram.ts';

export function createCallbackRegistry(log?: Logger): CallbackRegistry & { kinds(): CallbackKind[] } {
  const handlers = new Map<CallbackKind, (c: CallbackCtx) => Promise<CallbackAnswer>>();
  return {
    register(kind, h) {
      if (handlers.has(kind)) throw new Error(`callback kind already registered: ${kind}`);
      handlers.set(kind, h);
    },
    async dispatch(c) {
      const h = handlers.get(c.kind);
      if (!h) {
        log?.warn({ kind: c.kind }, 'no callback handler');
        return { text: 'This button is no longer active.' };
      }
      return h(c);
    },
    kinds: () => [...handlers.keys()],
  };
}

/** Insertion-ordered registry of named items; duplicate names throw. */
export class NamedRegistry<T extends { name: string }> {
  private items: T[] = [];
  add(item: T): void {
    if (this.items.some((x) => x.name === item.name)) throw new Error(`duplicate registration: ${item.name}`);
    this.items.push(item);
  }
  list(): readonly T[] {
    return this.items;
  }
  get(name: string): T | undefined {
    return this.items.find((x) => x.name === name);
  }
}

/** Adds to a plain array (Services.contextProviders / privacyHooks) with the same duplicate check. */
export function registerNamed<T extends { name: string }>(arr: T[], item: T): void {
  if (arr.some((x) => x.name === item.name)) throw new Error(`duplicate registration: ${item.name}`);
  arr.push(item);
}
