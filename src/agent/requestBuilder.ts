// agent/requestBuilder.ts (WP3) — 01 §5.2 request shape + caching layout, made profile-aware by 03 R2.
//  anthropic: SYSTEM_V1 with a 1 h marker, the conversation's frozen toolset, stored rows verbatim + request-time markers
//             (b) run-start row once the run made a model call, (c) latest tool_results row when ≥ 12 rows follow the
//             run-start row, (d) the automatic top-level breakpoint; adaptive thinking, effort, fallbacks:'default',
//             the conversation's betas, compaction config, metadata.user_id = HMAC.
//  groq:      the compact system prompt, the active-toolkit subset, no cache markers / betas / fallbacks / thinking,
//             max_tokens capped by the profile; the hard ceiling is applied by the Groq transport on the translation.
// Markers and blob hydration are request-time only and never persisted.
import type { BetaContentBlockParam, BetaMessageParam, BetaToolUnion, ConversationRow, MainRequest, MessageRow, ProviderProfile, RunRow } from '../contracts/index.ts';
import { BETAS } from '../config.ts';
import { COMPACTION_INSTRUCTIONS, systemTextFor } from './prompt/system.ts';

type Block = Record<string, unknown>;
const MARK = Object.freeze({ type: 'ephemeral', ttl: '1h' });
/** 01 §5.2 (c): a tool_results breakpoint once this many rows follow the run-start row (20-block lookback). */
export const LOOKBACK_ROWS = 12;
export const COMPACTION_TRIGGER_TOKENS = 160_000;

export interface BuildDeps {
  profile: ProviderProfile;
  /** Blob store for '@blob:<id>' sources. */
  getBlob(id: string): { mime: string; bytes: Uint8Array } | undefined;
  /** crypto.hmac('anthropic-user', …) */
  hmacUser(v: string): string;
}

export interface BuildInput {
  conv: ConversationRow;
  run: Pick<RunRow, 'id' | 'maxTokens'>;
  rows: readonly Pick<MessageRow, 'role' | 'kind' | 'content' | 'runId'>[];
  /** Definitions to send (frozen toolset on anthropic; the active-toolkit subset on groq). */
  tools: readonly BetaToolUnion[];
  /** Model calls this run already made (marker (b) only after the first). */
  modelCalls: number;
  /** Extra non-persisted rows appended after the history (the handoff fork's request row). */
  extraRows?: readonly BetaMessageParam[];
}

/** Index of the run-start row (user_input | event | seed written by this run), or -1. */
export function runStartIndex(rows: BuildInput['rows'], runId: string): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.runId === runId && (r.kind === 'user_input' || r.kind === 'event' || r.kind === 'seed')) return i;
  }
  return -1;
}

function hydrateBlock(b: Block, getBlob: BuildDeps['getBlob']): Block {
  const t = b['type'];
  if (t === 'image' || t === 'document') {
    const src = b['source'] as Block | undefined;
    const data = src?.['data'];
    if (src && src['type'] === 'base64' && typeof data === 'string' && data.startsWith('@blob:')) {
      const blob = getBlob(data.slice(6));
      if (!blob) return { type: 'text', text: t === 'image' ? '[image unavailable]' : '[document unavailable]' };
      return { ...b, source: { ...src, media_type: src['media_type'] ?? blob.mime, data: Buffer.from(blob.bytes).toString('base64') } };
    }
    return b;
  }
  if (t === 'tool_result' && Array.isArray(b['content'])) {
    const inner = b['content'] as Block[];
    if (inner.some((x) => x['type'] === 'image' || x['type'] === 'document')) return { ...b, content: inner.map((x) => hydrateBlock(x, getBlob)) };
  }
  return b;
}

/** Replaces '@blob:<id>' sources with the base64 of the immutable stored bytes (01 §5.2 rule 7). Copies only what changes. */
export function hydrateBlobs(msgs: readonly BetaMessageParam[], getBlob: BuildDeps['getBlob']): BetaMessageParam[] {
  return msgs.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const bs = m.content as unknown as Block[];
    if (!JSON.stringify(bs).includes('@blob:')) return m;
    return { ...m, content: bs.map((b) => hydrateBlock(b, getBlob)) as unknown as BetaContentBlockParam[] } as BetaMessageParam;
  });
}

function withMarkerOnLast(m: BetaMessageParam): BetaMessageParam {
  if (!Array.isArray(m.content) || m.content.length === 0) return m;
  const bs = [...(m.content as unknown as Block[])];
  const last = bs[bs.length - 1]!;
  if (last['type'] === 'thinking' || last['type'] === 'redacted_thinking') return m;
  bs[bs.length - 1] = { ...last, cache_control: { ...MARK } };
  return { ...m, content: bs as unknown as BetaContentBlockParam[] } as BetaMessageParam;
}

/** Explicit message breakpoints (b) and (c); never on role:'system' rows. Returns a copy. */
export function addCacheMarkers(msgs: readonly BetaMessageParam[], kinds: readonly string[], runStart: number, modelCalls: number): BetaMessageParam[] {
  const out = [...msgs];
  if (runStart >= 0 && modelCalls >= 1 && out[runStart] && out[runStart]!.role !== 'system') out[runStart] = withMarkerOnLast(out[runStart]!);
  if (runStart >= 0 && out.length - 1 - runStart >= LOOKBACK_ROWS) {
    for (let i = out.length - 1; i > runStart; i--) {
      if (kinds[i] === 'tool_results') {
        if (out[i]!.role !== 'system') out[i] = withMarkerOnLast(out[i]!);
        break;
      }
    }
  }
  return out;
}

export function buildRequest(d: BuildDeps, x: BuildInput): MainRequest {
  const { conv } = x;
  const rows = x.rows.map((r) => r.content);
  const all = [...rows, ...(x.extraRows ?? [])];
  const hydrated = hydrateBlobs(all, d.getBlob);
  const metadata = { user_id: d.hmacUser(conv.userId ?? conv.scopeKey).slice(0, 32) };
  if (d.profile.provider === 'groq') {
    return {
      model: conv.model,
      max_tokens: Math.max(1, Math.min(x.run.maxTokens, d.profile.maxOutputTokens)),
      system: [{ type: 'text', text: systemTextFor(d.profile.systemVariant) }],
      tools: [...x.tools],
      messages: hydrated,
      output_config: { effort: conv.effort === 'high' ? 'medium' : 'low' },
      metadata,
    } as MainRequest;
  }
  const kinds = [...x.rows.map((r) => r.kind), ...(x.extraRows ?? []).map(() => 'extra')];
  const rs = runStartIndex(x.rows, x.run.id);
  const messages = d.profile.caching ? addCacheMarkers(hydrated, kinds, rs, x.modelCalls) : hydrated;
  const compaction = conv.betas.includes(BETAS.compaction);
  const req: MainRequest = {
    model: conv.model,
    max_tokens: x.run.maxTokens,
    system: [{ type: 'text', text: systemTextFor(d.profile.systemVariant), ...(d.profile.caching ? { cache_control: { ...MARK } } : {}) }],
    tools: x.tools.filter((t) => (t as { name?: string }).name !== 'use_toolkit'),
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: conv.effort },
    ...(d.profile.caching ? { cache_control: { ...MARK } } : {}),
    fallbacks: 'default',
    betas: [...conv.betas],
    ...(compaction
      ? { context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: COMPACTION_TRIGGER_TOKENS }, instructions: COMPACTION_INSTRUCTIONS }] } }
      : {}),
    metadata,
  } as MainRequest;
  return req;
}
