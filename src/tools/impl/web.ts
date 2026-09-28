// tools/impl/web.ts (WP5) — Groq client tools with the server tools' names (03 R4): web_search / web_fetch over
// services.capabilities.search. Output ≤ 1,500 tokens; the executor wraps it <untrusted source="web">.
// Per-run max uses (03 R4: FULL 5, GROUP/GUEST 3, BIZ 0) are counted here from the run's tool_calls rows (plus an
// in-process counter), and web_fetch mirrors the Anthropic `url_sources` rule (01 §11.3.4): in a tainted run it opens
// only a URL that appeared verbatim in user input or in an earlier web_search / web_fetch result of this epoch, never
// one built by the model from client tool results (an injected email cannot make it fetch evil/?d=<private data>).
import { z } from 'zod';
import type { SearchResult, ToolCallStatus, ToolCtx, ToolOutput, ToolSpec, ToolsetId } from '../../contracts/index.ts';
import { AbortedError, errorMessage, TransientLlmError } from '../../kernel/errors.ts';
import { CHARS_PER_TOKEN } from '../../kernel/tokens.ts';
import { isBlockedDomain } from '../serverTools.ts';
import { L, PUBLIC_SURFACES, READ_PUBLIC, toolError, truncate } from './common.ts';

export const WEB_OUTPUT_MAX_TOKENS = 1500;
const MAX_CHARS = Math.floor(WEB_OUTPUT_MAX_TOKENS * CHARS_PER_TOKEN);

const searchInput = z.object({ query: z.string().min(1).max(300), freshness: z.enum(['day', 'week', 'month']).nullable().optional() });
const fetchInput = z.object({ url: z.string().min(1).max(2000), question: z.string().max(300).nullable().optional() });
type SearchIn = z.infer<typeof searchInput>;
type FetchIn = z.infer<typeof fetchInput>;

/** Formats an answer with a numbered source list, capped at 1,500 estimated tokens. */
export function formatSearchResult(r: SearchResult): string {
  const sources = r.sources.slice(0, 8).map((s, k) => `[${k + 1}] ${truncate(s.title || s.url, 120)} — ${s.url}`);
  const tail = sources.length ? `\n\nSources:\n${sources.join('\n')}` : '\n\nSources: none returned';
  const body = truncate(r.answer.trim(), Math.max(200, MAX_CHARS - tail.length));
  return truncate(`${body}${tail}`, MAX_CHARS);
}

/** 03 R4 precheck for web_fetch: http(s) only, no IP literals, no localhost/.local/.internal names, no blocked domains. */
export function precheckUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http(s) URLs can be opened' };
  if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'missing host' };
  if (/^\[.*\]$/.test(host) || /^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || host.includes(':')) return { ok: false, reason: 'IP addresses cannot be opened' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return { ok: false, reason: 'local addresses cannot be opened' };
  if (isBlockedDomain(host)) return { ok: false, reason: 'this domain is blocked' };
  return { ok: true, url: u };
}

// ── 03 R4 per-run max uses ────────────────────────────────────────────────────────────────────────────────────────
/** Per-run max uses of each Groq client web tool (03 R4: "FULL 5, GROUP/GUEST 3"; BIZ has no web tools). */
export const CLIENT_WEB_MAX_USES: Readonly<Record<ToolsetId, number>> = Object.freeze({ FULL: 5, GROUP: 3, GUEST: 3, BIZ: 0 });
const STARTED: ReadonlySet<ToolCallStatus> = new Set<ToolCallStatus>(['executing', 'done', 'error', 'unknown']);
const MEM_RUNS_MAX = 500;
/** In-process per-run counters: exact for parallel calls in one round even without tool_calls rows. */
const memUses = new Map<string, Map<string, number>>();

function toolsetOf(ctx: ToolCtx): ToolsetId {
  try {
    const t = ctx.services.repos.conversations.get(ctx.conversationId)?.toolset;
    if (t) return t;
  } catch {
    /* fall back to the surface */
  }
  return ctx.surface === 'group' ? 'GROUP' : ctx.surface === 'guest' ? 'GUEST' : ctx.surface === 'biz_draft' ? 'BIZ' : 'FULL';
}

/**
 * Claims one use of `name` in this run (synchronously, so parallel calls of one round are counted exactly). Returns the
 * cap when it is exceeded, else null. The durable count (tool_calls rows that started, including this one) survives a
 * restart; the in-process counter covers stores without rows.
 */
export function claimWebUse(ctx: ToolCtx, name: 'web_search' | 'web_fetch'): number | null {
  if (!ctx.runId) return null;
  let per = memUses.get(ctx.runId);
  if (!per) {
    if (memUses.size >= MEM_RUNS_MAX) memUses.delete(memUses.keys().next().value as string);
    per = new Map();
    memUses.set(ctx.runId, per);
  }
  const mem = (per.get(name) ?? 0) + 1;
  per.set(name, mem);
  let durable = 0;
  try {
    durable = ctx.services.repos.runs.toolCallsFor(ctx.runId).filter((c) => c.name === name && STARTED.has(c.status)).length;
  } catch {
    /* no tool_calls store (tests / approvals): the in-process count decides */
  }
  const max = CLIENT_WEB_MAX_USES[toolsetOf(ctx)];
  return Math.max(mem, durable) > max ? max : null;
}

function overCap(name: string, max: number): ToolOutput<never> {
  return toolError('MAX_USES', `${name} can be used at most ${max} time(s) per reply; answer with what you have`);
}

// ── web_fetch URL provenance (url_sources equivalent) ─────────────────────────────────────────────────────────────
type Block = Record<string, unknown>;
const URL_RE = /https?:\/\/[^\s<>"'`\\{}|^\[\]]+/gi;

/** Canonical form for comparing URLs: WHATWG-normalized, no fragment, no trailing slash on the path. */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = '';
    let out = u.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

function addUrls(text: string, out: Set<string>): void {
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)\]}'"»”’]+$/, '');
    const c = canonicalUrl(raw);
    if (c) out.add(c);
    // "https://x.y/a)" inside markdown: the stripped variant is added above; keep the unstripped one too when it differs.
    if (raw !== m[0]) {
      const c2 = canonicalUrl(m[0]);
      if (c2) out.add(c2);
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).map((b) => (b && b['type'] === 'text' && typeof b['text'] === 'string' ? (b['text'] as string) : '')).join('\n');
}

/**
 * URLs the model may open in a tainted run (01 §11.3.4, url_sources): user_input (text blocks of user rows: owner input,
 * forwarded/steering text) and web tool results (tool_result blocks of web_search / web_fetch, and Anthropic server tool
 * results). Client tool results of any other tool (email, calendar, business chats…) are excluded.
 */
export function allowedFetchUrls(ctx: ToolCtx): Set<string> {
  const out = new Set<string>();
  const rows = ctx.services.repos.messages.load(ctx.conversationId, ctx.epoch);
  const names = new Map<string, string>();
  for (const r of rows) {
    if (r.role !== 'assistant' || !Array.isArray(r.content.content)) continue;
    for (const b of r.content.content as unknown as Block[]) if (b['type'] === 'tool_use' && typeof b['id'] === 'string') names.set(b['id'], String(b['name'] ?? ''));
  }
  for (const r of rows) {
    const content = r.content.content;
    if (typeof content === 'string') {
      if (r.role === 'user') addUrls(content, out);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content as unknown as Block[]) {
      const type = String(b['type'] ?? '');
      if (r.role === 'user' && type === 'text' && typeof b['text'] === 'string') addUrls(b['text'] as string, out);
      else if (r.role === 'user' && type === 'tool_result') {
        const n = names.get(String(b['tool_use_id'] ?? ''));
        if (n === 'web_search' || n === 'web_fetch') addUrls(textOf(b['content']), out);
      } else if (r.role === 'assistant' && type.endsWith('_tool_result') && type !== 'tool_result') addUrls(JSON.stringify(b['content'] ?? ''), out);
    }
  }
  return out;
}

function meta(ctx: ToolCtx) {
  return { userId: ctx.userId, conversationId: ctx.conversationId, runId: ctx.runId };
}

function failure(tool: string, ctx: ToolCtx, e: unknown): ToolOutput<never> {
  if (e instanceof AbortedError) throw e;
  ctx.log.warn({ tool, err: errorMessage(e) }, 'web tool failed');
  if (e instanceof TransientLlmError) return toolError('BUSY', 'web search is busy right now; try again shortly or answer without it');
  return toolError('WEB_UNAVAILABLE', 'web access failed; say so instead of guessing');
}

export const webSearchTool: ToolSpec<SearchIn, SearchResult> = {
  name: 'web_search',
  description: 'Search the web for current facts, news, prices, hours. Call before recommending any business or stating anything time-sensitive.',
  input: searchInput,
  surfaces: PUBLIC_SURFACES,
  parallelSafe: true,
  outputTaint: 'web',
  classify: () => ({ ...READ_PUBLIC, quotaKind: 'web_search' }),
  statusLabel: (i, lang) => L(lang, `🔎 Searching: ${truncate(i.query, 40)}`, `🔎 Ищу: ${truncate(i.query, 40)}`),
  async execute(i, ctx) {
    const capped = claimWebUse(ctx, 'web_search');
    if (capped !== null) return overCap('web_search', capped);
    try {
      const r = await ctx.services.capabilities.search.search({ query: i.query, freshness: i.freshness ?? null, priority: ctx.priority, meta: meta(ctx) });
      return { content: formatSearchResult(r), data: r, untrusted: { source: 'web', label: truncate(i.query, 80) } };
    } catch (e) {
      return failure('web_search', ctx, e);
    }
  },
};

export const webFetchTool: ToolSpec<FetchIn, SearchResult> = {
  name: 'web_fetch',
  description: 'Open one web page and answer a question about it. Call when the user gives a URL or a search result needs checking.',
  input: fetchInput,
  surfaces: PUBLIC_SURFACES,
  parallelSafe: true,
  outputTaint: 'web',
  // Same browser_search cost as a search on Groq: the daily web_search quota applies.
  classify: () => ({ ...READ_PUBLIC, quotaKind: 'web_search' }),
  statusLabel: (i, lang) => {
    let host = i.url;
    try {
      host = new URL(i.url).hostname;
    } catch {
      /* keep raw */
    }
    return L(lang, `🌐 Opening ${truncate(host, 40)}`, `🌐 Открываю ${truncate(host, 40)}`);
  },
  async execute(i, ctx) {
    const capped = claimWebUse(ctx, 'web_fetch');
    if (capped !== null) return overCap('web_fetch', capped);
    const pre = precheckUrl(i.url);
    if (!pre.ok) return toolError('URL_REJECTED', pre.reason);
    if (ctx.taint.size > 0) {
      let allowed: Set<string>;
      try {
        allowed = allowedFetchUrls(ctx);
      } catch (e) {
        ctx.log.warn({ tool: 'web_fetch', err: errorMessage(e) }, 'web_fetch provenance unavailable');
        allowed = new Set();
      }
      const want = canonicalUrl(pre.url.toString());
      if (!want || !allowed.has(want)) {
        ctx.log.info({ tool: 'web_fetch', host: pre.url.hostname }, 'web_fetch: URL without provenance refused in a tainted run');
        return toolError(
          'URL_NOT_FROM_USER_OR_SEARCH',
          'this conversation contains third-party content, so only a URL the user wrote or one listed in a web_search result can be opened; run web_search first or ask the user to paste the link',
        );
      }
    }
    try {
      const r = await ctx.services.capabilities.search.open({ url: pre.url.toString(), question: i.question ?? null, priority: ctx.priority, meta: meta(ctx) });
      return { content: formatSearchResult(r), data: r, untrusted: { source: 'web', label: truncate(pre.url.hostname, 80) } };
    } catch (e) {
      return failure('web_fetch', ctx, e);
    }
  },
};
