// ── contracts/common.ts (WP0, frozen) — 01 §4.4
export type UserId = string; // ULID
export type Ms = number;
export type Surface = 'dm' | 'topic' | 'mission' | 'group' | 'guest' | 'biz_draft';
export type Route = 'chat' | 'mission' | 'group' | 'guest' | 'biz';
export type ToolsetId = 'FULL' | 'GROUP' | 'GUEST' | 'BIZ';
export type ChannelKind = 'dm_stream' | 'notify' | 'group' | 'guest' | 'biz_owner';
export type Scope = { kind: 'user'; userId: UserId } | { kind: 'group'; chatId: number };
export type TaintSource = 'web' | 'email' | 'calendar' | 'business_peer' | 'forward' | 'group_member' | 'guest' | 'file' | 'import' | 'derived';
export type PlanId = 'free' | 'plus' | 'pro';
export type PermissionLevel = 'none' | 'read' | 'draft' | 'act';

export interface Clock {
  now(): Ms;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Friend-mode addition (spec 05 §E): the only source of randomness in src/ (no Math.random; importRules
 * 'no-math-random'). kernel/random.ts has systemRandom() (crypto) and seededRandom(seed) (tests, deterministic);
 * Services.random carries the instance (createApp's `random` option, the seeded one in the test harness).
 */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export interface Logger {
  debug(o: object, m?: string): void;
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
  child(b: object): Logger;
}

/** Scope key helpers shared by every module that stores scoped rows ('user:<id>' | 'grp:<chatId>'). */
export function scopeKey(s: Scope): string {
  return s.kind === 'user' ? `user:${s.userId}` : `grp:${s.chatId}`;
}
export function parseScopeKey(k: string): Scope | null {
  if (k.startsWith('user:')) return { kind: 'user', userId: k.slice(5) };
  if (k.startsWith('grp:')) {
    const n = Number(k.slice(4));
    return Number.isSafeInteger(n) ? { kind: 'group', chatId: n } : null;
  }
  return null;
}
