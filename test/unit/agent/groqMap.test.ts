// WP3 — 03 R1 translation (map.ts), the 03 R2 hard ceiling and the chunk accumulator over the verified chunk shapes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'groq-sdk/resources/chat/completions';
import type { MainRequest } from '../../../src/contracts/index.ts';
import { BadRequestLlmError, JsonInputError, TransientLlmError } from '../../../src/kernel/errors.ts';
import {
  ChunkAccumulator, OMITTED_LINE, TRUNCATED_MARK, blockSummary, buildStreamParams, estimateTranslated, fitToBudget, toolUseFailedNote, translateRequest, usageNumbers,
} from '../../../src/agent/groq/map.ts';

const chunks = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/sse/${name}`, import.meta.url), 'utf8')) as ChatCompletionChunk[];
const opts = { mediaText: (b: Record<string, unknown>) => (b['type'] === 'image' ? '[image: a red square]' : '[document]\nPDF TEXT'), maxOutputTokens: 1200 };

function req(messages: MainRequest['messages'], extra: Partial<MainRequest> = {}): MainRequest {
  return {
    model: 'groq:openai/gpt-oss-120b', max_tokens: 32_000,
    system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [
      { name: 'weather_get', description: 'Weather.', input_schema: { type: 'object', properties: { place: { type: 'string' } } } },
      { type: 'web_search_20260209', name: 'web_search' } as never,
    ],
    messages, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, betas: ['x'], fallbacks: 'default',
    ...extra,
  } as MainRequest;
}

describe('translateRequest (03 R1 rules)', () => {
  const r = req([
    { role: 'user', content: [{ type: 'text', text: 'weather?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    { role: 'system', content: [{ type: 'text', text: '<gora_context v="1">now…</gora_context>' }] } as never,
    {
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'hidden', signature: 's' },
        { type: 'text', text: 'Checking.' },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'almaty weather' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'Meteo', url: 'https://meteo.kz', encrypted_content: 'x' }] },
        { type: 'tool_use', id: 'toolu_1', name: 'weather_get', input: { place: 'Almaty' } },
      ],
    } as never,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '12°C' }] }, { type: 'text', text: '[Owner, 14:05]: and tomorrow?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'It is 12°C.' }, { type: 'mystery', x: 1 } as never] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'bad', is_error: true } as never, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } } as never] },
  ]);
  const t = translateRequest(r, opts);

  it('system blocks → one system message; mid-conversation system rows stay in place', () => {
    expect(t.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(t.messages[2]).toEqual({ role: 'system', content: '<gora_context v="1">now…</gora_context>' });
  });
  it('text, media → text; thinking dropped; server tools summarized; tool_use → tool_calls', () => {
    expect(t.messages[1]).toEqual({ role: 'user', content: 'weather?\n\n[image: a red square]' });
    const asst = t.messages[3] as { role: string; content: string; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
    expect(asst.content).toContain('Checking.');
    expect(asst.content).toContain('[web_search: "almaty weather"]');
    expect(asst.content).toContain('Meteo (https://meteo.kz)');
    expect(asst.content).not.toContain('hidden');
    expect(asst.tool_calls).toEqual([{ id: 'toolu_1', type: 'function', function: { name: 'weather_get', arguments: '{"place":"Almaty"}' } }]);
  });
  it('tool_result → role tool (text joined; is_error prefixed), trailing text → a user message after it', () => {
    expect(t.messages[4]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: '12°C' });
    expect(t.messages[5]).toEqual({ role: 'user', content: '[Owner, 14:05]: and tomorrow?' });
    expect(t.messages[6]).toEqual({ role: 'assistant', content: 'It is 12°C.\n[unsupported block]' });
    expect(t.messages[7]).toEqual({ role: 'tool', tool_call_id: 'x', content: 'ERROR: bad' });
    expect(t.messages[8]).toEqual({ role: 'user', content: '[document]\nPDF TEXT' });
  });
  it('only client tools become functions; effort → reasoning_effort; output capped by the profile', () => {
    expect(t.toolNames).toEqual(['weather_get']);
    expect(t.reasoningEffort).toBe('low');
    expect(t.maxCompletionTokens).toBe(1200);
    const p = buildStreamParams(t, 'openai/gpt-oss-120b') as unknown as Record<string, unknown>;
    expect(p['stream']).toBe(true);
    expect(p['stream_options']).toEqual({ include_usage: true });
    expect(p['tool_choice']).toBe('auto');
    expect(p['reasoning_effort']).toBe('low');
    for (const k of ['cache_control', 'betas', 'fallbacks', 'thinking', 'context_management', 'temperature']) expect(p).not.toHaveProperty(k);
  });
  it('blockSummary covers past Anthropic server-tool blocks', () => {
    expect(blockSummary({ type: 'web_fetch_tool_result', content: { url: 'https://a.b/c' } })).toBe('[fetched: https://a.b/c]');
    expect(blockSummary({ type: 'code_execution_tool_result' })).toBe('[code_execution result]');
    expect(blockSummary({ type: 'weird' })).toBe('[unsupported block]');
  });
});

describe('fitToBudget (03 R2 hard ceiling)', () => {
  const long = (n: number) => 'x'.repeat(n);
  const history = (turns: number) => {
    const m: MainRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: `<previous_epoch_summary source="handoff">notes</previous_epoch_summary>\nfirst` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
    for (let i = 0; i < turns; i++) {
      m.push({ role: 'user', content: [{ type: 'text', text: `q${i} ${long(600)}` }] });
      m.push({ role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: `t${i}`, name: 'weather_get', input: {} }] } as never);
      m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: long(900) }] });
      m.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
    }
    m.push({ role: 'user', content: [{ type: 'text', text: 'CURRENT INPUT' }] });
    return m;
  };

  it('a 200-turn history never exceeds the cap, keeps pairs intact, the seed, system and the current input', () => {
    const t = translateRequest(req(history(200)), opts);
    const f = fitToBudget(t, 5_200);
    expect(estimateTranslated(f)).toBeLessThanOrEqual(5_200);
    expect(f.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(JSON.stringify(f.messages)).toContain('previous_epoch_summary');
    expect(f.messages.filter((m) => m.role === 'system' && m.content === OMITTED_LINE)).toHaveLength(1);
    expect(f.messages[f.messages.length - 1]).toEqual({ role: 'user', content: 'CURRENT INPUT' });
    f.messages.forEach((m, i) => {
      if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.length) expect(f.messages[i + 1]).toMatchObject({ role: 'tool', tool_call_id: m.tool_calls[0]!.id });
      if (m.role === 'tool') expect(f.messages[i - 1]).toMatchObject({ role: 'assistant' });
    });
  });
  it('truncates the longest tool results of the current run to 600 tokens, then fails with prompt_budget', () => {
    const m: MainRequest['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'weather_get', input: {} }] } as never,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: long(40_000) }] },
    ];
    const f = fitToBudget(translateRequest(req(m), opts), 1_500);
    const tool = f.messages.find((x) => x.role === 'tool') as { content: string };
    expect(tool.content.endsWith(TRUNCATED_MARK)).toBe(true);
    expect(estimateTranslated(f)).toBeLessThanOrEqual(1_500);
    const huge: MainRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: long(40_000) }] }];
    expect(() => fitToBudget(translateRequest(req(huge), opts), 1_500)).toThrow(BadRequestLlmError);
    try {
      fitToBudget(translateRequest(req(huge), opts), 1_500);
    } catch (e) {
      expect((e as BadRequestLlmError).code).toBe('prompt_budget');
    }
  });
  it('the tool_use_failed note lists the valid tools', () => {
    expect(toolUseFailedNote(['a', 'b'], 'attempted to call tool send_email')).toMatchObject({ role: 'system' });
    expect(String(toolUseFailedNote(['a', 'b']).content)).toContain('Available tools: a, b');
  });
});

describe('ChunkAccumulator (verified chunk shapes)', () => {
  it('text stream: reasoning never reaches text; usage from the final choices:[] chunk; stop → end_turn', () => {
    const acc = new ChunkAccumulator();
    const texts: string[] = [];
    let thinking = 0;
    for (const c of chunks('groq-text.json')) {
      const o = acc.push(c);
      if (o.text) texts.push(o.text);
      if (o.thinkingStart) thinking += 1;
    }
    expect(texts.join('')).toBe('Hello there!');
    expect(thinking).toBe(1);
    const msg = acc.toMessage('openai/gpt-oss-120b', () => 'id');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.model).toBe('groq:openai/gpt-oss-120b');
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello there!', citations: null }]);
    expect(usageNumbers(acc.usage)).toMatchObject({ inputTokens: 812, outputTokens: 21, cacheReadTokens: 0, cacheWrite1h: 0 });
  });
  it('one complete tool_call delta → a tool_use block; stop → tool_use', () => {
    const acc = new ChunkAccumulator();
    for (const c of chunks('groq-tool.json')) acc.push(c);
    const msg = acc.toMessage('m', () => 'id');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'fc_3f1c2a8e-0b1d-4c5e-9a7b-2d6e8f9a0b1c', name: 'weather_get', input: { place: 'Almaty', days: 1 } }]);
  });
  it('finish tool_calls without client calls → end_turn; length → max_tokens; bad JSON → JsonInputError; x_groq.error → transient', () => {
    const a1 = new ChunkAccumulator();
    a1.push({ id: 'c', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'tool_calls' }] } as never);
    expect(a1.toMessage('m', () => 'i').stop_reason).toBe('end_turn');
    const a2 = new ChunkAccumulator();
    a2.push({ id: 'c', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] } as never);
    expect(a2.toMessage('m', () => 'i').stop_reason).toBe('max_tokens');
    const a3 = new ChunkAccumulator();
    a3.push({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fc', type: 'function', function: { name: 'x', arguments: '{"a":' } }] }, finish_reason: 'tool_calls' }] } as never);
    expect(() => a3.toMessage('m', () => 'i')).toThrow(JsonInputError);
    const a4 = new ChunkAccumulator();
    expect(() => a4.push({ id: 'c', choices: [], x_groq: { id: 'r', error: 'over capacity' } } as never)).toThrow(TransientLlmError);
  });
});
