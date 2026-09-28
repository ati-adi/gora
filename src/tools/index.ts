// tools/index.ts (WP5) — createToolRegistry(profile, external): WP5's own specs + every other WP's TOOLS.
import type { ProviderProfile, ToolRegistry, ToolSpec } from '../contracts/index.ts';
import { CALENDAR_TOOLS } from './impl/calendar.ts';
import { choicesTool } from './impl/choices.ts';
import { connectTool } from './impl/connect.ts';
import { fxTool } from './impl/fx.ts';
import { GMAIL_TOOLS } from './impl/gmail.ts';
import { ledgerTool } from './impl/ledger.ts';
import { locationTool } from './impl/location.ts';
import { makeFileTool } from './impl/makeFile.ts';
import { placeTool } from './impl/place.ts';
import { reactTool } from './impl/react.ts';
import { settingsTool } from './impl/settings.ts';
import { timeTool } from './impl/time.ts';
import { useToolkitTool } from './impl/useToolkit.ts';
import { weatherTool } from './impl/weather.ts';
import { webFetchTool, webSearchTool } from './impl/web.ts';
import { buildToolRegistry, type RegistryOptions } from './registry.ts';

/** WP5's own specs for a profile: web_search/web_fetch are client tools only on Groq (on anthropic they are server tools). */
export function wp5Tools(profile: ProviderProfile): ToolSpec[] {
  const list: ToolSpec[] = [
    ...CALENDAR_TOOLS, ...GMAIL_TOOLS, fxTool, connectTool, ledgerTool, locationTool, makeFileTool(profile), choicesTool, reactTool,
    settingsTool, placeTool, timeTool, weatherTool, useToolkitTool,
  ];
  if (profile.provider === 'groq') list.push(webSearchTool, webFetchTool);
  return list;
}

/**
 * Profile-aware (03 R4): server web tools for anthropic, client web tools of the same names for groq.
 * `external` holds the specs owned by other WPs (TOOL_FILES in contracts/tools.ts); a duplicate name throws.
 * `o` (optional, WP5 extension): ⚠U8 `webFetchUrlSources` (config.features.webFetchUrlSources; default true).
 */
export function createToolRegistry(profile: ProviderProfile, external: readonly ToolSpec[], o: RegistryOptions = {}): ToolRegistry {
  return buildToolRegistry(profile, wp5Tools(profile), external, o);
}

export { BLOCKED_DOMAINS, isBlockedDomain, serverToolDefinitions } from './serverTools.ts';
export { TOOLKITS, TOOLKIT_LINES, toolkitsOf } from './toolkits.ts';
export { TOOLSET_MEMBERS, WEB_MAX_USES } from './toolsets.ts';
