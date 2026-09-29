// WP5 — 01 §15.2 registry.test.ts + 03 R3/R4: memberships, ordering, hashes, eager input, descriptions, toolkits,
// profile-dependent web tools.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROVIDER_PROFILES } from '../../../src/config.ts';
import type { MainRequest, ProviderProfile, ToolSpec } from '../../../src/contracts/index.ts';
import { estimateTranslated, translateRequest } from '../../../src/agent/groq/map.ts';
import { TOOL_OWNERS, TOOLKIT_IDS } from '../../../src/contracts/tools.ts';
import { estimateTokens } from '../../../src/kernel/tokens.ts';
import { createToolRegistry, wp5Tools } from '../../../src/tools/index.ts';
import { BLOCKED_DOMAINS, serverToolDefinitions } from '../../../src/tools/serverTools.ts';
import { TOOLKITS } from '../../../src/tools/toolkits.ts';
import { BIZ_TOOLS, FULL_TOOLS, GROUP_TOOLS, GUEST_TOOLS } from '../../../src/tools/toolsets.ts';
import { TOOLS as TRUST_TOOLS } from '../../../src/trust/tools.ts';
import { TOOLS as MEMORY_TOOLS } from '../../../src/memory/tools.ts';
import { TOOLS as REMINDER_TOOLS } from '../../../src/reminders/tools.ts';
import { TOOLS as MISSION_TOOLS } from '../../../src/missions/tools.ts';
import { TOOLS as SURFACE_TOOLS } from '../../../src/surfaces/tools.ts';
import { TOOLS as BIZ_EXTERNAL } from '../../../src/surfaces/business/tools.ts';

const ANTHROPIC = PROVIDER_PROFILES.anthropic as ProviderProfile;
const GROQ = PROVIDER_PROFILES['groq-free'] as ProviderProfile;

/** Stand-ins for every tool another WP owns (so memberships can be asserted independently of their progress). */
function dummyExternal(): ToolSpec[] {
  const surfacesOf = (n: string) => [
    ...(FULL_TOOLS.includes(n) ? (['dm', 'topic', 'mission'] as const) : []),
    ...(GROUP_TOOLS.includes(n) ? (['group'] as const) : []),
    ...(BIZ_TOOLS.includes(n) ? (['biz_draft'] as const) : []),
  ];
  return Object.entries(TOOL_OWNERS)
    .filter(([, o]) => o !== 'WP5')
    .map(([name]) => ({
      name, description: `Stub for ${name}. Call when needed.`, input: z.object({ x: z.string().optional() }), surfaces: surfacesOf(name), parallelSafe: true,
      ...(name === 'business_draft_reply' ? { eagerInput: true } : {}),
      classify: () => ({ actionClass: 'control' as const, risk: 0 as const }), statusLabel: () => '', execute: async () => ({ content: '' }),
    }));
}

describe('tool registry (01 §6)', () => {
  for (const profile of [ANTHROPIC, GROQ]) {
    describe(profile.id, () => {
      const reg = createToolRegistry(profile, dummyExternal());
      const staticMode = profile.toolMode === 'static';

      it('names are unique and sorted; memberships exactly as in §6', () => {
        const full = reg.toolset('FULL');
        const names = full.definitions.map((d) => (d as { name: string }).name);
        expect(names).toEqual([...names].sort());
        expect(new Set(names).size).toBe(names.length);
        const expectedFull = FULL_TOOLS.filter((n) => !(staticMode && n === 'use_toolkit'));
        expect(names).toEqual(expectedFull);
        expect([...full.names]).toEqual(expectedFull);
        expect(reg.toolset('GROUP').definitions.map((d) => (d as { name: string }).name)).toEqual([...GROUP_TOOLS]);
        expect(reg.toolset('GUEST').definitions.map((d) => (d as { name: string }).name)).toEqual([...GUEST_TOOLS]);
        expect(reg.toolset('BIZ').definitions.map((d) => (d as { name: string }).name)).toEqual([...BIZ_TOOLS]);
        expect(names).not.toContain('poll_create');
      });

      it('hashes are stable across two builds and differ between toolsets', () => {
        const again = createToolRegistry(profile, dummyExternal());
        for (const id of ['FULL', 'GROUP', 'GUEST', 'BIZ'] as const) {
          expect(again.toolset(id).hash).toBe(reg.toolset(id).hash);
          expect(JSON.stringify(again.toolset(id).definitions)).toBe(JSON.stringify(reg.toolset(id).definitions));
          expect(reg.toolset(id).hash).toMatch(/^[0-9a-f]{16}$/);
        }
        expect(new Set(['FULL', 'GROUP', 'GUEST', 'BIZ'].map((id) => reg.toolset(id as 'FULL').hash)).size).toBe(4);
      });

      it('eager_input_streaming only on gmail_create_draft and business_draft_reply, never on server tools', () => {
        const eager = reg.toolset('FULL').definitions.filter((d) => (d as { eager_input_streaming?: boolean }).eager_input_streaming).map((d) => (d as { name: string }).name);
        expect(eager.sort()).toEqual(['business_draft_reply', 'gmail_create_draft']);
      });

      it('client tool schemas are closed objects without $schema', () => {
        for (const d of reg.toolset('FULL').definitions) {
          const schema = (d as { input_schema?: Record<string, unknown> }).input_schema;
          if (!schema) continue;
          expect(schema['$schema']).toBeUndefined();
          expect(schema['type']).toBe('object');
          // 01 §6 closes every object; on toolkits-mode profiles 03 R3's 1,100-token core budget wins (03 > 01): the
          // compact schema drops validation-only keywords, which zod still enforces on every call.
          if (staticMode) expect(schema['additionalProperties']).toBe(false);
          else expect(JSON.stringify(schema)).not.toMatch(/"(additionalProperties|maxLength|minLength|maximum|minimum)"/);
        }
      });

      it('web tools: server tools on anthropic, client tools of the same names on groq', () => {
        const byName = (id: 'FULL' | 'GROUP' | 'GUEST', n: string) => reg.toolset(id).definitions.find((d) => (d as { name: string }).name === n) as unknown as Record<string, unknown>;
        if (staticMode) {
          expect(byName('FULL', 'web_search')).toMatchObject({ type: 'web_search_20260209', max_uses: 5, blocked_domains: [...BLOCKED_DOMAINS] });
          expect(byName('GROUP', 'web_search')).toMatchObject({ max_uses: 3 });
          expect(byName('GUEST', 'web_fetch')).toMatchObject({ type: 'web_fetch_20260209', max_uses: 2, max_content_tokens: 20000 });
          expect(byName('FULL', 'web_fetch')['url_sources']).toEqual({ user_input: { type: 'all' }, server_tool_results: { type: 'all' }, client_tool_results: { type: 'none' } });
          expect(byName('FULL', 'web_search')['eager_input_streaming']).toBeUndefined();
          expect(reg.get('web_search')).toBeUndefined();
          expect(reg.toolset('FULL').names.has('use_toolkit')).toBe(false);
        } else {
          expect(byName('FULL', 'web_search')['type']).toBeUndefined();
          expect(byName('FULL', 'web_search')['input_schema']).toBeDefined();
          expect(reg.get('web_search')?.outputTaint).toBe('web');
          expect(reg.get('web_fetch')?.outputTaint).toBe('web');
          expect(reg.toolset('FULL').names.has('use_toolkit')).toBe(true);
        }
      });
    });
  }

  it('⚠U8: url_sources can be switched off (max_uses and blocked_domains stay)', () => {
    const d = serverToolDefinitions(ANTHROPIC, 'FULL', { webFetchUrlSources: false }).get('web_fetch') as unknown as Record<string, unknown>;
    expect(d['url_sources']).toBeUndefined();
    expect(d).toMatchObject({ max_uses: 5, blocked_domains: [...BLOCKED_DOMAINS] });
    expect(serverToolDefinitions(GROQ, 'FULL').size).toBe(0);
    expect(serverToolDefinitions(ANTHROPIC, 'BIZ').size).toBe(0);
  });

  it('a duplicate name throws (internal or external)', () => {
    const ext = dummyExternal();
    expect(() => createToolRegistry(GROQ, [...ext, ext[0]!])).toThrow(/duplicate/);
    const clash = { ...ext[0]!, name: 'time_resolve' };
    expect(() => createToolRegistry(GROQ, [...ext, clash])).toThrow(/duplicate/);
  });

  it('every WP5 description is non-empty, ≤ 160 chars and says when to call it', () => {
    for (const p of [ANTHROPIC, GROQ]) {
      for (const sp of wp5Tools(p)) {
        expect(sp.description.length, sp.name).toBeGreaterThan(20);
        expect(sp.description.length, sp.name).toBeLessThanOrEqual(160);
        expect(sp.description, sp.name).toMatch(/\b(call|when|before|after)\b/i);
        expect(Object.keys(TOOL_OWNERS)).toContain(sp.name);
      }
    }
  });
});

describe('toolkits (03 R3)', () => {
  const REAL_EXTERNAL = [...TRUST_TOOLS, ...MEMORY_TOOLS, ...REMINDER_TOOLS, ...MISSION_TOOLS, ...SURFACE_TOOLS, ...BIZ_EXTERNAL];
  const reg = createToolRegistry(GROQ, dummyExternal());

  it('every FULL tool belongs to at least one toolkit; toolkits only name catalog tools', () => {
    const all = new Set(Object.values(TOOLKITS).flat());
    for (const n of FULL_TOOLS) expect(all.has(n), n).toBe(true);
    for (const n of all) expect(Object.keys(TOOL_OWNERS)).toContain(n);
    expect(Object.keys(reg.toolkits()).sort()).toEqual([...TOOLKIT_IDS].sort());
    expect(TOOLKITS.email).toContain('integration_connect');
    expect(TOOLKITS.account).toContain('integration_connect');
  });

  it('subset = core ∪ kits over FULL, sorted and hashed; GROUP/GUEST/BIZ are always whole', () => {
    const core = reg.subset('FULL', []);
    expect([...core.names].sort()).toEqual([...TOOLKITS.core].sort());
    const web = reg.subset('FULL', ['web']);
    expect([...web.names]).toEqual([...new Set([...TOOLKITS.core, ...TOOLKITS.web])].sort());
    expect(web.hash).not.toBe(core.hash);
    expect(reg.subset('FULL', ['web']).hash).toBe(web.hash);
    expect(reg.subset('GROUP', []).hash).toBe(reg.toolset('GROUP').hash);
    expect(reg.subset('GUEST', ['calendar']).hash).toBe(reg.toolset('GUEST').hash);
    expect(reg.subset('BIZ', []).hash).toBe(reg.toolset('BIZ').hash);
  });

  it('the core toolkit stays within 1,100 estimated tokens (03 R3), with the real WP6a specs', () => {
    // core = 4 WP5 tools (time_resolve, offer_choices, react, use_toolkit) + 7 WP6a tools; toolkits-mode definitions are
    // compact (validation-only keywords dropped; zod still validates every call).
    const mine = createToolRegistry(GROQ, []).subset('FULL', []);
    const mineTokens = estimateTokens(JSON.stringify(mine.definitions));
    expect([...mine.names].sort()).toEqual(['offer_choices', 'react', 'time_resolve', 'use_toolkit']);
    expect(mineTokens).toBeLessThanOrEqual(460);
    const whole = estimateTokens(JSON.stringify(createToolRegistry(GROQ, REAL_EXTERNAL).subset('FULL', []).definitions));
    expect(whole).toBeGreaterThan(mineTokens);
    expect(whole).toBeLessThanOrEqual(1100);
    // What Groq actually receives (function wrappers, ~9 tokens/tool more): measured 1,182 after the review trims (was 1,199);
    // s07: 1,190 with the 'browser' toolkit in use_toolkit's description and enum.
    const defs = createToolRegistry(GROQ, REAL_EXTERNAL).subset('FULL', []).definitions;
    const wire = translateRequest({ model: 'groq:x', max_tokens: 100, system: [], messages: [], tools: defs } as unknown as MainRequest, { mediaText: () => '', maxOutputTokens: 1000 });
    expect(estimateTranslated({ messages: [], tools: wire.tools })).toBeLessThanOrEqual(1192);
  });

  it('the registry builds with every real external TOOLS array (no duplicates, known names)', () => {
    for (const p of [ANTHROPIC, GROQ]) {
      const real = createToolRegistry(p, REAL_EXTERNAL);
      for (const sp of real.all()) expect(Object.keys(TOOL_OWNERS)).toContain(sp.name);
    }
  });
});
