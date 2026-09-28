// tools/toolkits.ts (WP5) — 03 R3 named toolkits over FULL (request building only; `core` is always loaded).
import type { ToolkitId } from '../contracts/index.ts';
import { TOOL_OWNERS } from '../contracts/tools.ts';

const ALL = Object.keys(TOOL_OWNERS);
const prefixed = (p: string) => ALL.filter((n) => n.startsWith(p)).sort();

export const TOOLKITS: Readonly<Record<ToolkitId, readonly string[]>> = Object.freeze({
  core: ['time_resolve', 'reminder_create', 'reminder_list', 'reminder_manage', 'memory_save', 'memory_search', 'memory_forget', 'todo_manage', 'offer_choices', 'react', 'use_toolkit'],
  web: ['web_search', 'web_fetch', 'weather_get', 'fx_convert', 'share_place', 'location_request'],
  calendar: prefixed('calendar_'),
  email: [...prefixed('gmail_'), 'integration_connect'],
  missions: [...prefixed('mission_'), 'task_wait', ...prefixed('watcher_')],
  secretary: prefixed('business_'),
  files: ['make_file'],
  account: ['settings_update', 'ledger_query', 'integration_connect', 'revise_pending_action'],
});

/** One line per loadable toolkit (use_toolkit's `name` field description). */
export const TOOLKIT_LINES: Readonly<Record<Exclude<ToolkitId, 'core'>, string>> = Object.freeze({
  web: 'web search, open a URL, weather, currency, places, ask for location',
  calendar: 'Google Calendar: list, free slots, create/update/delete events, invites',
  email: 'Gmail: search, read threads, drafts, send drafts; connect accounts',
  missions: 'background missions, waiting on approvals, page/inbox watchers',
  secretary: 'Telegram Business chats: list, read, draft replies',
  files: 'make a file (csv, md, txt, json, chart png)',
  account: 'settings, activity ledger, connect integrations, revise a pending approval',
});

/** Toolkits containing a tool (a tool may belong to several, e.g. integration_connect). */
export function toolkitsOf(name: string): ToolkitId[] {
  return (Object.keys(TOOLKITS) as ToolkitId[]).filter((k) => TOOLKITS[k].includes(name));
}
