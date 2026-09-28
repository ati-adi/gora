// WP3 — 01 §5.2 request shape and caching layout, profile-aware (03 R2): wire snapshot test/fixtures/wire/dm-basic.json,
// tools passed through frozen (use_toolkit omitted on anthropic), ≤ 4 markers all 1 h and never on system rows, betas per
// conversation, blob hydration, compaction config; the groq variant has no markers/betas/fallbacks/thinking.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BetaMessageParam, BetaToolUnion, ConversationRow, MessageKind, MessageRow } from '../../../src/contracts/index.ts';
import { BETAS, PROVIDER_PROFILES } from '../../../src/config.ts';
import { LOOKBACK_ROWS, buildRequest, hydrateBlobs, runStartIndex } from '../../../src/agent/requestBuilder.ts';
import type { BuildDeps } from '../../../src/agent/requestBuilder.ts';
import { SYSTEM_COMPACT_V1 } from '../../../src/agent/prompt/system.compact.ts';
import { SYSTEM_V1 } from '../../../src/agent/prompt/system.ts';
import { checkRequest, checkRequestSequence } from '../../harness/invariants.ts';

const BLOB = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const deps = (provider: 'anthropic' | 'groq' = 'anthropic'): BuildDeps => ({
  profile: provider === 'anthropic' ? PROVIDER_PROFILES.anthropic : PROVIDER_PROFILES['groq-free'],
  getBlob: (id) => (id === 'b_01' ? { mime: 'image/png', bytes: BLOB } : undefined),
  hmacUser: (v) => `hmac_${v}_0123456789abcdef0123456789abcdef`,
});

const conv = (o: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 'c_01', scopeKey: 'dm:1001', kind: 'dm', userId: 'u_01', tgChatId: 1001, threadId: null, businessConnectionId: null, route: 'chat',
  model: 'claude-opus-5', effort: 'medium', toolset: 'FULL', toolsHash: 'h', systemVersion: 'v', betas: [BETAS.fallback, BETAS.compaction],
  contextMode: 'system', epoch: 1, rotatePending: null, activeRunId: 'r_1', singleShot: false, status: 'active', createdAt: 0, lastActivityAt: 0, ...o,
});

const tools: BetaToolUnion[] = [
  { name: 'memory_save', description: 'Save.', input_schema: { type: 'object', properties: {} } },
  { name: 'time_resolve', description: 'Time.', input_schema: { type: 'object', properties: {} } },
  { name: 'use_toolkit', description: 'Load tools.', input_schema: { type: 'object', properties: {} } },
  { name: 'weather_get', description: 'Weather.', input_schema: { type: 'object', properties: {} } },
] as BetaToolUnion[];

type Row = Pick<MessageRow, 'role' | 'kind' | 'content' | 'runId'>;
const row = (role: 'user' | 'assistant' | 'system', kind: MessageKind, content: BetaMessageParam['content'], runId = 'r_1'): Row => ({ role, kind, content: { role, content } as BetaMessageParam, runId });
const basicRows = (): Row[] => [
  row('user', 'user_input', [{ type: 'text', text: 'What is in this photo?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '@blob:b_01' } }]),
  row('system', 'context', [{ type: 'text', text: '<gora_context v="1">\nnow: 2026-09-28T14:03+05:00 (Mon) tz=Asia/Almaty tz_source=miniapp\n</gora_context>' }]),
];

describe('buildRequest — anthropic', () => {
  it('matches the wire snapshot test/fixtures/wire/dm-basic.json', () => {
    const req = buildRequest(deps(), { conv: conv(), run: { id: 'r_1', maxTokens: 32_000 }, rows: basicRows(), tools, modelCalls: 0 });
    const snap = JSON.parse(readFileSync(new URL('../../fixtures/wire/dm-basic.json', import.meta.url), 'utf8'));
    expect(JSON.parse(JSON.stringify(req))).toEqual(snap);
    expect(checkRequest(req)).toEqual([]);
  });

  it('system is SYSTEM_V1 with a 1 h marker; tools pass through in order without use_toolkit; betas are the conversation’s', () => {
    const req = buildRequest(deps(), { conv: conv({ betas: [BETAS.fallback] }), run: { id: 'r_1', maxTokens: 32_000 }, rows: basicRows(), tools, modelCalls: 0 });
    expect(req.system).toEqual([{ type: 'text', text: SYSTEM_V1, cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect((req.tools ?? []).map((t) => (t as { name: string }).name)).toEqual(['memory_save', 'time_resolve', 'weather_get']);
    expect(req.betas).toEqual([BETAS.fallback]);
    expect(req.context_management).toBeUndefined();
    expect(req.fallbacks).toBe('default');
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config).toEqual({ effort: 'medium' });
  });

  it('compaction config when the conversation carries the compaction beta', () => {
    const req = buildRequest(deps(), { conv: conv(), run: { id: 'r_1', maxTokens: 32_000 }, rows: basicRows(), tools, modelCalls: 0 });
    expect(req.context_management).toMatchObject({ edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 160_000 } }] });
  });

  it('blob hydration replaces @blob with the stored bytes; the stored rows are never mutated', () => {
    const rows = basicRows();
    const before = JSON.stringify(rows);
    const req = buildRequest(deps(), { conv: conv(), run: { id: 'r_1', maxTokens: 32_000 }, rows, tools, modelCalls: 1 });
    expect(JSON.stringify(req)).not.toContain('@blob:');
    expect(JSON.stringify(req.messages[0])).toContain(Buffer.from(BLOB).toString('base64'));
    expect(JSON.stringify(rows)).toBe(before);
    const missing = hydrateBlobs([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '@blob:gone' } }] }], () => undefined);
    expect(missing[0]!.content).toEqual([{ type: 'text', text: '[image unavailable]' }]);
  });

  it('markers: (b) on the run-start row after the first call, (c) on the latest tool_results row when ≥ 12 rows follow; never on system rows; ≤ 4, all 1 h', () => {
    const rows = basicRows();
    for (let i = 0; i < 7; i++) {
      rows.push(row('assistant', 'assistant', [{ type: 'text', text: `step ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'weather_get', input: {} }]));
      rows.push(row('user', 'tool_results', [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }]));
    }
    expect(rows.length - 1 - runStartIndex(rows, 'r_1')).toBeGreaterThanOrEqual(LOOKBACK_ROWS);
    const first = buildRequest(deps(), { conv: conv(), run: { id: 'r_1', maxTokens: 32_000 }, rows: basicRows(), tools, modelCalls: 0 });
    expect(JSON.stringify(first.messages)).not.toContain('cache_control');
    const req = buildRequest(deps(), { conv: conv(), run: { id: 'r_1', maxTokens: 32_000 }, rows, tools, modelCalls: 8 });
    const marked = req.messages.map((m, i) => (JSON.stringify(m).includes('cache_control') ? i : -1)).filter((i) => i >= 0);
    expect(marked).toEqual([0, rows.length - 1]);
    expect(checkRequest(req)).toEqual([]);
    // the prefix stays byte-exact across the run (markers stripped)
    expect(checkRequestSequence([first, req])).toEqual([]);
  });
});

describe('buildRequest — groq profile (03 R2)', () => {
  it('compact system, no cache markers / betas / fallbacks / thinking; max_tokens capped; effort low; blobs hydrated', () => {
    const req = buildRequest(deps('groq'), { conv: conv({ model: 'groq:openai/gpt-oss-120b', betas: [] }), run: { id: 'r_1', maxTokens: 32_000 }, rows: basicRows(), tools, modelCalls: 3 });
    expect(req.system).toEqual([{ type: 'text', text: SYSTEM_COMPACT_V1 }]);
    expect(req.max_tokens).toBe(1_200);
    expect(req.output_config).toEqual({ effort: 'low' });
    for (const k of ['betas', 'fallbacks', 'thinking', 'cache_control', 'context_management']) expect(req).not.toHaveProperty(k);
    expect((req.tools ?? []).map((t) => (t as { name: string }).name)).toContain('use_toolkit');
    expect(checkRequest(req, { provider: 'groq' })).toEqual([]);
    const mission = buildRequest(deps('groq'), { conv: conv({ model: 'groq:x', effort: 'high' }), run: { id: 'r_1', maxTokens: 64_000 }, rows: basicRows(), tools, modelCalls: 0 });
    expect(mission.output_config).toEqual({ effort: 'medium' });
  });
});
