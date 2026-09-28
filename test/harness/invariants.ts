// test/harness/invariants.ts (WP0) — checks every recorded model request (01 §15.1, §5.2, §5.3).
import type { BetaMessageParam, MainRequest } from '../../src/contracts/index.ts';
import { BETAS } from '../../src/config.ts';

export interface InvariantOptions {
  /** 'anthropic' (default): fallbacks/betas and ≤4 1h cache markers. 'groq' (03 R2 caching:false): no cache markers at all. */
  provider?: 'anthropic' | 'groq';
  /**
   * Groups requests into conversation epochs for the byte-exact prefix check. Default: `metadata.user_id` plus the text
   * of the first `text` block of messages[0] (see defaultEpochKey). WP3 e2e tests can key by conversation/epoch instead.
   */
  epochKey?: (req: MainRequest, i: number) => string;
}

type Block = Record<string, unknown>;
const blocksOf = (m: BetaMessageParam): Block[] => (Array.isArray(m.content) ? (m.content as unknown as Block[]) : []);

/** Grammar checks on one messages array (G1, G2, G3, G5, G7). G4/G6/G9 are history-level and live in WP3's grammar tests. */
export function checkGrammar(messages: readonly BetaMessageParam[]): string[] {
  const v: string[] = [];
  if (messages.length === 0) return ['messages is empty'];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) v.push(`G7: messages[${i}].content is not an array`);
  });
  if (messages[0]!.role !== 'user') v.push(`G1: messages[0] has role '${messages[0]!.role}', expected 'user'`);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (m.role === 'system') {
      if (!prev || prev.role !== 'user') v.push(`G2: system row at messages[${i}] does not follow a user row`);
      if (next && next.role !== 'assistant') v.push(`G2: system row at messages[${i}] is followed by '${next.role}', expected an assistant row or nothing`);
    }
    if (m.role === 'user' && next?.role === 'user') v.push(`G5: adjacent user rows at messages[${i}] and [${i + 1}]`);
    if (m.role === 'assistant') {
      const uses = blocksOf(m).filter((b) => b['type'] === 'tool_use').map((b) => String(b['id']));
      if (uses.length) {
        if (!next || next.role !== 'user') {
          v.push(`G3: assistant tool_use at messages[${i}] is not followed by a tool_results user row`);
          continue;
        }
        const nb = blocksOf(next);
        const results: string[] = [];
        for (const b of nb) {
          if (b['type'] !== 'tool_result') break; // trailing text blocks are allowed after the results
          results.push(String(b['tool_use_id']));
        }
        if (nb.slice(results.length).some((b) => b['type'] === 'tool_result')) v.push(`G3: tool_result blocks after non-result content at messages[${i + 1}]`);
        if (results.join(',') !== uses.join(',')) v.push(`G3: tool_use ids [${uses.join(',')}] at messages[${i}] are not answered once and in order (got [${results.join(',')}])`);
      }
    }
  }
  return v;
}

function collectCacheControls(v: unknown, path: string, out: Array<{ path: string; cc: Record<string, unknown> }>): void {
  if (Array.isArray(v)) return v.forEach((x, i) => collectCacheControls(x, `${path}[${i}]`, out));
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'cache_control' && x && typeof x === 'object') out.push({ path: `${path}.cache_control`, cc: x as Record<string, unknown> });
      else collectCacheControls(x, `${path}.${k}`, out);
    }
  }
}

/** Deep copy of messages with every cache_control removed (request-time markers are not part of the prefix). */
export function stripMarkers<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripMarkers(x)) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'cache_control') o[k] = stripMarkers(x);
    return o as T;
  }
  return v;
}

/** Per-request checks. */
export function checkRequest(req: MainRequest, o: InvariantOptions = {}): string[] {
  const provider = o.provider ?? 'anthropic';
  const v = checkGrammar(req.messages);
  const json = JSON.stringify(req);
  if (json.includes('api.telegram.org')) v.push('G8: request contains api.telegram.org');
  if (/\bbot\d+:[A-Za-z0-9_-]+/.test(json)) v.push('G8: request contains a bot token (bot<digits>:…)');
  else if (/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/.test(json)) v.push('G8: request contains a bare bot token (<digits>:<secret>)'); // kernel/log.ts BARE_TOKEN_RE
  if (json.includes('@blob:')) v.push('request contains an unhydrated @blob: reference');
  const r = req as unknown as Record<string, unknown>;
  if ((req.thinking as { type?: string } | undefined)?.type === 'disabled') v.push("thinking.type === 'disabled' is never used");
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice']) if (r[k] !== undefined) v.push(`${k} is never sent`);
  const markers: Array<{ path: string; cc: Record<string, unknown> }> = [];
  collectCacheControls({ system: req.system, tools: req.tools, messages: req.messages }, 'req', markers);
  if (req.cache_control) markers.push({ path: 'req.cache_control', cc: req.cache_control as unknown as Record<string, unknown> });
  if (provider === 'anthropic') {
    if (req.fallbacks !== 'default') v.push(`fallbacks must be 'default' (got ${JSON.stringify(req.fallbacks)})`);
    if (!(req.betas ?? []).includes(BETAS.fallback)) v.push(`betas must include ${BETAS.fallback}`);
    if (markers.length > 4) v.push(`at most 4 cache_control markers (got ${markers.length})`);
    for (const m of markers) if (m.cc['ttl'] !== '1h') v.push(`cache_control at ${m.path} must have ttl '1h'`);
  } else if (markers.length > 0) {
    v.push(`groq profile: no cache_control markers expected (got ${markers.length})`);
  }
  req.messages.forEach((m, i) => {
    if (m.role !== 'system') return;
    const inner: Array<{ path: string; cc: Record<string, unknown> }> = [];
    collectCacheControls(m.content, `messages[${i}]`, inner);
    if (inner.length) v.push(`cache_control on a system-role message at messages[${i}]`);
  });
  return v;
}

const isForkRow = (m: BetaMessageParam | undefined) => !!m && m.role === 'user' && JSON.stringify(m.content).includes('handoff_request');

/** The text of the first `type:'text'` block of a message, or '' when it has none. */
export function firstTextOf(m: BetaMessageParam | undefined): string {
  if (!m || !Array.isArray(m.content)) return typeof m?.content === 'string' ? m.content : '';
  for (const b of m.content as unknown as Block[]) if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
  return '';
}

/**
 * Default epoch key: metadata.user_id + the first text of messages[0]. It deliberately ignores the rest of the first row
 * (images, documents, markers), so a byte change there — e.g. a re-hydrated @blob image — is compared, not re-grouped.
 * A new epoch starts with a different seed row (<previous_epoch_summary …>), hence a different key.
 */
export function defaultEpochKey(req: MainRequest): string {
  return `${(req.metadata as { user_id?: string } | undefined)?.user_id ?? ''}|${firstTextOf(req.messages[0])}`;
}

/**
 * Whole-sequence checks: every per-request check, plus
 *  - within one conversation epoch (options.epochKey, default: same metadata.user_id and same first text of messages[0]),
 *    request k+1's messages — messages[0] included — begin byte-exactly with request k's (markers stripped).
 *    A handoff fork (its last row is the non-persisted handoff_request) is compared without that row.
 *  - requests with the same tool names (sorted) have byte-identical `tools` and `system` (cache markers stripped).
 */
export function checkRequestSequence(reqs: readonly MainRequest[], o: InvariantOptions = {}): string[] {
  const v: string[] = [];
  reqs.forEach((r, i) => checkRequest(r, o).forEach((x) => v.push(`request #${i}: ${x}`)));
  const groups = new Map<string, number[]>();
  reqs.forEach((r, i) => {
    const key = o.epochKey ? o.epochKey(r, i) : defaultEpochKey(r);
    const g = groups.get(key) ?? [];
    g.push(i);
    groups.set(key, g);
  });
  for (const idx of groups.values()) {
    for (let k = 1; k < idx.length; k++) {
      const prevMsgs = stripMarkers(reqs[idx[k - 1]!]!.messages);
      const cur = stripMarkers(reqs[idx[k]!]!.messages);
      const base = isForkRow(prevMsgs[prevMsgs.length - 1]) ? prevMsgs.slice(0, -1) : prevMsgs;
      if (cur.length < base.length) {
        v.push(`prefix: request #${idx[k]} has fewer messages (${cur.length}) than request #${idx[k - 1]} (${base.length}) in the same epoch`);
        continue;
      }
      for (let i = 0; i < base.length; i++) {
        if (JSON.stringify(base[i]) !== JSON.stringify(cur[i])) {
          v.push(`prefix: request #${idx[k]} messages[${i}] differs from request #${idx[k - 1]} (history must be append-only and byte-exact)`);
          break;
        }
      }
    }
  }
  // Toolset identity = the sorted tool names; within one toolset, tools and system must be byte-identical (not merely
  // equal after canonicalization): a key-order or layout difference breaks the provider's prompt cache.
  const byToolset = new Map<string, { tools: string; sys: string; at: number }>();
  reqs.forEach((r, i) => {
    const names = ((r.tools ?? []) as Array<{ name?: string }>).map((t) => String(t.name ?? '')).sort().join(',');
    const tools = JSON.stringify(stripMarkers(r.tools ?? []));
    const sys = JSON.stringify(stripMarkers(r.system ?? null));
    const seen = byToolset.get(names);
    if (!seen) byToolset.set(names, { tools, sys, at: i });
    else {
      if (seen.tools !== tools) v.push(`request #${i}: tools differ byte-wise from request #${seen.at} with the same tool names (definitions must be byte-identical across users)`);
      if (seen.sys !== sys) v.push(`request #${i}: system differs from request #${seen.at} with the same tools (system+tools must be byte-identical across users)`);
    }
  });
  return v;
}

export function assertRequestInvariants(reqs: readonly MainRequest[], o: InvariantOptions = {}): void {
  const v = checkRequestSequence(reqs, o);
  if (v.length) throw new Error(`request invariants violated:\n  - ${v.join('\n  - ')}`);
}
