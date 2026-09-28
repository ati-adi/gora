// missions/internal.ts (WP6b) — the module-private handle the mission/watcher tools use (tools are a static TOOLS
// array that only sees ctx.services, so the factory registers its internals here, keyed by the Services object).
import { createHash } from 'node:crypto';
import type { Services, TaintSource, UserId, WatchCondition } from '../contracts/index.ts';
import { CROCKFORD } from '../kernel/ids.ts';

export interface MissionInternals {
  startWithId(id: string, p: { userId: UserId; tgUserId: number; title: string; goal: string; criteria: string[]; deadlineLocal?: string; budgetUsd?: number; taint: TaintSource[] }): Promise<{ missionId: string; threadId: number | null; conversationId: string; created: boolean }>;
  createWatcherWithId(id: string, p: { userId: UserId; missionId?: string; kind: 'page' | 'inbox'; target: string; condition: WatchCondition; intervalMin: number; threadId?: number }): Promise<{ id: string; created: boolean; note: string | null }>;
  ownerOf(missionId: string): UserId | null;
  budgetCapUsd(userId: UserId): number;
  watcherMinInterval(userId: UserId): number;
}

const registry = new WeakMap<Services, MissionInternals>();

export function registerInternals(s: Services, i: MissionInternals): void {
  registry.set(s, i);
}
export function internalsOf(s: Services): MissionInternals | undefined {
  return registry.get(s);
}

/** Deterministic short id ('M'/'W' + 6 Crockford chars) from the owner and the tool call's idempotency key. */
export function deterministicId(prefix: 'M' | 'W', userId: string, idemKey: string): string {
  const h = createHash('sha256').update(`${prefix}|${userId}|${idemKey}`).digest();
  let out = prefix;
  for (let i = 0; i < 6; i++) out += CROCKFORD[h[i]! % 32];
  return out;
}
