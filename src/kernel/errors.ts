// kernel/errors.ts (WP0) — shared error classes. Erasable TS only: fields are declared, then assigned.

export class GoraError extends Error {
  override name = 'GoraError';
}

/** Thrown by WP0 stubs until the owning work package replaces them. */
export class NotBuiltError extends GoraError {
  override name = 'NotBuiltError';
  readonly wp: string;
  constructor(wp: string, what?: string) {
    super(`Not built yet: ${wp}${what ? ` (${what})` : ''}`);
    this.wp = wp;
  }
}
/** `return NotBuilt('WP3')` in a stub factory: always throws, typed `never` so it satisfies any return type. */
export function NotBuilt(wp: string, what?: string): never {
  throw new NotBuiltError(wp, what);
}
export function isNotBuilt(e: unknown): e is NotBuiltError {
  return e instanceof NotBuiltError;
}

export class ConfigError extends GoraError {
  override name = 'ConfigError';
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

/** Test harness: global fetch is replaced by a function that throws this. */
export class NetworkDisabledError extends GoraError {
  override name = 'NetworkDisabledError';
  constructor(url?: string) {
    super(`Network access is disabled in tests${url ? ` (${safeHost(url)})` : ''}; inject a fetchImpl`);
  }
}

/** Crypto: the DEK was destroyed (crypto-shred); it can never be re-created. */
export class DekDestroyedError extends GoraError {
  override name = 'DekDestroyedError';
  readonly dekId: string;
  constructor(dekId: string) {
    super(`DEK destroyed: ${dekId}`);
    this.dekId = dekId;
  }
}

// ── LLM transport errors (01 §4.4 llm.ts, 03 R1)
/** The call was aborted (Stop, shutdown). Nothing from that call is persisted. */
export class AbortedError extends GoraError {
  override name = 'AbortedError';
  readonly reason: string;
  constructor(reason = 'aborted') {
    super(`Aborted: ${reason}`);
    this.reason = reason;
  }
}
export type TransientKind = 'rate_limit' | 'overloaded' | 'server' | 'connection';
/** 429 / 529 / 5xx / connection — retry later (01 §5.8). */
export class TransientLlmError extends GoraError {
  override name = 'TransientLlmError';
  readonly kind: TransientKind;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  constructor(kind: TransientKind, message?: string, o?: { retryAfterMs?: number | null; requestId?: string | null }) {
    super(message ?? `Transient LLM error: ${kind}`);
    this.kind = kind;
    this.retryAfterMs = o?.retryAfterMs ?? null;
    this.requestId = o?.requestId ?? null;
  }
}
/** 400 — treated as a bug, except the handled cases (system role unsupported, 03 R2 'prompt_budget'). */
export class BadRequestLlmError extends GoraError {
  override name = 'BadRequestLlmError';
  readonly requestId: string | null;
  /** Machine code when known: 'prompt_budget' (03 R2), 'system_role_unsupported', 'tool_use_failed', 'too_large' (Groq 413 twice). */
  readonly code: string | null;
  constructor(message: string, requestId: string | null = null, code: string | null = null) {
    super(message);
    this.requestId = requestId;
    this.code = code;
  }
}
/** Eager-input streaming produced partial JSON that failed to parse (01 §5.8). */
export class JsonInputError extends GoraError {
  override name = 'JsonInputError';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
