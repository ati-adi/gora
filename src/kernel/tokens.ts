// kernel/tokens.ts (WP0) — conservative token estimator (02 §B.2, 03 R2):
// estimateTokens(text) = ceil(len / 3.2); +12 per message; +4 per tool-call wrapper. Conservative for Cyrillic.
export const CHARS_PER_TOKEN = 3.2;
export const TOKENS_PER_MESSAGE = 12;
export const TOKENS_PER_TOOL_CALL = 4;

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** OpenAI/Groq chat-completions shaped messages. */
export interface ChatLikeMessage {
  role?: string;
  content?: string | null | ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  tool_calls?: ReadonlyArray<{ function?: { name?: string; arguments?: string } }> | null;
}

export function estimateChatTokens(msgs: ReadonlyArray<ChatLikeMessage>): number {
  let n = 0;
  for (const m of msgs) {
    n += TOKENS_PER_MESSAGE;
    if (typeof m.content === 'string') n += estimateTokens(m.content);
    else if (Array.isArray(m.content)) for (const p of m.content) n += estimateTokens(typeof (p as { text?: unknown }).text === 'string' ? ((p as { text: string }).text) : JSON.stringify(p));
    for (const c of m.tool_calls ?? []) n += TOKENS_PER_TOOL_CALL + estimateTokens(c.function?.name) + estimateTokens(c.function?.arguments);
  }
  return n;
}

/** Anthropic-format rows (BetaMessageParam-like): text blocks by length, tool_use by name+JSON input, others by JSON length. */
export function estimateParamTokens(msgs: ReadonlyArray<{ role: string; content: unknown }>): number {
  let n = 0;
  for (const m of msgs) {
    n += TOKENS_PER_MESSAGE;
    if (typeof m.content === 'string') {
      n += estimateTokens(m.content);
      continue;
    }
    for (const b of (m.content as ReadonlyArray<Record<string, unknown>>) ?? []) n += estimateBlockTokens(b);
  }
  return n;
}

export function estimateBlockTokens(b: Record<string, unknown>): number {
  switch (b['type']) {
    case 'text':
      return estimateTokens(String(b['text'] ?? ''));
    case 'thinking':
    case 'redacted_thinking':
      return 0; // dropped by the Groq mapping; Anthropic counts them but they are bounded by the model
    case 'tool_use':
      return TOKENS_PER_TOOL_CALL + estimateTokens(String(b['name'] ?? '')) + estimateTokens(JSON.stringify(b['input'] ?? {}));
    case 'tool_result': {
      const c = b['content'];
      if (typeof c === 'string') return TOKENS_PER_TOOL_CALL + estimateTokens(c);
      let n = TOKENS_PER_TOOL_CALL;
      for (const p of (c as ReadonlyArray<Record<string, unknown>>) ?? []) n += estimateBlockTokens(p);
      return n;
    }
    default:
      return estimateTokens(JSON.stringify(b));
  }
}
