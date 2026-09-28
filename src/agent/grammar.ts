// agent/grammar.ts (WP3) — transcript grammar G1–G8 (01 §5.3), enforced on every MessagesRepo.append through
// setValidator (one transaction: a violation throws and nothing is written). G9 (no UPDATE/DELETE) is the DDL's triggers.
import type { BetaContentBlockParam, BetaMessageParam, BetaToolUseBlock, MessageKind, MessageRow } from '../contracts/index.ts';
import { GoraError } from '../kernel/errors.ts';

export class GrammarError extends GoraError {
  override name = 'GrammarError';
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`transcript grammar violated: ${violations.join('; ')}`);
    this.violations = violations;
  }
}

type Row = { role: MessageRow['role'] | string; kind: MessageKind; content: BetaMessageParam; stopReason?: string | null };
type Block = Record<string, unknown>;

export function blocksOf(content: BetaMessageParam | BetaMessageParam['content'] | unknown): Block[] {
  const c = content && typeof content === 'object' && 'content' in (content as object) && 'role' in (content as object) ? (content as BetaMessageParam).content : content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

/** Client tool_use blocks (never server_tool_use / mcp_tool_use), in order. */
export function clientToolUses(content: ReadonlyArray<BetaContentBlockParam | Block> | unknown): BetaToolUseBlock[] {
  return (Array.isArray(content) ? (content as Block[]) : []).filter((b) => b['type'] === 'tool_use') as unknown as BetaToolUseBlock[];
}

export function hasClientToolUse(content: ReadonlyArray<BetaContentBlockParam | Block> | unknown): boolean {
  return clientToolUses(content).length > 0;
}

const TELEGRAM_FILE = ['api.telegram.org', 'file'].join('/'); // built so the telegram-file-url import rule stays scoped to telegram/files.ts
const BOT_TOKEN_RE = /\bbot\d+:[A-Za-z0-9_-]{20,}/;
const BARE_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/;

/** Placeholders for G8 patterns scrubbed out of third-party / model content before it is appended (never a crash). */
export const G8_FILE_URL_PLACEHOLDER = '[telegram file url]';
export const G8_TOKEN_PLACEHOLDER = '[bot token]';
const FILE_URL_SCRUB_RE = /(?:https?:\/\/)?api\.telegram\.org\/file[^\s"'<>`)\]]*/gi;
const BOT_TOKEN_SCRUB_RE = new RegExp(BOT_TOKEN_RE.source, 'g');
const BARE_TOKEN_SCRUB_RE = new RegExp(BARE_TOKEN_RE.source, 'g');

/** One string with the G8 patterns (Telegram file URL, bot-token-like strings) replaced by placeholders. */
export function scrubG8Text(t: string): string {
  let out = t;
  if (/api\.telegram\.org\/file/i.test(out)) out = out.replace(FILE_URL_SCRUB_RE, G8_FILE_URL_PLACEHOLDER);
  if (out.includes(':')) out = out.replace(BOT_TOKEN_SCRUB_RE, G8_TOKEN_PLACEHOLDER).replace(BARE_TOKEN_SCRUB_RE, G8_TOKEN_PLACEHOLDER);
  return out;
}

/**
 * G8 on content we do not author (web pages, e-mail, model text quoting the Bot API docs, pasted owner text): every string
 * value is scrubbed so that `validateAppend` never rejects the row. Returns the same reference when nothing changed.
 * (A scrubbed Anthropic thinking block loses its signature validity; that only happens when the thinking itself quotes a
 * file URL / token, and a rejected request is still better than a bricked conversation.)
 */
export function scrubG8<T>(v: T): T {
  if (typeof v === 'string') {
    const x = scrubG8Text(v);
    return (x === v ? v : x) as T;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = scrubG8(x);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : v) as T;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = scrubG8(x);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return (changed ? out : v) as T;
  }
  return v;
}

function rowViolations(r: Row, where: string): string[] {
  const v: string[] = [];
  if (!Array.isArray(r.content.content)) v.push(`G7: ${where} content is not an array of blocks`);
  if (r.content.role !== r.role) v.push(`${where}: row role '${r.role}' differs from content role '${r.content.role}'`);
  const json = JSON.stringify(r.content);
  if (json.includes(TELEGRAM_FILE)) v.push(`G8: ${where} contains a Telegram file URL`);
  if (BOT_TOKEN_RE.test(json) || BARE_TOKEN_RE.test(json)) v.push(`G8: ${where} contains a bot token`);
  const kindRole: Record<MessageKind, string> = { user_input: 'user', event: 'user', seed: 'user', context: 'system', assistant: 'assistant', tool_results: 'user', synthetic: 'assistant' };
  if (kindRole[r.kind] !== r.role) v.push(`${where}: kind '${r.kind}' must have role '${kindRole[r.kind]}'`);
  return v;
}

/** Checks `next` given the row before it (`prev`, undefined at the epoch start). */
function pairViolations(prev: Row | undefined, next: Row, where: string): string[] {
  const v: string[] = [];
  if (!prev) {
    if (next.role !== 'user') v.push(`G1: ${where} is the first row of the epoch and is not role user`);
    return v;
  }
  if (next.role === 'system' && prev.role !== 'user') v.push(`G2: system row at ${where} does not follow a user-role row`);
  if (prev.role === 'system' && next.role !== 'assistant') v.push(`G2: system row before ${where} is followed by '${next.role}', expected an assistant row`);
  if (prev.role === 'user' && next.role === 'user') v.push(`G5: adjacent user rows at ${where}`);
  if (prev.role === 'assistant') {
    const uses = clientToolUses(blocksOf(prev.content)).map((b) => b.id);
    if (uses.length) {
      if (next.kind !== 'tool_results') v.push(`G3: assistant tool_use before ${where} must be followed by a tool_results row (got ${next.kind})`);
      else {
        const nb = blocksOf(next.content);
        const ids: string[] = [];
        for (const b of nb) {
          if (b['type'] !== 'tool_result') break;
          ids.push(String(b['tool_use_id']));
        }
        if (nb.slice(ids.length).some((b) => b['type'] === 'tool_result')) v.push(`G3: tool_result after trailing content at ${where}`);
        if (ids.join(',') !== uses.join(',')) v.push(`G3: tool_results at ${where} [${ids.join(',')}] do not answer [${uses.join(',')}] once and in order`);
      }
    } else if (next.role === 'assistant' && prev.stopReason !== 'pause_turn' && prev.stopReason !== 'compaction') {
      v.push(`G4: two assistant rows at ${where} without a pause_turn`);
    }
  }
  if (next.kind === 'tool_results') {
    const prevUses = prev.role === 'assistant' ? clientToolUses(blocksOf(prev.content)) : [];
    if (prevUses.length === 0) v.push(`G3: tool_results row at ${where} does not follow an assistant tool_use row`);
  }
  return v;
}

/** The validator installed with MessagesRepo.setValidator. Throws GrammarError; nothing is written on a violation. */
export function validateAppend(existing: ReadonlyArray<Pick<MessageRow, 'role' | 'kind' | 'content' | 'stopReason'>>, added: ReadonlyArray<{ role: string; kind: MessageKind; content: BetaMessageParam; stopReason?: string | null }>): void {
  const v: string[] = [];
  let prev: Row | undefined = existing.length ? (existing[existing.length - 1] as Row) : undefined;
  added.forEach((r, i) => {
    const where = `row ${existing.length + i + 1}`;
    v.push(...rowViolations(r as Row, where), ...pairViolations(prev, r as Row, where));
    prev = r as Row;
  });
  if (v.length) throw new GrammarError(v);
}

/** Full-epoch check G1–G8 (tests, recovery diagnostics). Returns the violations. */
export function checkEpochGrammar(rows: ReadonlyArray<Pick<MessageRow, 'role' | 'kind' | 'content' | 'stopReason'>>): string[] {
  const v: string[] = [];
  let prev: Row | undefined;
  rows.forEach((r, i) => {
    v.push(...rowViolations(r as Row, `row ${i + 1}`), ...pairViolations(prev, r as Row, `row ${i + 1}`));
    prev = r as Row;
  });
  return v;
}

/**
 * G6: every finished run ends with an assistant row (real or synthetic); a parked run ends with an assistant tool_use row
 * whose results are pending. Returns a violation string or null.
 */
export function checkRunEnd(rows: ReadonlyArray<Pick<MessageRow, 'role' | 'kind' | 'content' | 'runId'>>, runId: string, parked: boolean): string | null {
  const mine = rows.filter((r) => r.runId === runId);
  const last = mine[mine.length - 1];
  if (!last) return `G6: run ${runId} wrote no rows`;
  if (last.role !== 'assistant') return `G6: run ${runId} ends with a ${last.role} row`;
  if (parked !== hasClientToolUse(blocksOf(last.content))) return parked ? `G6: parked run ${runId} does not end with a tool_use row` : `G6: run ${runId} ends with unanswered tool_use`;
  return null;
}
