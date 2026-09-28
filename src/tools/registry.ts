// tools/registry.ts (WP5) — the profile-aware tool registry (01 §6, 03 R3/R4).
// Definitions are deterministic: sorted by name, JSON Schema from tools/schema.ts, hashed with canonical JSON.
import type { BetaToolUnion, ProviderProfile, ToolDefinitions, ToolkitId, ToolRegistry, ToolSpec, ToolsetId } from '../contracts/index.ts';
import { TOOLKIT_IDS } from '../contracts/tools.ts';
import { compactJsonSchema, definitionsHash, toolInputJsonSchema } from './schema.ts';
import { serverToolDefinitions, SERVER_TOOL_NAMES, type ServerToolOptions } from './serverTools.ts';
import { TOOLKITS } from './toolkits.ts';
import { EAGER_INPUT_TOOLS, TOOLSET_MEMBERS } from './toolsets.ts';

export interface RegistryOptions extends ServerToolOptions {}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function clientDefinition(spec: ToolSpec, compact = false): BetaToolUnion {
  const schema = toolInputJsonSchema(spec.input);
  const d: Record<string, unknown> = { name: spec.name, description: spec.description, input_schema: compact ? compactJsonSchema(schema) : schema };
  if (spec.eagerInput || EAGER_INPUT_TOOLS.has(spec.name)) d['eager_input_streaming'] = true;
  return d as unknown as BetaToolUnion;
}

/**
 * `internal`: WP5's own specs (profile-dependent: web tools only on Groq). `external`: every other WP's TOOLS.
 * A duplicate name (internal or external) throws. Toolset membership is the frozen list of 01 §6 intersected with the
 * specs that exist (a server tool counts as existing on anthropic).
 */
export function buildToolRegistry(profile: ProviderProfile, internal: readonly ToolSpec[], external: readonly ToolSpec[], o: RegistryOptions = {}): ToolRegistry {
  const specs = new Map<string, ToolSpec>();
  for (const sp of [...internal, ...external]) {
    if (specs.has(sp.name)) throw new Error(`duplicate tool name: ${sp.name}`);
    if (profile.provider === 'anthropic' && SERVER_TOOL_NAMES.has(sp.name)) throw new Error(`tool ${sp.name} is a server tool on the anthropic profile`);
    specs.set(sp.name, sp);
  }
  const sorted = [...specs.values()].sort(byName);
  const staticMode = profile.toolMode === 'static';

  const defCache = new Map<string, BetaToolUnion>();
  const clientDef = (sp: ToolSpec): BetaToolUnion => {
    let d = defCache.get(sp.name);
    if (!d) {
      d = clientDefinition(sp, !staticMode); // 03 R3: compact schemas on toolkits-mode profiles
      defCache.set(sp.name, d);
    }
    return d;
  };

  /** Names of a toolset that are actually available on this profile. */
  const available = (id: ToolsetId): string[] => {
    const server = serverToolDefinitions(profile, id, o);
    return TOOLSET_MEMBERS[id].filter((n) => {
      if (staticMode && n === 'use_toolkit') return false; // 03 R3: omitted on anthropic
      return server.has(n) || specs.has(n);
    });
  };

  const build = (id: ToolsetId, names: readonly string[]): ToolDefinitions => {
    const server = serverToolDefinitions(profile, id, o);
    const sortedNames = [...new Set(names)].sort();
    const definitions = sortedNames.map((n) => server.get(n) ?? clientDef(specs.get(n) as ToolSpec));
    return Object.freeze({ definitions: Object.freeze(definitions), hash: definitionsHash(definitions), names: new Set(sortedNames) as ReadonlySet<string> });
  };

  const toolsetCache = new Map<ToolsetId, ToolDefinitions>();
  const toolset = (id: ToolsetId): ToolDefinitions => {
    let d = toolsetCache.get(id);
    if (!d) {
      d = build(id, available(id));
      toolsetCache.set(id, d);
    }
    return d;
  };

  const subsetCache = new Map<string, ToolDefinitions>();
  const subset = (id: ToolsetId, kits: readonly ToolkitId[]): ToolDefinitions => {
    if (id !== 'FULL') return toolset(id); // GROUP/GUEST/BIZ are always fully loaded (03 R3)
    const wanted = [...new Set<ToolkitId>(['core', ...kits.filter((k) => (TOOLKIT_IDS as readonly string[]).includes(k))])].sort();
    const key = wanted.join(',');
    let d = subsetCache.get(key);
    if (!d) {
      const allowed = new Set(wanted.flatMap((k) => TOOLKITS[k]));
      d = build(id, available(id).filter((n) => allowed.has(n)));
      subsetCache.set(key, d);
    }
    return d;
  };

  return {
    get: (name) => specs.get(name),
    all: () => sorted,
    toolset,
    toolkits: () => TOOLKITS,
    subset,
  };
}
