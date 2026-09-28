// agent/fallbackEcho.ts (WP3) — the fallback-echo transform, applied once when an assistant row is written (01 §5.3).
// Client tools are extracted ONLY from the transformed content.
import type { BetaContentBlock, BetaMessage } from '../contracts/index.ts';

type Block = Record<string, unknown> & { type: string };

/** Block types we know and may echo before the last fallback boundary (when the pairing rules allow). */
const PAIRED_RESULT = (t: string) => t.endsWith('_tool_result');

/**
 * If the content contains `fallback` blocks, let i be the index of the last one. Every block before i is dropped when it is
 * thinking / redacted_thinking / tool_use, a server_tool_use with no matching result block before i (or a result with no
 * matching server_tool_use), or an unknown internal type. Text, paired server-tool blocks, the fallback block and
 * everything after i are kept. Content without a fallback block is returned unchanged (same array contents).
 */
export function fallbackEchoContent(content: readonly BetaContentBlock[]): BetaContentBlock[] {
  const blocks = content as unknown as readonly Block[];
  let last = -1;
  blocks.forEach((b, i) => {
    if (b.type === 'fallback') last = i;
  });
  if (last < 0) return [...content];
  const before = blocks.slice(0, last);
  const useIds = new Set(before.filter((b) => b.type === 'server_tool_use').map((b) => String(b['id'])));
  const resultIds = new Set(before.filter((b) => PAIRED_RESULT(b.type)).map((b) => String(b['tool_use_id'])));
  const kept: Block[] = [];
  for (const b of before) {
    if (b.type === 'text' || b.type === 'compaction' || b.type === 'fallback') kept.push(b);
    else if (b.type === 'server_tool_use') {
      if (resultIds.has(String(b['id']))) kept.push(b);
    } else if (PAIRED_RESULT(b.type)) {
      if (useIds.has(String(b['tool_use_id']))) kept.push(b);
    }
    // thinking, redacted_thinking, tool_use, mcp_* and unknown internal types are dropped
  }
  return [...kept, ...blocks.slice(last)] as unknown as BetaContentBlock[];
}

export function fallbackEcho(msg: BetaMessage): BetaMessage {
  const content = fallbackEchoContent(msg.content);
  return content.length === msg.content.length && content.every((b, i) => b === msg.content[i]) ? msg : { ...msg, content };
}

/** 01 §5.3: served_by_fallback = usage.iterations contains 'fallback_message' && stop_reason !== 'refusal'. */
export function servedByFallback(msg: BetaMessage): boolean {
  const its = (msg.usage?.iterations ?? []) as Array<{ type?: string }>;
  return its.some((e) => e.type === 'fallback_message') && msg.stop_reason !== 'refusal';
}
