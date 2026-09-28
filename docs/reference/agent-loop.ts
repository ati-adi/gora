// Gora: streaming tool-calling loop on groq-sdk 1.6.0 (verified live 2026-09-28).
import Groq, { APIError } from 'groq-sdk';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
  ChatCompletionCreateParamsStreaming,
} from 'groq-sdk/resources/chat/completions';

export type ToolHandler = (args: any, ctx: { signal?: AbortSignal }) => Promise<unknown>;

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'server_tool'; phase: 'start' | 'end'; name: string; args: string; output?: string }
  | { type: 'tool_start'; name: string; args: unknown; id: string }
  | { type: 'tool_end'; name: string; id: string; ok: boolean }
  | { type: 'retry'; reason: string; waitMs?: number; model: string }
  | { type: 'usage'; prompt: number; completion: number; model: string };

export interface RunOpts {
  client: Groq;
  model: string;                       // e.g. 'openai/gpt-oss-120b'
  fallbackModel?: string;              // separate per-model rate-limit bucket, e.g. 'openai/gpt-oss-20b'
  messages: ChatCompletionMessageParam[];
  functions: ChatCompletionTool[];     // your {type:'function'} tools
  builtins?: ('browser_search' | 'code_interpreter')[]; // gpt-oss only; executed server-side
  handlers: Record<string, ToolHandler>;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

const isGptOss = (m: string) => m.startsWith('openai/gpt-oss');
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
  });

/** Strip gpt-oss browser citation markers like 【1†L8-L11】 before sending to Telegram. */
export const stripCitations = (s: string) => s.replace(/【[^】]*†[^】]*】/g, '');

export async function runAgent(o: RunOpts): Promise<{ text: string; messages: ChatCompletionMessageParam[]; steps: number }> {
  const messages = [...o.messages];
  const emit = o.onEvent ?? (() => {});
  let model = o.model;
  let toolFailRetries = 0;
  let rateRetries = 0;

  for (let step = 0; step < (o.maxSteps ?? 8); step++) {
    const tools: ChatCompletionTool[] = [
      ...o.functions,
      ...(isGptOss(model) ? (o.builtins ?? []).map((t) => ({ type: t }) as ChatCompletionTool) : []),
    ];
    const params: ChatCompletionCreateParamsStreaming = {
      model,
      messages,
      stream: true,
      max_completion_tokens: o.maxCompletionTokens ?? 2048,
      // qwen3.8: omit/none => no thinking (observed); gpt-oss: low|medium|high (medium default)
      reasoning_effort: o.reasoningEffort ?? (isGptOss(model) ? 'low' : 'none'),
      ...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
    };

    let content = '';
    const calls: ChatCompletionMessageToolCall[] = [];
    let finish: string | null = null;

    try {
      const stream = await o.client.chat.completions.create(params, { signal: o.signal, maxRetries: 0 });
      for await (const chunk of stream) {
        const u = chunk.x_groq?.usage ?? (chunk as any).usage;
        if (u) emit({ type: 'usage', prompt: u.prompt_tokens, completion: u.completion_tokens, model });
        if (chunk.x_groq?.error) throw new Error(`stream aborted by server: ${chunk.x_groq.error}`);
        const ch = chunk.choices[0];            // usage-only chunk has choices: []
        if (!ch) continue;
        const d = ch.delta;
        if (d.reasoning) emit({ type: 'reasoning', delta: d.reasoning });
        if (d.content) { content += d.content; emit({ type: 'text', delta: d.content }); }
        for (const t of d.executed_tools ?? []) {   // built-in / remote-MCP tools run on Groq's side
          const done = t.output != null;
          const name = (t as { name?: string }).name ?? t.type; // API sends `name` (e.g. browser.search, python, MCP tool name); SDK types omit it
          emit({ type: 'server_tool', phase: done ? 'end' : 'start', name, args: String(t.arguments ?? ''), output: done ? String(t.output) : undefined });
        }
        for (const tc of d.tool_calls ?? []) {      // observed: whole call arrives in 1 delta, but accumulate anyway
          const c = (calls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.function.name += tc.function.name;
          if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    } catch (err) {
      if (o.signal?.aborted) throw err;
      const e = err as APIError & { error?: any };
      const code = e.error?.code ?? e.error?.error?.code;
      // 1) Malformed / unknown tool call. Pre-stream: HTTP 400. Mid-stream: SSE `event: error` -> APIError with status undefined.
      if (code === 'tool_use_failed' && toolFailRetries++ < 2) {
        emit({ type: 'retry', reason: 'tool_use_failed', model });
        const names = o.functions.map((f) => f.function?.name).join(', ');
        messages.push({ role: 'system', content: `Your previous tool call was invalid: ${e.error?.message ?? e.message}. Available tools: ${names}. Use exact names and valid JSON arguments, or answer in plain text.` });
        step--; continue;                          // discard partial output; do not count as a step
      }
      // 2) Rate limit (429). Limits are per model -> prefer switching bucket over a long sleep.
      if (e.status === 429 && rateRetries++ < 3) {
        const waitMs = Number(e.headers?.get?.('retry-after') ?? 2) * 1000;
        if (o.fallbackModel && model !== o.fallbackModel && waitMs > 5000) model = o.fallbackModel;
        else await sleep(Math.min(waitMs, 20000), o.signal);
        emit({ type: 'retry', reason: '429', waitMs, model });
        step--; continue;
      }
      // 3) 413 code rate_limit_exceeded => the request alone exceeds the TPM limit (free tier: 8K). Caller must trim history.
      // 4) 5xx / 498 (flex capacity) => retry or fall back.
      if ((e.status === 498 || (e.status ?? 0) >= 500) && rateRetries++ < 3 && o.fallbackModel) {
        model = o.fallbackModel; emit({ type: 'retry', reason: String(e.status), model }); step--; continue;
      }
      throw err;
    }

    const toolCalls = calls.filter(Boolean);
    // NOTE: never rely on finish_reason alone. Observed: remote-MCP server-side calls end with
    // finish_reason 'tool_calls' but NO client tool_calls and a complete answer in content.
    if (toolCalls.length === 0) {
      if (finish === 'length') content += '\n…';   // truncated; caller may offer "continue"
      messages.push({ role: 'assistant', content });
      return { text: stripCitations(content), messages, steps: step + 1 };
    }

    // Do NOT pass reasoning back (Qwen guidance: exclude thinking from history; gpt-oss works without it).
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls } as ChatCompletionMessageParam);

    // gpt-oss emits one call per turn; qwen emits parallel calls -> run concurrently.
    const results = await Promise.all(toolCalls.map(async (c) => {
      let args: unknown; let out: unknown; let ok = true;
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = undefined; }
      emit({ type: 'tool_start', name: c.function.name, args, id: c.id });
      const h = o.handlers[c.function.name];
      try {
        if (!h) throw new Error(`unknown tool ${c.function.name}`);
        if (args === undefined) throw new Error('arguments were not valid JSON');
        out = await h(args, { signal: o.signal });
      } catch (err) { ok = false; out = { error: String((err as Error).message ?? err) }; }
      emit({ type: 'tool_end', name: c.function.name, id: c.id, ok });
      return { role: 'tool' as const, tool_call_id: c.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
    }));
    messages.push(...results);
  }
  throw new Error('maxSteps exceeded');
}
