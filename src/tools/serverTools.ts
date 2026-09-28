// tools/serverTools.ts (WP5) — Anthropic server tool definitions (01 §6, 03 R4). Only the anthropic profile gets them;
// on Groq the registry provides client tools with the same names (tools/impl/web.ts).
import type { BetaToolUnion, ProviderProfile, ToolsetId } from '../contracts/index.ts';
import { WEB_MAX_USES } from './toolsets.ts';

export const BLOCKED_DOMAINS: readonly string[] = Object.freeze([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'pastebin.com', 'ghostbin.com', 'hastebin.com', 'rentry.co',
  'webhook.site', 'requestbin.com', 'pipedream.net', 'ngrok.io', 'ngrok-free.app', 'burpcollaborator.net', 'interact.sh', 'oast.fun',
]);

/** True when `host` is a blocked domain or a subdomain of one. */
export function isBlockedDomain(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return BLOCKED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

export const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

export interface ServerToolOptions {
  /** ⚠U8 FEATURE_WEB_FETCH_URL_SOURCES: when false, `url_sources` is omitted (max_uses, blocked_domains and taint stay). */
  webFetchUrlSources?: boolean;
}

/**
 * Server tool definitions for one toolset, keyed by name. Empty for a non-anthropic profile and for a toolset whose
 * max_uses is 0 (BIZ). Deterministic: the same inputs give byte-identical objects (prefix caching, 01 §5.2).
 */
export function serverToolDefinitions(profile: Pick<ProviderProfile, 'provider'>, toolset: ToolsetId, o: ServerToolOptions = {}): Map<string, BetaToolUnion> {
  const out = new Map<string, BetaToolUnion>();
  if (profile.provider !== 'anthropic') return out;
  const uses = WEB_MAX_USES[toolset];
  if (uses.search > 0) {
    out.set('web_search', { type: 'web_search_20260209', name: 'web_search', max_uses: uses.search, blocked_domains: [...BLOCKED_DOMAINS] } as unknown as BetaToolUnion);
  }
  if (uses.fetch > 0) {
    const def: Record<string, unknown> = { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: uses.fetch, max_content_tokens: 20000, blocked_domains: [...BLOCKED_DOMAINS] };
    if (o.webFetchUrlSources !== false) def['url_sources'] = { user_input: { type: 'all' }, server_tool_results: { type: 'all' }, client_tool_results: { type: 'none' } };
    out.set('web_fetch', def as unknown as BetaToolUnion);
  }
  return out;
}
