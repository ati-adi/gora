// WP3 — fallback echo (01 §5.3): drops pre-fallback thinking, tool_use and unpaired server_tool_use.
import { describe, expect, it } from 'vitest';
import type { BetaContentBlock, BetaMessage } from '../../../src/contracts/index.ts';
import { fallbackEcho, fallbackEchoContent, servedByFallback } from '../../../src/agent/fallbackEcho.ts';
import { clientToolUses } from '../../../src/agent/grammar.ts';

const b = (x: Record<string, unknown>) => x as unknown as BetaContentBlock;

describe('fallbackEcho', () => {
  it('leaves content without a fallback block unchanged', () => {
    const c = [b({ type: 'thinking', thinking: 't', signature: 's' }), b({ type: 'text', text: 'hi' })];
    expect(fallbackEchoContent(c)).toEqual(c);
  });

  it('drops pre-fallback thinking, tool_use and unpaired server_tool_use; keeps text, paired server blocks and everything after', () => {
    const c = [
      b({ type: 'thinking', thinking: 'secret', signature: 'sig' }),
      b({ type: 'text', text: 'Looking…' }),
      b({ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }),
      b({ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] }),
      b({ type: 'server_tool_use', id: 'srv_2', name: 'web_search', input: { query: 'y' } }),
      b({ type: 'tool_use', id: 'toolu_1', name: 'reminder_create', input: {} }),
      b({ type: 'redacted_thinking', data: 'zzz' }),
      b({ type: 'mystery_internal', x: 1 }),
      b({ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }),
      b({ type: 'thinking', thinking: 'after', signature: 's2' }),
      b({ type: 'tool_use', id: 'toolu_2', name: 'weather_get', input: {} }),
    ];
    const out = fallbackEchoContent(c) as unknown as Array<Record<string, unknown>>;
    expect(out.map((x) => x['type'])).toEqual(['text', 'server_tool_use', 'web_search_tool_result', 'fallback', 'thinking', 'tool_use']);
    expect(out.find((x) => x['type'] === 'server_tool_use')!['id']).toBe('srv_1');
    // client tools come ONLY from the transformed content
    expect(clientToolUses(out).map((x) => x.id)).toEqual(['toolu_2']);
  });

  it('uses the LAST fallback block as the boundary', () => {
    const c = [b({ type: 'tool_use', id: 't0', name: 'x', input: {} }), b({ type: 'fallback' }), b({ type: 'tool_use', id: 't1', name: 'x', input: {} }), b({ type: 'fallback' }), b({ type: 'text', text: 'end' })];
    expect((fallbackEchoContent(c) as unknown as Array<Record<string, unknown>>).map((x) => x['type'])).toEqual(['fallback', 'fallback', 'text']);
  });

  it('servedByFallback: iterations include fallback_message and the stop is not a refusal', () => {
    const msg = (stop: string, types: string[]) => ({ content: [], stop_reason: stop, usage: { iterations: types.map((type) => ({ type })) } }) as unknown as BetaMessage;
    expect(servedByFallback(msg('end_turn', ['message', 'fallback_message']))).toBe(true);
    expect(servedByFallback(msg('refusal', ['message', 'fallback_message']))).toBe(false);
    expect(servedByFallback(msg('end_turn', ['message']))).toBe(false);
    const m = { content: [b({ type: 'text', text: 'x' })], stop_reason: 'end_turn', usage: {} } as unknown as BetaMessage;
    expect(fallbackEcho(m)).toBe(m);
  });
});
