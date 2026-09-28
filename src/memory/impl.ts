// memory/impl.ts (WP6a) — links a Services object to the memory store, so the static TOOLS (which only see ctx.services)
// can use the synchronous selection / scope helpers that are not part of the MemoryService contract.
import type { Services } from '../contracts/services.ts';
import type { MemoryStore } from './store.ts';

const IMPLS = new WeakMap<object, MemoryStore>();
export function bindStore(s: Services, st: MemoryStore): void {
  IMPLS.set(s, st);
}
export function storeOf(s: Services): MemoryStore | undefined {
  return IMPLS.get(s);
}
