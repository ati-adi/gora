// tools/toolsets.ts (WP5) — the frozen toolset memberships of 01 §6 (hashes asserted by tests).
import type { ToolsetId } from '../contracts/index.ts';
import { TOOL_OWNERS } from '../contracts/tools.ts';

/** GROUP, GUEST and BIZ are listed exactly as in 01 §6. */
export const GROUP_TOOLS: readonly string[] = Object.freeze([
  'fx_convert', 'memory_forget', 'memory_save', 'memory_search', 'offer_choices', 'poll_create', 'react', 'reminder_create', 'reminder_list',
  'reminder_manage', 'share_place', 'time_resolve', 'todo_manage', 'weather_get', 'web_fetch', 'web_search',
]);
export const GUEST_TOOLS: readonly string[] = Object.freeze(['fx_convert', 'time_resolve', 'weather_get', 'web_fetch', 'web_search']);
export const BIZ_TOOLS: readonly string[] = Object.freeze(['business_draft_reply', 'time_resolve']);

/** FULL: every catalog tool except poll_create (use_toolkit only in toolkits mode, 03 R3). */
export const FULL_TOOLS: readonly string[] = Object.freeze(Object.keys(TOOL_OWNERS).filter((n) => n !== 'poll_create').sort());

export const TOOLSET_MEMBERS: Readonly<Record<ToolsetId, readonly string[]>> = Object.freeze({
  FULL: FULL_TOOLS,
  GROUP: GROUP_TOOLS,
  GUEST: GUEST_TOOLS,
  BIZ: BIZ_TOOLS,
});

/** web_search / web_fetch max_uses per toolset (01 §6; the Groq executor enforces the same numbers, 03 R4). */
export const WEB_MAX_USES: Readonly<Record<ToolsetId, { search: number; fetch: number }>> = Object.freeze({
  FULL: { search: 5, fetch: 5 },
  GROUP: { search: 3, fetch: 2 },
  GUEST: { search: 3, fetch: 2 },
  BIZ: { search: 0, fetch: 0 },
});

/** eager_input_streaming only on these two (01 §6). */
export const EAGER_INPUT_TOOLS: ReadonlySet<string> = new Set(['gmail_create_draft', 'business_draft_reply']);
