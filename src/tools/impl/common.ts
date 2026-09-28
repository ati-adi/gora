// tools/impl/common.ts (WP5) — small helpers shared by WP5's tool specs.
import type { Classification, ToolCtx, ToolOutput, UserId } from '../../contracts/index.ts';

/** Picks the Russian label for ru*, English otherwise (statusLabel strings are short and tool-local). */
export function L(lang: string, en: string, ru: string): string {
  return lang.toLowerCase().startsWith('ru') ? ru : en;
}

export const READ_PUBLIC: Classification = Object.freeze({ actionClass: 'read_public', risk: 0 });
export const UI: Classification = Object.freeze({ actionClass: 'ui', risk: 0 });
export const CONTROL: Classification = Object.freeze({ actionClass: 'control', risk: 0 });

/** A clean is_error result (content is JSON so the model sees a stable shape). */
export function toolError(code: string, message: string, extra: Record<string, unknown> = {}): ToolOutput<never> {
  return { content: JSON.stringify({ error: code, message, ...extra }), isError: true };
}

export function ok<O>(data: O, content?: string): ToolOutput<O> {
  return { content: content ?? JSON.stringify(data), data };
}

/** The owner of a DM-scoped tool call; null in guest/group runs without a user. */
export function ownerOf(ctx: ToolCtx): UserId | null {
  if (ctx.userId) return ctx.userId;
  if (ctx.scope?.kind === 'user') return ctx.scope.userId;
  return null;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Rounds a coordinate to 0.1° (privacy, 01 F4). */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Surfaces of the FULL toolset (DM, topics, missions). */
export const FULL_SURFACES = ['dm', 'topic', 'mission'] as const;
/** FULL + GROUP. */
export const FULL_GROUP_SURFACES = ['dm', 'topic', 'mission', 'group'] as const;
/** FULL + GROUP + GUEST. */
export const PUBLIC_SURFACES = ['dm', 'topic', 'mission', 'group', 'guest'] as const;

/**
 * A side-effecting provider call whose outcome is unknown (the request may have reached Google: timeout, network error,
 * HTTP 5xx/408, unreadable response). Tools THROW it instead of returning is_error, so the executor runs reconcile()
 * (approvals) and the model is told not to retry blindly (a retry with a new idempotency key would duplicate).
 */
export class OutcomeUnknownError extends Error {
  constructor(tool: string, cause: unknown) {
    super(`${tool}: the provider did not confirm the result (${errText(cause).slice(0, 80)}); it may have happened. Do not retry; tell the user to check.`);
    this.name = 'OutcomeUnknownError';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * True when a provider error leaves the outcome of a write unknown. Definite failures: an explicit HTTP 4xx (not 408),
 * "not supported by provider", "not found", or Composio's `successful:false` ("<op> failed"). Everything else —
 * HTTP 5xx/408, timeouts/aborts, network errors, a response that could not be parsed — is ambiguous.
 */
export function isAmbiguousProviderError(e: unknown): boolean {
  if (e instanceof OutcomeUnknownError) return true;
  const m = errText(e);
  const http = /\bHTTP (\d{3})\b/.exec(m);
  if (http) {
    const code = Number(http[1]);
    return code >= 500 || code === 408;
  }
  if (/not supported by provider|not found|\bgone\b/i.test(m)) return false;
  if (/^\w+ failed$/.test(m)) return false;
  return true;
}
