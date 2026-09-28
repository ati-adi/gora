// agent/epochs.ts (WP3) — 01 §5.9 epoch rotation + 03 R2 (synchronous rotation on Groq, fast-model handoff note).
//  - rotationReason(): rotate_pending, model/system/tools drift, idle (caching profiles), size.
//  - rotate(): picks the seed (handoff when the old epoch is untainted and a handoff exists / can be made, else the
//    deterministic seed built by code with no model text), updates frozen settings on drift, starts the new epoch (new
//    DEK), and returns the epochs to shred (forget / wipe: the old one; incognito_end: every epoch of the window).
//  - incognito (01 §9): rotations inside an open window never make a handoff; incognito_end seeds from the
//    pre-incognito epoch (never from window text) and shreds the whole window.
//  - handoffFork(): the warm-cache fork (anthropic, profile.caching): the exact conversation request plus ONE
//    non-persisted <gora_event type="handoff_request"/> row; purpose 'handoff'.
import type { ConversationRow, EpochReason, EpochRow, MessageRow, Priority, RunRow, Scope, Services, UserRow } from '../contracts/index.ts';
import { AbortedError, TransientLlmError } from '../kernel/errors.ts';
import { estimateParamTokens } from '../kernel/tokens.ts';
import { neutralizeReservedTags } from '../kernel/tags.ts';
import { CHARS_PER_TOKEN } from '../kernel/tokens.ts';
import { currentSettings, settingsDrift } from './conversations.ts';
import { HANDOFF_INSTRUCTION } from './prompt/system.ts';
import { buildRequest } from './requestBuilder.ts';
import type { BuildDeps } from './requestBuilder.ts';
import type { SideCallsImpl } from './side.ts';
import { recordMainCall } from './usage.ts';

type Block = Record<string, unknown>;

/** 01 §5.9 idle rule: now − lastRequestAt > 55 min and inputTokensLast ≥ 12 000 (only where a warm cache matters). */
export const IDLE_MS = 55 * 60_000;
export const IDLE_MIN_TOKENS = 12_000;
/** handoff_fork runs at lastRequestAt + 45 min (inside the 1 h cache TTL). */
export const HANDOFF_FORK_DELAY_MS = 45 * 60_000;
export const HANDOFF_MAX_TOKENS = 4_000;
export const TAINTED_LINE = '(earlier conversation included external content; details not carried over)';
const SHRED_REASONS: ReadonlySet<EpochReason> = new Set(['forget', 'wipe', 'incognito_end']);
const NO_SEED_REASONS: ReadonlySet<EpochReason> = new Set(['wipe', 'user_new', 'initial']);
const DETERMINISTIC_REASONS: ReadonlySet<EpochReason> = new Set(['upgrade', 'incognito_end', 'incognito_start', 'context_exceeded', 'system_role_unsupported']);

export interface EpochDeps {
  s: Services;
  build: () => BuildDeps;
  side: SideCallsImpl;
}

export function scopeOf(conv: ConversationRow): Scope | null {
  if (conv.kind === 'group' && conv.tgChatId !== null) return { kind: 'group', chatId: conv.tgChatId };
  return conv.userId ? { kind: 'user', userId: conv.userId } : null;
}

/** Why the next run start must rotate (null = no rotation). Only ever evaluated at a run start. */
export function rotationReason(s: Services, conv: ConversationRow, epoch: EpochRow, rows: readonly Pick<MessageRow, 'role' | 'content'>[], now: number): EpochReason | null {
  if (conv.rotatePending) return conv.rotatePending as EpochReason;
  if (conv.singleShot) return null;
  if (rows.length === 0) return null;
  const drift = settingsDrift(conv, currentSettings(s, conv.route, conv.contextMode));
  if (drift) return drift;
  const p = s.config.profile;
  if (p.caching) {
    if (epoch.lastRequestAt !== null && now - epoch.lastRequestAt > IDLE_MS && epoch.inputTokensLast >= IDLE_MIN_TOKENS) return 'idle';
    if (epoch.inputTokensLast >= p.epochRotateTokens) return 'size';
    return null;
  }
  // 03 R2: estimated tokens of the current epoch's rows
  const est = estimateParamTokens(rows.map((r) => r.content) as ReadonlyArray<{ role: string; content: unknown }>);
  return est > p.epochRotateTokens ? 'size' : null;
}

function textOfRow(m: Pick<MessageRow, 'content'>): string {
  const c = m.content.content;
  if (typeof c === 'string') return c;
  return (c as unknown as Block[])
    .map((b) => (b['type'] === 'text' ? String(b['text'] ?? '') : b['type'] === 'tool_use' ? `[called ${String(b['name'])}]` : b['type'] === 'tool_result' ? '[tool result]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Plain transcript of an epoch for the Groq handoff note: most recent part kept within `maxChars`. */
export function transcriptOf(rows: readonly MessageRow[], maxChars: number): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.kind === 'context') continue;
    const t = textOfRow(r).trim();
    if (!t) continue;
    lines.push(`${r.role === 'assistant' ? 'Assistant' : 'Owner'}: ${t}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = '…' + out.slice(out.length - maxChars);
  return out;
}

/** 01 §5.9 deterministic seed: code-built, no model text. */
export function deterministicSeed(s: Services, conv: ConversationRow, epoch: EpochRow, o: { tainted: boolean; filter?: (xs: string[]) => string[]; noQuotes?: boolean }): string {
  const lines: string[] = [];
  let quotes: string[] = [];
  if (!o.noQuotes && !epoch.shreddedAt) try {
    quotes = s.repos.inputs
      .ownerAuthoredSince(conv.id, epoch.startedAt - 1)
      .filter((i) => i.consumedEpoch === epoch.epoch) // consumed in the old epoch (not the inputs of the run now starting)
      .slice(-8)
      .map((i) => i.content.map((b) => b as unknown as Block).filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((t) => (t.length > 300 ? t.slice(0, 300) + '…' : t));
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'seed: owner inputs unavailable');
  }
  if (o.filter) quotes = o.filter(quotes);
  if (quotes.length) {
    lines.push('Recent owner messages:');
    for (const q of quotes) lines.push(`> ${neutralizeReservedTags(q)}`);
  }
  const userId = conv.userId;
  if (userId && (conv.kind === 'dm' || conv.kind === 'topic' || conv.kind === 'mission')) {
    try {
      const pend = s.approvals.listPending(userId).filter((a) => a.conversationId === null || a.conversationId === conv.id).slice(0, 10);
      // code-owned fields only: a.summary carries third-party text (event titles, email subjects) (TRUST-06)
      if (pend.length) lines.push(`Open approvals: ${pend.map((a) => `${a.id} ${a.toolName} (${a.status})`).join(' · ')}`);
    } catch {
      /* optional */
    }
    try {
      const ms = s.missions.list(userId, { active: true }).slice(0, 10);
      if (ms.length) lines.push(`Active missions: ${ms.map((m) => `${m.id} "${m.title}" (${m.status})`).join(' · ')}`);
    } catch {
      /* optional */
    }
    try {
      const rs = s.reminders.list({ kind: 'user', userId }, false).slice(0, 10);
      if (rs.length) lines.push(`Upcoming reminders: ${rs.map((r) => `${r.id} ${r.text} — ${r.display}`).join(' · ')}`);
    } catch {
      /* optional */
    }
  }
  if (o.tainted) lines.push(TAINTED_LINE);
  if (!lines.length) lines.push('(no earlier details carried over)');
  return lines.map((l) => neutralizeReservedTags(l)).join('\n');
}

function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * The warm-cache handoff fork (anthropic). Returns the note or null; records usage (purpose 'handoff'). Never persisted
 * as a row; the note is stored on the epoch (handoffSummary) by the caller.
 */
export async function handoffFork(d: EpochDeps, conv: ConversationRow, epoch: EpochRow, o: { excludeTexts?: readonly string[]; signal?: AbortSignal; priority?: Priority; run?: RunRow | null }): Promise<string | null> {
  const s = d.s;
  const rows = s.repos.messages.load(conv.id, epoch.epoch);
  const last = rows[rows.length - 1];
  if (!last || last.role !== 'assistant') return null; // G5: the extra user row must follow an assistant row
  const exclude = o.excludeTexts?.length ? `\nAlso exclude these forgotten items:\n${o.excludeTexts.map((x) => `- ${neutralizeReservedTags(x)}`).join('\n')}` : '';
  const extra = { role: 'user' as const, content: [{ type: 'text' as const, text: `<gora_event type="handoff_request"/>\n${HANDOFF_INSTRUCTION}${exclude}` }] };
  const req = buildRequest(d.build(), {
    conv,
    run: { id: `handoff:${conv.id}:${epoch.epoch}`, maxTokens: HANDOFF_MAX_TOKENS },
    rows,
    tools: s.registry.toolset(conv.toolset).definitions,
    modelCalls: 0,
    extraRows: [extra],
  });
  const signal = o.signal ?? new AbortController().signal;
  const r = await s.transport.stream(req, { onText() {} }, signal, { priority: o.priority ?? 'background' });
  const pseudoRun = o.run ?? ({ id: null, userId: conv.userId, costMicros: 0, replyRef: { chatId: conv.tgChatId ?? 0 } } as unknown as RunRow);
  recordMainCall(s, { run: pseudoRun, conv, epoch: epoch.epoch, req, r, purpose: 'handoff' });
  if (r.message.stop_reason === 'refusal') return null;
  const note = (r.message.content as unknown as Block[]).filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('\n').trim();
  return note || null;
}

/** 03 R2 Groq handoff note: a side call on the fast model over the epoch's plain transcript. */
export async function handoffNoteGroq(d: EpochDeps, conv: ConversationRow, epoch: EpochRow, user: UserRow | undefined, o: { excludeTexts?: readonly string[]; priority?: Priority; runId?: string | null }): Promise<string | null> {
  const s = d.s;
  const rows = s.repos.messages.load(conv.id, epoch.epoch);
  const maxChars = Math.max(1_000, Math.floor((s.config.profile.maxPromptTokens - 900) * CHARS_PER_TOKEN));
  const transcript = transcriptOf(rows, maxChars);
  if (!transcript) return null;
  return d.side.handoffNote(transcript, o.excludeTexts ?? [], user?.languageCode ?? 'en', { userId: conv.userId, conversationId: conv.id, runId: o.runId ?? null, priority: o.priority ?? 'interactive' });
}

export interface RotationResult {
  conv: ConversationRow;
  epoch: EpochRow;
  oldEpoch: number;
  seed: { source: 'handoff' | 'deterministic'; body: string } | null;
  /** Epochs the caller schedules shred_epoch for (forget / wipe: the old one; incognito_end: every window epoch). */
  shred: number[];
}

/** How far back the epoch chain is walked to find the start of an incognito window. */
const MAX_WINDOW_WALK = 200;

/**
 * The open incognito window of a conversation (01 §9): the epochs from the earliest incognito_start not followed by an
 * incognito_end up to the current epoch (rotations inside the window — size, idle, upgrade, forget… — stay in it).
 * `start` is that incognito_start epoch; null when the current epoch is not inside a window.
 */
export function incognitoWindow(s: Services, conv: Pick<ConversationRow, 'id' | 'epoch'>): { start: EpochRow; epochs: number[] } | null {
  const seen: EpochRow[] = [];
  let startIdx = -1;
  for (let e = conv.epoch, i = 0; e >= 1 && i < MAX_WINDOW_WALK; e--, i++) {
    const row = s.repos.conversations.getEpoch(conv.id, e);
    if (!row || row.reason === 'incognito_end') break;
    seen.push(row);
    if (row.reason === 'incognito_start') startIdx = seen.length - 1;
  }
  if (startIdx < 0) return null;
  return { start: seen[startIdx]!, epochs: seen.slice(0, startIdx + 1).map((r) => r.epoch) };
}

/** 01 §9 incognito_end seed: the pre-incognito epoch's fork handoff (untainted) or its deterministic seed; never window text. */
function preIncognitoSeed(s: Services, conv: ConversationRow, win: { start: EpochRow } | null, old: EpochRow): { source: 'handoff' | 'deterministic'; body: string } {
  const pre = win && win.start.epoch > 1 ? s.repos.conversations.getEpoch(conv.id, win.start.epoch - 1) : undefined;
  if (pre && !pre.shreddedAt) {
    if (pre.handoffSummary && pre.handoffMadeAt !== null && pre.taint.length === 0) return { source: 'handoff', body: pre.handoffSummary };
    return { source: 'deterministic', body: deterministicSeed(s, conv, pre, { tainted: pre.taint.length > 0 }) };
  }
  // no pre-incognito epoch (or no window found: incognito content may sit in the old epoch itself) → no quotes at all
  return { source: 'deterministic', body: deterministicSeed(s, conv, old, { tainted: false, noQuotes: true }) };
}

/**
 * Rotates at a run start (never mid-round). The caller writes the first user row of the new epoch (seed + inputs) and
 * then calls scheduleShred() when `shredOld`.
 */
export async function rotate(d: EpochDeps, conv: ConversationRow, reason: EpochReason, o: { excludeTexts?: readonly string[]; priority?: Priority; signal?: AbortSignal; runId?: string | null } = {}): Promise<RotationResult> {
  const s = d.s;
  const old = s.repos.conversations.currentEpoch(conv.id);
  const tainted = old.taint.length > 0;
  const user = conv.userId ? s.repos.users.getById(conv.userId) : undefined;
  const scope = scopeOf(conv);
  const filter = reason === 'forget' && scope ? (xs: string[]) => (xs.length ? s.memory.filterFingerprinted(scope, xs) : xs) : undefined;
  // incognito (01 §9): inside an open window nothing is summarised by a model and the new epoch stays in the window
  // (shredded at its end); incognito_end seeds from before the window and shreds every window epoch.
  const win = reason === 'incognito_start' ? null : incognitoWindow(s, conv);
  let seed: RotationResult['seed'] = null;
  if (reason === 'incognito_end') {
    seed = preIncognitoSeed(s, conv, win, old);
  } else if (!NO_SEED_REASONS.has(reason)) {
    let note: string | null = null;
    const handoffAllowed = !tainted && !DETERMINISTIC_REASONS.has(reason) && !win;
    if (handoffAllowed) {
      try {
        if (s.config.profile.caching) {
          // a handoff made by the handoff_fork job (after the last request) is reused; forget regenerates with exclusions
          if (reason !== 'forget' && old.handoffSummary && (old.lastRequestAt === null || (old.handoffMadeAt ?? 0) >= old.lastRequestAt)) note = old.handoffSummary;
          else if (reason === 'forget' || reason === 'size' || reason === 'model_switch') note = await handoffFork(d, conv, old, { ...(o.excludeTexts ? { excludeTexts: o.excludeTexts } : {}), ...(o.signal ? { signal: o.signal } : {}), priority: o.priority ?? 'interactive' });
        } else {
          note = await handoffNoteGroq(d, conv, old, user, { ...(o.excludeTexts ? { excludeTexts: o.excludeTexts } : {}), priority: o.priority ?? 'interactive', runId: o.runId ?? null });
        }
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        s.log.warn({ conv: conv.id, reason, err: e instanceof TransientLlmError ? `transient:${e.kind}` : e instanceof Error ? e.name : 'error' }, 'handoff unavailable; deterministic seed');
        note = null;
      }
      if (note && filter) {
        const kept = filter(splitSentences(note));
        note = kept.length ? kept.join(' ') : null;
      }
    }
    seed = note ? { source: 'handoff', body: note } : { source: 'deterministic', body: deterministicSeed(s, conv, old, { tainted, ...(filter ? { filter } : {}) }) };
  }
  // frozen settings follow the code on drift (upgrade / model_switch) and whenever a new epoch starts
  const cur = currentSettings(s, conv.route, reason === 'system_role_unsupported' ? 'inline' : conv.contextMode);
  s.repos.conversations.update(conv.id, {
    rotatePending: null, model: cur.model, effort: cur.effort, toolset: cur.toolset, toolsHash: cur.toolsHash, systemVersion: cur.systemVersion, betas: cur.betas, contextMode: cur.contextMode,
  });
  const epoch = s.repos.conversations.startEpoch(conv.id, reason, seed ? (seed.source === 'handoff' ? 'handoff' : 'deterministic') : 'none', []);
  const next = s.repos.conversations.get(conv.id)!;
  s.log.info({ conv: conv.id, reason, from: old.epoch, to: epoch.epoch, seed: seed?.source ?? 'none' }, 'epoch rotated');
  const shred = reason === 'incognito_end' && win ? [...new Set([...win.epochs, old.epoch])].sort((a, b) => a - b) : SHRED_REASONS.has(reason) ? [old.epoch] : [];
  return { conv: next, epoch, oldEpoch: old.epoch, seed, shred };
}

export function scheduleShred(s: Services, conversationId: string, epoch: number, reason: EpochReason): void {
  s.scheduler.schedule({ kind: 'shred_epoch', runAt: s.clock.now(), refId: conversationId, payload: { conversationId, epoch, reason }, dedupeKey: `shred:${conversationId}:${epoch}` });
}

/** handoff_fork job scheduling: lastRequestAt + 45 min, deduped per conversation (only when the profile caches). */
export function scheduleHandoffFork(s: Services, conv: ConversationRow, epoch: EpochRow): void {
  if (!s.config.profile.caching || conv.singleShot || epoch.taint.length > 0) return;
  const at = (epoch.lastRequestAt ?? s.clock.now()) + HANDOFF_FORK_DELAY_MS;
  s.scheduler.schedule({ kind: 'handoff_fork', runAt: at, ...(conv.userId ? { userId: conv.userId } : {}), refId: conv.id, payload: { conversationId: conv.id, epoch: epoch.epoch }, dedupeKey: `handoff:${conv.id}` });
}
