// agent/demoTransport.ts (WP3) — the no-key transport for development (never in production; config.ts refuses it).
// It streams a short, deterministic notice that no LLM key is configured, never calls tools, and returns parsed:null for
// side calls, so every non-LLM path of the bot (commands, cards, reminders, Mini App) can be exercised without a key.
import type { BetaContentBlock, BetaMessage, Clock, LlmTransport, MainRequest, SideRequest, SideResult, StreamHandlers, StreamResult } from '../contracts/index.ts';
import { ZERO_USAGE } from '../contracts/llm.ts';
import { AbortedError, BadRequestLlmError } from '../kernel/errors.ts';
import { estimateParamTokens } from '../kernel/tokens.ts';

export const DEMO_NOTICE_EN = 'Demo mode: no LLM key is configured, so I cannot think yet. Set GROQ_API_KEY or ANTHROPIC_API_KEY and restart.';
export const DEMO_NOTICE_RU = 'Демо-режим: ключ LLM не настроен, поэтому я пока не могу отвечать по существу. Задайте GROQ_API_KEY или ANTHROPIC_API_KEY и перезапустите.';

function lastUserText(req: MainRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    const t = (c as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text!).join(' ');
    if (t) return t;
  }
  return '';
}

export function createDemoTransport(clock: Clock): LlmTransport {
  let n = 0;
  const store = new Map<string, { bytes: Uint8Array; filename: string; mime: string }>();

  function reply(req: MainRequest): BetaMessage {
    const cyr = /[Ѐ-ӿ]/.test(lastUserText(req));
    const text = cyr ? DEMO_NOTICE_RU : DEMO_NOTICE_EN;
    const content: BetaContentBlock[] = [{ type: 'text', text, citations: null } as BetaContentBlock];
    return {
      id: `demo_${(++n).toString(36)}`, type: 'message', role: 'assistant', model: 'demo', content, container: null, context_management: null,
      diagnostics: null, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      usage: {
        cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, fallback_credit: null, inference_geo: null,
        input_tokens: estimateParamTokens(req.messages as ReadonlyArray<{ role: string; content: unknown }>), iterations: null,
        output_tokens: Math.ceil(text.length / 4), output_tokens_details: null, server_tool_use: null, service_tier: 'standard', speed: null,
      },
    } as BetaMessage;
  }

  async function stream(req: MainRequest, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    const started = clock.now();
    if (signal.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
    const msg = reply(req);
    const text = (msg.content[0] as { text: string }).text;
    h.onBlockStart?.({ index: 0, type: 'text' });
    for (const part of text.match(/.{1,40}(\s|$)/g) ?? [text]) {
      if (signal.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
      h.onText(part);
    }
    return { message: msg, requestId: null, ttftMs: 0, latencyMs: clock.now() - started };
  }

  return {
    mode: 'demo',
    stream,
    async create(req, signal) {
      return stream(req, { onText() {} }, signal ?? new AbortController().signal);
    },
    async parse<T>(_req: SideRequest<T>): Promise<SideResult<T>> {
      return { parsed: null, stopReason: 'demo', usage: { ...ZERO_USAGE }, requestId: null };
    },
    files: {
      async upload(bytes, filename, mime) {
        const id = `demo_file_${store.size + 1}`;
        store.set(id, { bytes, filename, mime });
        return id;
      },
      async download(fileId) {
        const f = store.get(fileId);
        if (!f) throw new BadRequestLlmError(`file not found: ${fileId}`, null, 'file_not_found');
        return f;
      },
      async delete(fileId) {
        store.delete(fileId);
      },
    },
  };
}
