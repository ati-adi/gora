// WP0 contract tables: tool ownership (01 §6 + 03 R3), external tool modules, job LLM priorities (03 R6).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_TOOLS } from '../../../src/app.ts';
import { JOB_LLM_PRIORITY, PRIORITY_ORDER, TOOL_FILES, TOOL_OWNERS, type JobKind } from '../../../src/contracts/index.ts';
import { TOOLS as TRUST_TOOLS } from '../../../src/trust/tools.ts';
import { TOOLS as MEMORY_TOOLS } from '../../../src/memory/tools.ts';
import { TOOLS as REMINDER_TOOLS } from '../../../src/reminders/tools.ts';
import { TOOLS as MISSION_TOOLS } from '../../../src/missions/tools.ts';
import { TOOLS as SURFACE_TOOLS } from '../../../src/surfaces/tools.ts';
import { TOOLS as BUSINESS_TOOLS } from '../../../src/surfaces/business/tools.ts';
import { TOOLS as BROWSER_TOOLS } from '../../../src/browser/tools.ts';
import { TOOLS as GROUP_TOOLS } from '../../../src/groups/tools.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 01 §6 catalog, verbatim names, plus use_toolkit (03 R3). */
const CATALOG = [
  'business_draft_reply', 'business_list_chats', 'business_read_chat', 'calendar_create_event', 'calendar_delete_event', 'calendar_find_free_slots', 'calendar_list_events',
  'calendar_respond_invite', 'calendar_update_event', 'fx_convert', 'gmail_create_draft', 'gmail_read_thread', 'gmail_search', 'gmail_send_draft', 'integration_connect',
  'ledger_query', 'location_request', 'make_file', 'memory_forget', 'memory_save', 'memory_search', 'mission_finish', 'mission_report', 'mission_start', 'offer_choices',
  'poll_create', 'react', 'reminder_create', 'reminder_list', 'reminder_manage', 'revise_pending_action', 'settings_update', 'share_place', 'task_wait', 'time_resolve',
  'todo_manage', 'use_toolkit', 'watcher_create', 'watcher_manage', 'weather_get', 'web_fetch', 'web_search',
  // s07 (spec 07 A2, C6)
  'browse_task', 'browser_back', 'browser_click', 'browser_done', 'browser_open', 'browser_press', 'browser_scroll', 'browser_select', 'browser_show', 'browser_snapshot',
  'browser_type', 'group_invite_link',
].sort();

describe('TOOL_OWNERS / TOOL_FILES', () => {
  it('cover exactly the §6 catalog plus use_toolkit', () => {
    expect(Object.keys(TOOL_OWNERS).sort()).toEqual(CATALOG);
    expect(Object.keys(TOOL_FILES).sort()).toEqual(CATALOG);
  });
  it('map each tool to a file of its owning WP', () => {
    const wpOfFile = (f: string) =>
      f.startsWith('src/trust/') ? 'WP4' : f.startsWith('src/tools/') ? 'WP5' : /^src\/(memory|reminders)\//.test(f) ? 'WP6a' : f.startsWith('src/missions/') ? 'WP6b' : f.startsWith('src/surfaces/business/') ? 'WP7b' : f.startsWith('src/surfaces/') ? 'WP7a' : f.startsWith('src/browser/') ? 'BR' : f.startsWith('src/groups/') ? 'GR' : '?';
    for (const [name, file] of Object.entries(TOOL_FILES)) expect(wpOfFile(file), name).toBe(TOOL_OWNERS[name]);
    expect(TOOL_FILES['task_wait']).toBe('src/trust/tools.ts');
    expect(TOOL_FILES['use_toolkit']).toBe('src/tools/impl/useToolkit.ts');
    expect(TOOL_FILES['gmail_send_draft']).toBe('src/tools/impl/gmail.ts');
    expect(TOOL_FILES['business_read_chat']).toBe('src/surfaces/business/tools.ts');
  });
  it('every non-WP5 tool file exists and exports TOOLS; app.ts passes their concatenation as `external`', () => {
    const external = new Set(Object.entries(TOOL_FILES).filter(([n]) => TOOL_OWNERS[n] !== 'WP5').map(([, f]) => f));
    expect([...external].sort()).toEqual(['src/browser/tools.ts', 'src/groups/tools.ts', 'src/memory/tools.ts', 'src/missions/tools.ts', 'src/reminders/tools.ts', 'src/surfaces/business/tools.ts', 'src/surfaces/tools.ts', 'src/trust/tools.ts']);
    for (const f of external) expect(existsSync(ROOT + f), f).toBe(true);
    const all = [...TRUST_TOOLS, ...MEMORY_TOOLS, ...REMINDER_TOOLS, ...MISSION_TOOLS, ...SURFACE_TOOLS, ...BUSINESS_TOOLS, ...BROWSER_TOOLS, ...GROUP_TOOLS];
    expect(EXTERNAL_TOOLS.map((t) => t.name)).toEqual(all.map((t) => t.name));
    // once filled, each module may only export the tools it owns
    const files: Array<[string, readonly { name: string }[]]> = [
      ['src/trust/tools.ts', TRUST_TOOLS], ['src/memory/tools.ts', MEMORY_TOOLS], ['src/reminders/tools.ts', REMINDER_TOOLS],
      ['src/missions/tools.ts', MISSION_TOOLS], ['src/surfaces/tools.ts', SURFACE_TOOLS], ['src/surfaces/business/tools.ts', BUSINESS_TOOLS],
      ['src/browser/tools.ts', BROWSER_TOOLS], ['src/groups/tools.ts', GROUP_TOOLS],
    ];
    for (const [file, tools] of files) for (const t of tools) expect(TOOL_FILES[t.name], `${t.name} exported from ${file}`).toBe(file);
  });
});

describe('JOB_LLM_PRIORITY (03 R6)', () => {
  it('covers every job kind with a valid priority or null', () => {
    const kinds = Object.keys(JOB_LLM_PRIORITY) as JobKind[];
    expect(kinds).toHaveLength(32); // + spec 05: proactive_tick, profile_consolidate, memory_embed; + s07: 5
    // s07 (spec 07 C7): group-proactive work is 'background'; the sweeps and polls use no LLM
    expect(JOB_LLM_PRIORITY.group_summarize).toBe('background');
    expect(JOB_LLM_PRIORITY.group_chime).toBe('background');
    expect(JOB_LLM_PRIORITY.group_feedback).toBeNull();
    expect(JOB_LLM_PRIORITY.browser_sweep).toBeNull();
    expect(JOB_LLM_PRIORITY.integration_poll).toBeNull();
    expect(JOB_LLM_PRIORITY.proactive_tick).toBe('proactive');
    expect(JOB_LLM_PRIORITY.profile_consolidate).toBe('background');
    expect(JOB_LLM_PRIORITY.memory_embed).toBeNull();
    expect(JOB_LLM_PRIORITY.backup).toBeNull();
    expect(JOB_LLM_PRIORITY.nudge_deferred).toBeNull();
    for (const k of kinds) {
      const p = JOB_LLM_PRIORITY[k];
      if (p !== null) expect(PRIORITY_ORDER).toContain(p);
    }
    expect(JOB_LLM_PRIORITY.reminder_fire).toBeNull(); // reminders fire even when the LLM budget is exhausted
    expect(JOB_LLM_PRIORITY.checkin_fire).toBe('reminder');
    expect(JOB_LLM_PRIORITY.brief).toBe('proactive');
    expect(JOB_LLM_PRIORITY.memory_extract).toBe('background');
    expect(JOB_LLM_PRIORITY.run_wake).toBe('approval');
    expect(JOB_LLM_PRIORITY.first_look).toBe('interactive');
  });
});
