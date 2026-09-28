// agent/groq/map.ts (WP3) — pure translation between Gora's canonical Anthropic content blocks and Groq's
// OpenAI-style chat.completions (03 R1), the hard prompt ceiling (03 R2) and the stream accumulator.
// Type-only groq-sdk imports (the runtime import lives in groq/transport.ts).
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam, ChatCompletionTool } from 'groq-sdk/resources/chat/completions';
import type { BetaContentBlock, BetaMessage, BetaStopReason, BetaUsage, MainRequest, UsageNumbers } from '../../contracts/index.ts';
import { ZERO_USAGE } from '../../contracts/llm.ts';
import { BadRequestLlmError, JsonInputError, TransientLlmError } from '../../kernel/errors.ts';
import { estimateChatTokens, estimateTokens, CHARS_PER_TOKEN } from '../../kernel/tokens.ts';

type Block = Record<string, unknown>;

/** Where each translated message came from; drives the hard-ceiling trimming (03 R2). */
export type Origin = 'system' | 'context' | 'omitted' | 'seed' | 'user' | 'run_start' | 'steer' | 'assistant' | 'tool';

export interface Translated {
  messages: ChatCompletionMessageParam[];
  origins: Origin[];
  tools: ChatCompletionTool[];
  toolNames: string[];
  maxCompletionTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
}

export interface TranslateOpts {
  /** Text for an image / document block (vision description, PDF text), precomputed by the transport. */
  mediaText(block: Block): string;
  /** Profile cap on output tokens (1 200 on Groq). */
  maxOutputTokens: number;
}

export const OMITTED_LINE = '[earlier conversation omitted]';
export const TRUNCATED_MARK = ' […truncated]';
export const TOOL_RESULT_TRUNCATE_TOKENS = 600;

const textOf = (b: Block): string => (typeof b['text'] === 'string' ? (b['text'] as string) : '');
const blocks = (c: unknown): Block[] => (Array.isArray(c) ? (c as Block[]) : typeof c === 'string' ? [{ type: 'text', text: c }] : []);

/** A short text for server-tool blocks of past Anthropic runs and for anything the Groq API cannot take. */
export function blockSummary(b: Block): string {
  const t = String(b['type'] ?? '');
  if (t === 'server_tool_use') {
    const input = (b['input'] ?? {}) as Record<string, unknown>;
    const arg = typeof input['query'] === 'string' ? input['query'] : typeof input['url'] === 'string' ? input['url'] : '';
    return `[${String(b['name'] ?? 'server tool')}${arg ? `: "${String(arg).slice(0, 200)}"` : ''}]`;
  }
  if (t === 'web_search_tool_result') {
    const c = b['content'];
    if (Array.isArray(c)) {
      const items = (c as Block[]).filter((x) => x['type'] === 'web_search_result').slice(0, 5).map((x) => `${String(x['title'] ?? '').slice(0, 80)} (${String(x['url'] ?? '')})`);
      return `[search results: ${items.join('; ') || 'none'}]`;
    }
    return '[search results unavailable]';
  }
  if (t === 'web_fetch_tool_result') {
    const c = (b['content'] ?? {}) as Block;
    return `[fetched: ${String(c['url'] ?? 'page')}]`;
  }
  if (t.endsWith('_tool_result')) return `[${t.replace(/_tool_result$/, '')} result]`;
  if (t === 'compaction') return typeof b['content'] === 'string' ? `[earlier context summary] ${b['content'] as string}` : '';
  return '[unsupported block]';
}

/** tool_result content → string: text parts joined; media via mediaText; is_error prefixed 'ERROR: '. */
function toolResultText(b: Block, o: TranslateOpts): string {
  const c = b['content'];
  let s: string;
  if (typeof c === 'string') s = c;
  else
    s = blocks(c)
      .map((p) => (p['type'] === 'text' ? textOf(p) : p['type'] === 'image' || p['type'] === 'document' ? o.mediaText(p) : blockSummary(p)))
      .filter(Boolean)
      .join('\n');
  return b['is_error'] ? `ERROR: ${s}` : s;
}

function userPartText(p: Block, o: TranslateOpts): string {
  switch (p['type']) {
    case 'text':
      return textOf(p);
    case 'image':
    case 'document':
      return o.mediaText(p);
    case 'thinking':
    case 'redacted_thinking':
      return '';
    default:
      return blockSummary(p);
  }
}

/** 03 R1 translation rules. */
export function translateRequest(req: MainRequest, o: TranslateOpts): Translated {
  const messages: ChatCompletionMessageParam[] = [];
  const origins: Origin[] = [];
  const sys = Array.isArray(req.system) ? (req.system as unknown as Block[]).map(textOf).filter(Boolean).join('\n\n') : typeof req.system === 'string' ? req.system : '';
  if (sys) {
    messages.push({ role: 'system', content: sys });
    origins.push('system');
  }
  // the run-start row: the last user row without tool_result blocks
  let runStart = -1;
  req.messages.forEach((m, i) => {
    if (m.role === 'user' && !blocks(m.content).some((b) => b['type'] === 'tool_result')) runStart = i;
  });
  req.messages.forEach((m, i) => {
    const bs = blocks(m.content);
    if (m.role === 'system') {
      messages.push({ role: 'system', content: bs.map(textOf).filter(Boolean).join('\n\n') });
      origins.push('context');
      return;
    }
    if (m.role === 'assistant') {
      let text = '';
      const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      for (const b of bs) {
        const t = b['type'];
        if (t === 'text') text += textOf(b);
        else if (t === 'tool_use') calls.push({ id: String(b['id']), type: 'function', function: { name: String(b['name']), arguments: JSON.stringify(b['input'] ?? {}) } });
        else if (t === 'thinking' || t === 'redacted_thinking' || t === 'fallback') continue;
        else {
          const s = blockSummary(b);
          if (s) text += (text ? '\n' : '') + s;
        }
      }
      messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      origins.push('assistant');
      return;
    }
    // user row: tool results first (G3), then the other blocks as one user message
    const rest: string[] = [];
    let hadResults = false;
    for (const b of bs) {
      if (b['type'] === 'tool_result') {
        hadResults = true;
        messages.push({ role: 'tool', tool_call_id: String(b['tool_use_id']), content: toolResultText(b, o) });
        origins.push('tool');
      } else {
        const s = userPartText(b, o);
        if (s) rest.push(s);
      }
    }
    if (rest.length || !hadResults) {
      const content = rest.join('\n\n');
      messages.push({ role: 'user', content });
      const isSeed = i === 0 && content.includes('<previous_epoch_summary');
      origins.push(hadResults ? 'steer' : isSeed ? 'seed' : i === runStart ? 'run_start' : 'user');
    }
  });
  const tools: ChatCompletionTool[] = [];
  const toolNames: string[] = [];
  for (const t of (req.tools ?? []) as unknown as Block[]) {
    if (typeof t['input_schema'] !== 'object' || t['input_schema'] === null) continue; // server tools have no input_schema
    const name = String(t['name']);
    toolNames.push(name);
    tools.push({ type: 'function', function: { name, description: String(t['description'] ?? ''), parameters: t['input_schema'] as Record<string, unknown> } });
  }
  const effort = (req.output_config as { effort?: string } | undefined)?.effort;
  return {
    messages, origins, tools, toolNames,
    maxCompletionTokens: Math.max(1, Math.min(req.max_tokens, o.maxOutputTokens)),
    reasoningEffort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined,
  };
}

export function estimateTranslated(t: Pick<Translated, 'messages' | 'tools'>): number {
  return estimateChatTokens(t.messages as Parameters<typeof estimateChatTokens>[0]) + (t.tools.length ? estimateTokens(JSON.stringify(t.tools)) : 0);
}

/**
 * 03 R2 hard ceiling: drop the oldest complete turns (never a tool_calls message without its tool results, never a system
 * message, the handoff seed or the current run-start row and what follows it) and insert one '[earlier conversation
 * omitted]' system line; if still too big, truncate the longest tool results to 600 tokens; else prompt_budget.
 */
/** The complete older turns fitToBudget may drop (message indices), oldest first. */
function droppableUnits(origins: readonly Origin[]): number[][] {
  const tail = Math.max(0, origins.lastIndexOf('run_start'));
  const units: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < tail; i++) {
    const og = origins[i]!;
    if (og === 'system' || og === 'context' || og === 'omitted') continue;
    if (og === 'user' || og === 'seed') {
      if (cur.length) units.push(cur);
      cur = og === 'user' ? [i] : [];
      continue;
    }
    cur.push(i);
  }
  if (cur.length) units.push(cur);
  return units;
}

/**
 * Estimated size of what fitToBudget can never drop (system, context, seed, the current run's tail, the tool
 * definitions, plus the omitted line), before any tool-result truncation. The engine uses it to budget toolkits.
 */
export function protectedEstimate(t: Pick<Translated, 'messages' | 'origins' | 'tools'>): number {
  const units = droppableUnits(t.origins);
  if (!units.length) return estimateTranslated(t);
  const dropped = new Set(units.flat());
  return estimateTranslated({ messages: t.messages.filter((_, i) => !dropped.has(i)), tools: t.tools }) + estimateChatTokens([{ role: 'system', content: OMITTED_LINE }]);
}

export function fitToBudget(t: Translated, maxPromptTokens: number): Translated {
  if (estimateTranslated(t) <= maxPromptTokens) return t;
  let messages = [...t.messages];
  let origins = [...t.origins];
  const units = droppableUnits(origins);
  const dropped = new Set<number>();
  let firstDropped = -1;
  const sizeWithout = () => {
    const keep = messages.filter((_, i) => !dropped.has(i));
    return estimateTranslated({ messages: keep, tools: t.tools }) + (dropped.size ? estimateChatTokens([{ role: 'system', content: OMITTED_LINE }]) : 0);
  };
  for (const u of units) {
    if (sizeWithout() <= maxPromptTokens) break;
    for (const i of u) dropped.add(i);
    if (firstDropped < 0) firstDropped = u[0]!;
  }
  if (dropped.size) {
    const nm: ChatCompletionMessageParam[] = [];
    const no: Origin[] = [];
    messages.forEach((m, i) => {
      if (i === firstDropped) {
        nm.push({ role: 'system', content: OMITTED_LINE });
        no.push('omitted');
      }
      if (!dropped.has(i)) {
        nm.push(m);
        no.push(origins[i]!);
      }
    });
    messages = nm;
    origins = no;
  }
  const maxChars = Math.floor(TOOL_RESULT_TRUNCATE_TOKENS * CHARS_PER_TOKEN);
  for (;;) {
    if (estimateTranslated({ messages, tools: t.tools }) <= maxPromptTokens) return { ...t, messages, origins };
    let best = -1;
    let bestLen = maxChars;
    messages.forEach((m, i) => {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > bestLen) {
        best = i;
        bestLen = m.content.length;
      }
    });
    if (best < 0) throw new BadRequestLlmError('prompt_budget: the request does not fit the provider prompt budget', null, 'prompt_budget');
    const m = messages[best] as { role: 'tool'; tool_call_id: string; content: string };
    messages = messages.map((x, i) => (i === best ? { role: 'tool', tool_call_id: m.tool_call_id, content: m.content.slice(0, maxChars) + TRUNCATED_MARK } : x));
  }
}

/** The system note appended before the single tool_use_failed retry (03 R1). */
export function toolUseFailedNote(toolNames: readonly string[], message?: string): ChatCompletionMessageParam {
  const why = message ? ` (${message.replace(/\s+/g, ' ').slice(0, 200)})` : '';
  return { role: 'system', content: `Your previous tool call was invalid${why}. Available tools: ${toolNames.join(', ') || 'none'}. Use exact names and valid JSON arguments, or answer in plain text.` };
}

export function isGptOss(model: string): boolean {
  return model.startsWith('openai/gpt-oss');
}

export function buildStreamParams(t: Translated, model: string): ChatCompletionCreateParamsStreaming {
  const p: ChatCompletionCreateParamsStreaming & { stream_options?: { include_usage: boolean } } = {
    model,
    messages: t.messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: t.maxCompletionTokens,
    ...(t.reasoningEffort ? { reasoning_effort: t.reasoningEffort } : isGptOss(model) ? { reasoning_effort: 'low' as const } : {}),
    ...(t.tools.length ? { tools: t.tools, tool_choice: 'auto' as const } : {}),
  };
  return p;
}

/** Thrown when a chunk carries x_groq.error (server early stop). */
export function serverStopError(reason: string): TransientLlmError {
  return new TransientLlmError('server', `groq stream stopped early: ${reason.slice(0, 200)}`);
}

/**
 * Accumulates the verified chunk shapes (research groq.md): reasoning deltas (delta.reasoning, channel 'analysis'),
 * content deltas, ONE complete tool_call delta (accumulated by index anyway), finish_reason, and usage in x_groq.usage or
 * top-level `usage` of the final `choices: []` chunk.
 */
export class ChunkAccumulator {
  text = '';
  calls: Array<{ id: string; name: string; arguments: string }> = [];
  finish: string | null = null;
  usage: { prompt_tokens: number; completion_tokens: number } | null = null;
  id: string | null = null;
  model: string | null = null;
  private reasoning = false;

  push(chunk: ChatCompletionChunk): { text?: string; thinkingStart?: boolean } {
    const out: { text?: string; thinkingStart?: boolean } = {};
    if (chunk.id && !this.id) this.id = chunk.id;
    if (chunk.model) this.model = chunk.model;
    const u = (chunk.x_groq?.usage ?? (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } | null }).usage) as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
    if (u) this.usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 };
    if (chunk.x_groq?.error) throw serverStopError(chunk.x_groq.error);
    const ch = chunk.choices?.[0];
    if (!ch) return out; // the usage-only chunk has choices: []
    const d = ch.delta ?? {};
    if (d.reasoning && !this.reasoning) {
      this.reasoning = true;
      out.thinkingStart = true;
    }
    if (d.content) {
      this.text += d.content;
      out.text = d.content;
    }
    for (const tc of d.tool_calls ?? []) {
      const c = (this.calls[tc.index] ??= { id: '', name: '', arguments: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.arguments += tc.function.arguments;
    }
    if (ch.finish_reason) this.finish = ch.finish_reason;
    return out;
  }

  /** Text block, then at most ONE tool_use block (gpt-oss makes one call per step; extra parallel calls are dropped). */
  toMessage(requestedModel: string, fallbackId: () => string): BetaMessage {
    const content: BetaContentBlock[] = [];
    if (this.text) content.push({ type: 'text', text: this.text, citations: null });
    const call = this.calls.filter(Boolean).find((c) => c.name);
    if (call) {
      let input: unknown;
      try {
        input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      } catch {
        throw new JsonInputError(`groq tool call arguments are not valid JSON (${call.name})`);
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JsonInputError(`groq tool call arguments are not an object (${call.name})`);
      content.push({ type: 'tool_use', id: call.id || fallbackId(), name: call.name, input } as BetaContentBlock);
    }
    // decide by the calls, never by finish_reason alone (research: 'tool_calls' may come without client calls)
    const stop: BetaStopReason = call ? 'tool_use' : this.finish === 'length' ? 'max_tokens' : 'end_turn';
    return groqMessage({ id: this.id ?? fallbackId(), model: this.model ?? requestedModel, content, stop, usage: this.usage });
  }
}

export function groqUsage(u: { prompt_tokens: number; completion_tokens: number } | null): BetaUsage {
  return {
    cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, fallback_credit: null, inference_geo: null,
    input_tokens: u?.prompt_tokens ?? 0, iterations: null, output_tokens: u?.completion_tokens ?? 0, output_tokens_details: null,
    server_tool_use: null, service_tier: 'standard', speed: null,
  } as BetaUsage;
}

export function groqMessage(o: { id: string; model: string; content: BetaContentBlock[]; stop: BetaStopReason; usage: { prompt_tokens: number; completion_tokens: number } | null }): BetaMessage {
  return {
    id: o.id, type: 'message', role: 'assistant', model: `groq:${o.model}`, content: o.content, container: null, context_management: null, diagnostics: null,
    stop_reason: o.stop, stop_sequence: null, stop_details: null, usage: groqUsage(o.usage),
  } as BetaMessage;
}

export function usageNumbers(u: { prompt_tokens: number; completion_tokens: number } | null): UsageNumbers {
  return { ...ZERO_USAGE, inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0 };
}
