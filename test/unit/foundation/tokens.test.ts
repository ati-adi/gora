import { describe, expect, it } from 'vitest';
import { estimateBlockTokens, estimateChatTokens, estimateParamTokens, estimateTokens, TOKENS_PER_MESSAGE, TOKENS_PER_TOOL_CALL } from '../../../src/kernel/tokens.ts';

describe('kernel/tokens (03 R2)', () => {
  it('estimateTokens = ceil(len / 3.2)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('x'.repeat(32))).toBe(10);
    expect(estimateTokens('x'.repeat(33))).toBe(11);
    expect(estimateTokens('Привет, как дела?')).toBe(Math.ceil(17 / 3.2)); // counts UTF-16 units: conservative for Cyrillic
  });
  it('+12 per message and +4 per tool-call wrapper', () => {
    expect(TOKENS_PER_MESSAGE).toBe(12);
    expect(TOKENS_PER_TOOL_CALL).toBe(4);
    expect(estimateChatTokens([{ role: 'user', content: 'x'.repeat(32) }])).toBe(12 + 10);
    const withCall = estimateChatTokens([{ role: 'assistant', content: null, tool_calls: [{ function: { name: 'abcd', arguments: '{"a":1}' } }] }]);
    expect(withCall).toBe(12 + 4 + estimateTokens('abcd') + estimateTokens('{"a":1}'));
    expect(estimateChatTokens([])).toBe(0);
  });
  it('estimates Anthropic-format rows', () => {
    const n = estimateParamTokens([
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(64) }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'long', signature: 's' }, { type: 'tool_use', id: 't1', name: 'time_resolve', input: { expression: 'tomorrow' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(32) }] },
      { role: 'user', content: 'plain string' },
    ]);
    const expected = 12 * 4 + 20 + (4 + estimateTokens('time_resolve') + estimateTokens('{"expression":"tomorrow"}')) + (4 + 10) + estimateTokens('plain string');
    expect(n).toBe(expected);
    expect(estimateBlockTokens({ type: 'image', source: { type: 'base64', data: 'AAAA' } })).toBeGreaterThan(0);
    expect(estimateBlockTokens({ type: 'tool_result', content: [{ type: 'text', text: 'x'.repeat(32) }] })).toBe(4 + 10);
  });
  it('is monotonic in length (a budget cap computed with it is conservative)', () => {
    let prev = 0;
    for (let i = 0; i < 200; i += 7) {
      const t = estimateTokens('a'.repeat(i));
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
