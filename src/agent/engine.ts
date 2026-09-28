// agent/engine.ts (WP3) — the run engine (01 §5.4–5.11 + 03 R1/R2/R3/R6): kick/coalesce, drive(), tool rounds, park and
// wake, stop, errors/refusals/max_tokens/pause_turn, epochs at run start, finalize, crash recovery.
// Rules: everything persisted is appended through MessagesRepo (grammar-validated, one tx per append); nothing from an
// aborted or failed model call is persisted; every terminal path leaves G6 satisfied; no await inside db.tx().
import type {
  AgentRunner, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaToolResultBlockParam, BetaToolUnion, BetaToolUseBlock, ChannelFactory, ChannelKind,
  ConversationRow, Effect, EpochReason, GoraEvent, InputRow, MainRequest, MessageRow, Priority, ReplyChannel, ReplyRef, RoundOutcome, RunRow, RunTrigger,
  SentRef, Services, StreamResult, TaintSource, ToolkitId, WakePayload,
} from '../contracts/index.ts';
import { TOOLKIT_IDS } from '../contracts/tools.ts';
import { uiLang } from '../contracts/i18n.ts';
import { AbortedError, BadRequestLlmError, JsonInputError, TransientLlmError, errorMessage } from '../kernel/errors.ts';
import { CHARS_PER_TOKEN } from '../kernel/tokens.ts';
import { buildContextText } from './context.ts';
import { deterministicSeed, rotate, rotationReason, scheduleHandoffFork, scheduleShred } from './epochs.ts';
import type { EpochDeps } from './epochs.ts';
import { fallbackEcho } from './fallbackEcho.ts';
import { clientToolUses, hasClientToolUse, scrubG8 } from './grammar.ts';
import { eventBlocks, inputBlocks, plainText, seedBlock, steeringBlocks, text } from './inputs.ts';
import { buildRequest, runStartIndex } from './requestBuilder.ts';
import type { BuildDeps } from './requestBuilder.ts';
import { droppableKits, fitKitsToBudget, kitsOfTools, preloadKits, selectActiveKits } from './toolkits.ts';
import type { ToolkitStateImpl } from './toolkits.ts';
import { recordFailedCall, recordMainCall } from './usage.ts';

type Block = Record<string, unknown>;

export const LEASE_MS = 120_000;
export const LEASE_RENEW_MS = 30_000;
export const KICK_DEBOUNCE_MS = 700;
export const KICK_MAX_MS = 2_000;
export const RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;
export const MAX_TOKENS_CAP = 128_000;
export const MAX_CONTINUATIONS = 5;
export const CONTEXT_REFRESH_MS = 5 * 60_000;
export const STOPPED_MARK = '[stopped by user]';
export const CANCELLED_MISSION_MARK = '[mission cancelled by user]';
export const MISSION_BUDGET_MARK = '[mission paused: budget used up — waiting for the owner to raise it]';
export const MISSION_ENDED_MARK = '[mission ended — no further steps]';
const EVENT_INPUT_KEY = '__gora_event';

export interface EngineDeps {
  s: Services;
  channels: () => ChannelFactory;
  toolkits: ToolkitStateImpl;
  epochs: EpochDeps;
  build: () => BuildDeps;
  /** In-memory only (never persisted): forgotten texts to exclude from the next handoff (01 §5.9 forget). */
  excludeTexts: Map<string, string[]>;
}

interface Live {
  runId: string;
  conversationId: string;
  abort: AbortController;
  draft: { chatId: number; threadId: number; draftId: number } | null;
}

/** '[Owner, …]' etc. helpers */
const blocksOfRow = (m: Pick<MessageRow, 'content'>): Block[] => (Array.isArray(m.content.content) ? (m.content.content as unknown as Block[]) : []);
const synthetic = (t: string): BetaMessageParam => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

function missionIdOf(conv: ConversationRow): string | undefined {
  return conv.scopeKey.startsWith('mission:') ? conv.scopeKey.slice('mission:'.length) : undefined;
}

function channelOf(conv: ConversationRow): ChannelKind {
  switch (conv.kind) {
    case 'group':
      return 'group';
    case 'guest':
      return 'guest';
    case 'biz_draft':
      return 'biz_owner';
    default:
      return 'dm_stream';
  }
}

function triggerOf(conv: ConversationRow): RunTrigger {
  switch (conv.kind) {
    case 'group':
      return 'group';
    case 'guest':
      return 'guest';
    case 'biz_draft':
      return 'biz_draft';
    default:
      return 'user_input';
  }
}

export function encodeEventInput(ev: GoraEvent): BetaContentBlockParam[] {
  return [{ type: 'text', text: JSON.stringify({ [EVENT_INPUT_KEY]: ev }) }];
}

export function decodeEventInput(i: InputRow): GoraEvent | null {
  if (i.kind !== 'event') return null;
  const t = (i.content[0] as unknown as Block | undefined)?.['text'];
  if (typeof t !== 'string') return null;
  try {
    const v = JSON.parse(t) as Record<string, unknown>;
    const ev = v[EVENT_INPUT_KEY] as GoraEvent | undefined;
    return ev && typeof ev.type === 'string' && typeof ev.body === 'string' ? ev : null;
  } catch {
    return null;
  }
}

/** URL hosts and e-mail addresses the model may link to: those retrieved or given in this epoch (01 §11.4). */
export function allowedFromRows(rows: readonly Pick<MessageRow, 'role' | 'kind' | 'content'>[]): { hosts: Set<string>; emails: Set<string> } {
  const hosts = new Set<string>();
  const emails = new Set<string>();
  for (const r of rows) {
    if (r.role === 'assistant' && r.kind !== 'assistant') continue;
    let src = '';
    if (r.role === 'assistant') {
      // server tool results carried in assistant rows (web_search / web_fetch results)
      src = JSON.stringify(blocksOfRow(r).filter((b) => String(b['type'] ?? '').endsWith('_tool_result')));
    } else src = JSON.stringify(r.content.content);
    for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi)) hosts.add(m[1]!.toLowerCase());
    for (const m of src.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) emails.add(m[0].toLowerCase());
  }
  return { hosts, emails };
}

export interface EngineRunner extends AgentRunner {
  /** Starts (or queues) the next run of a conversation: a queued event run, else one over the pending inputs. */
  startNext(conversationId: string): void;
  /** Rotation for an idle conversation (the epoch_rotate job). */
  rotateNow(conversationId: string): Promise<'done' | 'busy' | 'none'>;
  /** Drives a run by id (resume_run / recovery). */
  launch(runId: string): void;
  /** Wakes one parked run (the run_wake timer job). */
  wakeById(runId: string, p: WakePayload): Promise<boolean>;
}

export function createEngine(d: EngineDeps): EngineRunner {
  const s = d.s;
  const log = s.log.child({ mod: 'engine' });
  const live = new Map<string, Live>();
  const inflight = new Set<Promise<void>>();
  const kicks = new Map<string, { first: number; handle: unknown }>();
  const replyRefOverride = new Map<string, ReplyRef>();
  /** Rotations in flight by the epoch_rotate job (rotateNow), per conversation. */
  const rotations = new Map<string, Promise<void>>();
  let shuttingDown = false;

  const t = (userId: string | null, key: Parameters<Services['strings']['t']>[0], vars?: Record<string, string | number>) => {
    const u = userId ? s.repos.users.getById(userId) : undefined;
    return s.strings.t(key, uiLang(u?.languageCode ?? null), vars);
  };

  function track(p: Promise<void>): void {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }

  // ───────────────────────── kick / coalescing (01 §5.10)

  function kick(conversationId: string, o?: { replyRef?: ReplyRef }): void {
    if (o?.replyRef) replyRefOverride.set(conversationId, o.replyRef);
    if (shuttingDown) return;
    const now = s.clock.now();
    const k = kicks.get(conversationId);
    const first = k?.first ?? now;
    if (k) s.clock.clearTimeout(k.handle);
    const delay = Math.max(0, Math.min(KICK_DEBOUNCE_MS, first + KICK_MAX_MS - now));
    const handle = s.clock.setTimeout(() => fireKick(conversationId), delay);
    kicks.set(conversationId, { first, handle });
  }

  function fireKick(conversationId: string): void {
    const k = kicks.get(conversationId);
    if (k) s.clock.clearTimeout(k.handle);
    kicks.delete(conversationId);
    try {
      startNext(conversationId);
    } catch (e) {
      log.error({ conv: conversationId, err: errorMessage(e) }, 'kick failed');
    }
  }

  function startNext(conversationId: string): void {
    if (shuttingDown) return;
    const conv = s.repos.conversations.get(conversationId);
    if (!conv || conv.status !== 'active') return;
    if (conv.activeRunId) {
      const active = s.repos.runs.get(conv.activeRunId);
      if (active && active.state === 'parked') {
        if (s.repos.inputs.pending(conversationId).some((i) => i.author === 'owner' && !i.untrusted))
          track(wakeRun(active, { reason: 'user_input' }).then(() => undefined));
        return;
      }
      if (active && (active.state === 'running' || active.state === 'queued' || active.state === 'retry_wait')) {
        if (active.state === 'queued' && !live.has(active.id)) launch(active.id);
        return; // pending input is steering (tool round) or waits for finalize → startNext
      }
      // a stale pointer to a terminal run: release it
      s.repos.conversations.casActiveRun(conversationId, conv.activeRunId, null);
    }
    // a queued event run of this conversation goes first
    const queued = s.repos.runs.recoverable(s.clock.now()).filter((r) => r.conversationId === conversationId && r.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (queued) {
      if (s.repos.conversations.casActiveRun(conversationId, null, queued.id)) launch(queued.id);
      return;
    }
    const pending = s.repos.inputs.pending(conversationId);
    if (pending.length === 0) return;
    const newest = pending[pending.length - 1]!;
    const override = replyRefOverride.get(conversationId);
    replyRefOverride.delete(conversationId);
    const missionId = missionIdOf(conv);
    const replyRef: ReplyRef = override ?? {
      chatId: conv.tgChatId ?? newest.tgChatId ?? 0,
      ...(conv.threadId ? { threadId: conv.threadId } : {}),
      ...(newest.tgMessageId ? { triggerMessageId: newest.tgMessageId } : {}),
      ...(conv.businessConnectionId ? { businessConnectionId: conv.businessConnectionId } : {}),
      ...(missionId ? { missionId } : {}),
    };
    const run = s.repos.runs.create({
      conversationId, userId: conv.userId, epoch: conv.epoch, trigger: triggerOf(conv), triggerRef: null, channel: channelOf(conv), replyRef,
      maxTokens: s.config.routes[conv.route].maxTokens, priority: 'interactive',
    });
    if (!s.repos.conversations.casActiveRun(conversationId, null, run.id)) {
      s.repos.runs.update(run.id, { state: 'cancelled', stopCategory: 'superseded' });
      return;
    }
    launch(run.id);
  }

  function startEventRun(conversationId: string, ev: GoraEvent, o: { channel: ChannelKind; replyRef: ReplyRef; taint?: TaintSource[]; priority?: Priority }): string {
    const conv = s.repos.conversations.get(conversationId);
    if (!conv) throw new Error(`startEventRun: unknown conversation ${conversationId}`);
    const trigger: RunTrigger = ev.type === 'mission_start' ? 'mission_start' : ev.type === 'continue' ? 'continue' : 'event';
    const run = s.repos.runs.create({
      conversationId, userId: conv.userId, epoch: conv.epoch, trigger, triggerRef: ev.ref ?? null, channel: o.channel, replyRef: o.replyRef,
      maxTokens: s.config.routes[conv.route].maxTokens, ...(o.taint ? { taint: o.taint } : {}), priority: o.priority ?? 'interactive',
    });
    const inputId = s.repos.inputs.add({
      conversationId, kind: 'event', author: 'system', untrusted: false, content: encodeEventInput(ev), tgUpdateId: null, tgChatId: o.replyRef.chatId ?? null,
      tgMessageId: null, fromTgUserId: null, replyToCardId: null,
    });
    s.repos.inputs.markConsumed([inputId], run.id, conv.epoch); // reserved for this run; never picked up as pending input
    if (s.repos.conversations.casActiveRun(conversationId, null, run.id)) launch(run.id);
    return run.id;
  }

  function launch(runId: string): void {
    if (live.has(runId) || shuttingDown) return;
    track(drive(runId));
  }

  // ───────────────────────── drive() (01 §5.4)

  async function drive(runId: string): Promise<void> {
    const claimed = s.repos.runs.claim(runId, LEASE_MS);
    if (!claimed) return;
    const run = claimed;
    let conv = s.repos.conversations.get(run.conversationId);
    if (!conv) {
      s.repos.runs.update(run.id, { state: 'failed', error: 'conversation missing' });
      return;
    }
    if (conv.activeRunId !== run.id && !s.repos.conversations.casActiveRun(conv.id, null, run.id)) {
      s.repos.runs.update(run.id, { state: 'queued', leaseUntil: null }); // another run holds the conversation
      return;
    }
    conv = s.repos.conversations.get(conv.id)!;
    const abort = new AbortController();
    const L: Live = { runId, conversationId: conv.id, abort, draft: null };
    live.set(runId, L);
    let leaseTimer: unknown = null;
    const renew = () => {
      leaseTimer = s.clock.setTimeout(() => {
        try {
          s.repos.runs.renewLease(runId, LEASE_MS);
        } catch {
          /* the run may be gone */
        }
        renew();
      }, LEASE_RENEW_MS);
    };
    renew();
    let ch: ReplyChannel | null = null;
    try {
      ch = d.channels().forRun(run, conv, (draftId) => {
        L.draft = { chatId: run.replyRef.chatId, threadId: run.replyRef.threadId ?? 0, draftId };
        try {
          s.repos.runs.update(runId, { draftId });
        } catch {
          /* best effort */
        }
      });
      await new Driver(run, conv, ch, L).go();
    } catch (e) {
      log.error({ runId, err: errorMessage(e), name: e instanceof Error ? e.name : 'error' }, 'run crashed');
      try {
        const cur = s.repos.runs.get(runId);
        if (cur && (cur.state === 'running' || cur.state === 'queued')) {
          const c2 = s.repos.conversations.get(conv.id)!;
          ensureAssistantLast(c2, runId, t(run.userId, 'no_reply_temp_error'));
          if (cur.phase === 'start') {
            // a poison input must not crash-loop: the inputs this run would have taken are consumed by the failed run
            const pending = s.repos.inputs.pending(conv.id);
            if (pending.length) s.repos.inputs.markConsumed(pending.map((i) => i.id), runId, c2.epoch);
          }
          s.repos.runs.update(runId, { state: 'failed', error: errorMessage(e).slice(0, 300), leaseUntil: null });
          s.repos.conversations.casActiveRun(conv.id, runId, null);
          await ch?.fail(t(run.userId, 'failed_ref', { ref: runId.slice(-8) }), true).catch(() => undefined);
          // no automatic restart after a crash (the owner's next message or the Retry button starts a new run)
        }
      } catch (e2) {
        log.error({ runId, err: errorMessage(e2) }, 'run crash cleanup failed');
      }
    } finally {
      if (leaseTimer !== null) s.clock.clearTimeout(leaseTimer);
      live.delete(runId);
    }
  }

  function startNextSoon(conversationId: string): void {
    if (shuttingDown) return;
    // pending input queued during the run starts the next run right away (01 §5.4 finalize step 5)
    try {
      startNext(conversationId);
    } catch (e) {
      log.warn({ conv: conversationId, err: errorMessage(e) }, 'startNext failed');
    }
  }

  /**
   * Every transcript append of the engine. G8 (01 §5.3) is a scrub on content we do not author (tool output, web pages,
   * e-mail, pasted text, model text quoting the Bot API docs), not a crash: the patterns are replaced by placeholders.
   */
  function appendRows(...[conversationId, epoch, rows]: Parameters<Services['repos']['messages']['append']>): number[] {
    return s.repos.messages.append(conversationId, epoch, rows.map((r) => ({ ...r, content: scrubG8(r.content) })));
  }

  /**
   * Closes a tool round left open by a crash (the epoch ends with an assistant client tool_use and no run is parked on
   * it): a tool_results row (stored results, else OUTCOME_UNKNOWN errors) plus a synthetic assistant row, so G3/G6 hold
   * and the next owner message can be appended. Returns true when it appended.
   */
  function closeOpenRound(conv: ConversationRow, runId: string, note: string): boolean {
    const last = s.repos.messages.last(conv.id, conv.epoch);
    if (!last || last.role !== 'assistant' || !last.hasClientToolUse) return false;
    const uses = clientToolUses(blocksOfRow(last));
    const owner = last.runId ?? runId;
    let stored: ReturnType<Services['repos']['runs']['toolCallsFor']> = [];
    try {
      stored = s.repos.runs.toolCallsFor(owner, last.seq);
    } catch {
      /* none */
    }
    const unknown = (id: string): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ error: 'OUTCOME_UNKNOWN', note: 'Interrupted: outcome unknown; do not assume it ran.' }), is_error: true });
    const withStored: BetaToolResultBlockParam[] = uses.map((u) => {
      const tc = stored.find((x) => x.toolUseId === u.id);
      if (tc && tc.result !== null && tc.result !== undefined) return { type: 'tool_result', tool_use_id: u.id, content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result), ...(tc.isError ? { is_error: true } : {}) };
      return unknown(u.id);
    });
    const rowsFor = (results: BetaToolResultBlockParam[]): Parameters<Services['repos']['messages']['append']>[2] => [
      { role: 'user', kind: 'tool_results', content: { role: 'user', content: results as unknown as BetaContentBlockParam[] }, runId },
      { role: 'assistant', kind: 'synthetic', content: synthetic(note), runId },
    ];
    try {
      appendRows(conv.id, conv.epoch, rowsFor(withStored));
    } catch (e) {
      // the stored results themselves may be what failed: fall back to bare OUTCOME_UNKNOWN results
      log.warn({ conv: conv.id, err: errorMessage(e) }, 'closing the open round with stored results failed');
      appendRows(conv.id, conv.epoch, rowsFor(uses.map((u) => unknown(u.id))));
    }
    return true;
  }

  /** G6: if the epoch's last row is not an assistant row of this run's making, append a synthetic one. */
  function ensureAssistantLast(conv: ConversationRow, runId: string, note: string): void {
    const last = s.repos.messages.last(conv.id, conv.epoch);
    if (!last) return;
    if (last.role === 'assistant') {
      if (last.hasClientToolUse) closeOpenRound(conv, runId, note); // a crashed tool round (never a parked run here)
      return;
    }
    appendRows(conv.id, conv.epoch, [{ role: 'assistant', kind: 'synthetic', content: synthetic(note), runId }]);
  }

  // ───────────────────────── the per-run driver

  class Driver {
    run: RunRow;
    conv: ConversationRow;
    ch: ReplyChannel;
    L: Live;
    effects: Effect[] = [];
    modelCalls = 0;
    jsonRetries = 0;
    rotatedInRun = false;
    lastContextAt = 0;
    startText = '';
    /** Text streamed by the current (not yet persisted) model call. */
    pending = '';

    constructor(run: RunRow, conv: ConversationRow, ch: ReplyChannel, L: Live) {
      this.run = run;
      this.conv = conv;
      this.ch = ch;
      this.L = L;
    }

    get signal(): AbortSignal {
      return this.L.abort.signal;
    }

    refresh(): void {
      this.run = s.repos.runs.get(this.run.id) ?? this.run;
      this.conv = s.repos.conversations.get(this.conv.id) ?? this.conv;
    }

    rows(): MessageRow[] {
      return s.repos.messages.load(this.conv.id, this.conv.epoch);
    }

    async go(): Promise<void> {
      if (this.run.phase === 'start') {
        const ok = await this.start();
        if (!ok) return;
      } else if (this.run.phase === 'finalize') {
        return this.recoverFinalize();
      }
      const rows = this.rows();
      const last = rows[rows.length - 1];
      if (last && last.role === 'assistant' && !last.hasClientToolUse && last.stopReason !== 'pause_turn' && last.stopReason !== 'compaction') {
        return this.recoverFinalize(); // crashed after the final assistant row was persisted
      }
      await this.ch.begin();
      if (this.run.phase === 'tools' || (last && last.role === 'assistant' && last.hasClientToolUse)) {
        const cont = await this.resumeInterruptedRound();
        if (!cont) return;
      }
      await this.loop();
    }

    // ── phase 'start'
    async start(): Promise<boolean> {
      // an epoch_rotate job rotating this conversation right now: wait for it, then read the new epoch (never rotate twice)
      const rotating = rotations.get(this.conv.id);
      if (rotating) {
        await rotating.catch(() => undefined);
        this.refresh();
      }
      const now = s.clock.now();
      let conv = this.conv;
      let epoch = s.repos.conversations.currentEpoch(conv.id);
      let rows = s.repos.messages.load(conv.id, epoch.epoch);
      let seed: { source: 'handoff' | 'deterministic'; body: string } | null = null;
      if (this.run.trigger !== 'wake') {
        // self-heal: an earlier run crashed mid-round and left an unanswered tool_use (no run is parked on it)
        const last = rows[rows.length - 1];
        const owner = last?.runId ? s.repos.runs.get(last.runId) : undefined;
        if (last && last.role === 'assistant' && last.hasClientToolUse && owner?.state !== 'parked') {
          if (closeOpenRound(conv, last.runId ?? this.run.id, t(this.run.userId, 'no_reply_temp_error'))) {
            log.warn({ conv: conv.id, runId: this.run.id }, 'closed a tool round left open by a crashed run');
            rows = s.repos.messages.load(conv.id, epoch.epoch);
          }
        }
      }
      const reason = this.run.trigger === 'wake' ? null : rotationReason(s, conv, epoch, rows, now);
      if (reason) {
        const rot = await rotate(d.epochs, conv, reason, { ...(d.excludeTexts.get(conv.id) ? { excludeTexts: d.excludeTexts.get(conv.id)! } : {}), priority: this.run.priority, signal: this.signal, runId: this.run.id });
        d.excludeTexts.delete(conv.id);
        conv = rot.conv;
        epoch = rot.epoch;
        rows = [];
        seed = rot.seed;
        // this run now belongs to the new epoch, so the old one can go; the seed waits on the new epoch in case this
        // run ends before writing its first row (quota template, a crash) — the next run start picks it up
        s.repos.runs.update(this.run.id, { epoch: conv.epoch });
        if (seed) s.repos.conversations.updateEpoch(conv.id, epoch.epoch, { handoffSummary: seed.body });
        for (const e of rot.shred) scheduleShred(s, conv.id, e, reason);
      } else if (rows.length === 0 && epoch.seedKind !== 'none' && epoch.handoffSummary) {
        // a rotation (the epoch_rotate job, or a run that ended before writing) left its seed on the new epoch
        seed = { source: epoch.seedKind === 'handoff' ? 'handoff' : 'deterministic', body: epoch.handoffSummary };
      }
      this.conv = conv;
      s.repos.runs.update(this.run.id, { epoch: conv.epoch });
      this.run = { ...this.run, epoch: conv.epoch };
      // quota (template reply, no LLM)
      const q = this.quotaBlock();
      if (q) {
        await this.finishWithTemplate(q);
        return false;
      }
      // inputs
      const isEventRun = this.run.trigger === 'event' || this.run.trigger === 'mission_start' || this.run.trigger === 'continue';
      let inputs: InputRow[] = [];
      let evBlocks: { blocks: BetaContentBlockParam[]; taint: TaintSource[] } | null = null;
      if (isEventRun) {
        const own = s.repos.inputs.consumedBy(this.run.id);
        const evIn = own.find((i) => i.kind === 'event');
        const ev = evIn ? decodeEventInput(evIn) : null;
        if (ev) evBlocks = await eventBlocks(s, this.run, ev);
        inputs = own;
      } else if (this.run.trigger !== 'wake') {
        inputs = s.repos.inputs.pending(conv.id);
      }
      const nonEvent = inputs.filter((i) => i.kind !== 'event');
      const ib = await inputBlocks(s, conv, this.run, isEventRun ? [] : nonEvent);
      const blocks: BetaContentBlockParam[] = [...(evBlocks?.blocks ?? []), ...ib.blocks];
      if (blocks.length === 0 && !seed) {
        // nothing to answer (inputs were taken by another run): end quietly
        s.repos.runs.update(this.run.id, { state: 'cancelled', stopCategory: 'no_input', leaseUntil: null });
        s.repos.conversations.casActiveRun(conv.id, this.run.id, null);
        return false;
      }
      const taint = [...new Set([...this.run.taint, ...(evBlocks?.taint ?? []), ...ib.taint])];
      this.startText = plainText(ib.blocks.length ? ib.blocks : blocks);
      const replyToCard = [...nonEvent].reverse().find((i) => i.replyToCardId)?.replyToCardId ?? null;
      const events = s.repos.inputs.takeEvents(conv.id, this.run.id);
      const prevStopped = this.previousStopped(rows);
      const runForCtx: RunRow = { ...this.run, taint };
      const ctxText = await buildContextText(s, conv, runForCtx, { events, replyToCard, previousStopped: prevStopped, query: this.startText });
      const userContent: BetaContentBlockParam[] = [...(seed ? [seedBlock(seed.source, seed.body)] : []), ...blocks];
      const inline = conv.contextMode === 'inline';
      if (inline) userContent.push(text(ctxText));
      const kind = seed ? 'seed' : isEventRun ? 'event' : 'user_input';
      const epochNo = conv.epoch;
      const ownerInput = nonEvent.some((i) => i.author === 'owner' && !i.untrusted);
      s.db.tx(() => {
        const add: Parameters<Services['repos']['messages']['append']>[2] = [{ role: 'user', kind, content: { role: 'user', content: userContent }, runId: this.run.id }];
        if (!inline) add.push({ role: 'system', kind: 'context', content: { role: 'system', content: [{ type: 'text', text: ctxText }] } as BetaMessageParam, runId: this.run.id });
        appendRows(conv.id, epochNo, add);
        const ids = inputs.map((i) => i.id);
        if (ids.length) s.repos.inputs.markConsumed(ids, this.run.id, epochNo);
        s.repos.runs.update(this.run.id, { phase: 'model', taint });
        if (taint.length) {
          const ep = s.repos.conversations.currentEpoch(conv.id);
          const et = [...new Set([...ep.taint, ...taint])];
          if (et.length !== ep.taint.length) s.repos.conversations.updateEpoch(conv.id, epochNo, { taint: et });
        }
        s.repos.conversations.update(conv.id, { lastActivityAt: s.clock.now() });
      });
      this.lastContextAt = s.clock.now();
      if (ownerInput && (this.run.trigger === 'user_input' || this.run.trigger === 'group')) d.toolkits.bumpTurn(conv.id);
      const blobIds = JSON.stringify(userContent).match(/@blob:(b_[A-Za-z0-9]+)/g)?.map((x) => x.slice(6)) ?? [];
      if (blobIds.length) s.repos.messages.refBlobs(conv.id, epochNo, [...new Set(blobIds)]);
      this.refresh();
      return true;
    }

    previousStopped(rows: readonly MessageRow[]): boolean {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r.role !== 'assistant') continue;
        return r.kind === 'synthetic' && JSON.stringify(r.content.content).includes(STOPPED_MARK);
      }
      return false;
    }

    quotaBlock(): { kind: 'turn' | 'cost_micros' | 'cooldown'; until?: number } | null {
      const uid = this.run.userId;
      if (!uid) return null;
      // F7: owner-requested event runs are metered too — the brief preview spends a turn like a message; an owner-tapped
      // Retry passes the cost / cooldown gate but spends no second turn (the failed run already did).
      let ownerEvent: 'brief' | 'retry' | null = null;
      if (this.run.trigger === 'event' && this.run.priority === 'interactive') {
        try {
          const evIn = s.repos.inputs.consumedBy(this.run.id).find((i) => i.kind === 'event');
          const ev = evIn ? decodeEventInput(evIn) : null;
          if (ev?.type === 'brief' || ev?.type === 'retry') ownerEvent = ev.type;
        } catch {
          ownerEvent = null;
        }
      }
      if (!(this.run.trigger === 'user_input' || this.run.trigger === 'continue' || ownerEvent)) return null;
      if (!(this.conv.kind === 'dm' || this.conv.kind === 'topic' || this.conv.kind === 'mission')) return null;
      try {
        const cd = s.quotas.cooldownUntil(uid);
        if (cd !== null && cd > s.clock.now()) return { kind: 'cooldown', until: cd };
        if (!s.quotas.check(uid, 'cost_micros').ok) return { kind: 'cost_micros' };
        if (ownerEvent === 'retry') return null;
        if (!s.quotas.check(uid, 'turn').ok) return { kind: 'turn' };
        s.quotas.consume(uid, 'turn');
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'quota check failed (allowing)');
      }
      return null;
    }

    async finishWithTemplate(q: { kind: 'turn' | 'cost_micros' | 'cooldown'; until?: number }): Promise<void> {
      const uid = this.run.userId!;
      // Only a user_input run owns the pending inputs; an event / continue run must not swallow a queued message.
      const pending = this.run.trigger === 'user_input' ? s.repos.inputs.pending(this.conv.id) : [];
      if (pending.length) s.repos.inputs.markConsumed(pending.map((i) => i.id), this.run.id, this.conv.epoch);
      const chat = { chatId: this.run.replyRef.chatId, ...(this.run.replyRef.threadId ? { threadId: this.run.replyRef.threadId } : {}) };
      try {
        if (q.kind === 'cooldown') {
          const u = s.repos.users.getById(uid);
          const hhmm = new Date(q.until ?? s.clock.now()).toISOString().slice(11, 16);
          await s.telegram.render.sendMarkdown(chat, t(uid, 'refusal_cooldown', { time: `${hhmm} UTC` }) + (u ? '' : ''));
        } else await s.notices.quotaExceeded(uid, q.kind, chat);
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'quota template failed');
      }
      s.repos.runs.update(this.run.id, { state: 'done', stopCategory: q.kind === 'cooldown' ? 'cooldown' : 'quota', leaseUntil: null });
      s.repos.conversations.casActiveRun(this.conv.id, this.run.id, null);
      if (this.run.trigger !== 'user_input') startNextSoon(this.conv.id); // a message queued behind the event run
    }

    // ── tools per request (03 R3), budgeted against the provider's hard ceiling (03 R2)
    requestFor(rows: readonly MessageRow[]): MainRequest {
      const reg = s.registry;
      const build = (tools: readonly BetaToolUnion[]) => buildRequest(d.build(), { conv: this.conv, run: this.run, rows, tools, modelCalls: this.modelCalls });
      if (s.config.profile.toolMode === 'static') return build(reg.toolset(this.conv.toolset).definitions);
      const names = new Set<string>();
      for (const r of rows) if (r.role === 'assistant') for (const b of blocksOfRow(r)) if (b['type'] === 'tool_use') names.add(String(b['name']));
      const runNames = new Set<string>();
      const start = runStartIndex(rows, this.run.id);
      const runLoaded: ToolkitId[] = []; // kits the model loaded with use_toolkit in this run are its working set too
      if (start >= 0) {
        for (const r of rows.slice(start)) {
          if (r.role !== 'assistant') continue;
          for (const b of blocksOfRow(r)) {
            if (b['type'] !== 'tool_use') continue;
            runNames.add(String(b['name']));
            const kit = (b['input'] as { name?: unknown } | undefined)?.name;
            if (b['name'] === 'use_toolkit' && typeof kit === 'string' && (TOOLKIT_IDS as readonly string[]).includes(kit)) runLoaded.push(kit as ToolkitId);
          }
        }
      }
      let hasPending = false;
      let connected = { gmail: false, gcal: false };
      const uid = this.conv.userId;
      const privateConv = this.conv.kind === 'dm' || this.conv.kind === 'topic' || this.conv.kind === 'mission';
      if (uid && privateConv) {
        try {
          hasPending = s.approvals.listPending(uid).length > 0;
        } catch {
          /* optional */
        }
        try {
          const st = s.integrations.status(uid) as Record<string, { connected: boolean }>;
          connected = { gmail: !!st['gmail']?.connected, gcal: !!st['gcal']?.connected };
        } catch {
          /* optional */
        }
      }
      const membership = reg.toolkits();
      const loaded = d.toolkits.active(this.conv.id);
      const preloads = preloadKits({ text: this.startText || this.runStartText(rows), route: this.conv.route, hasPendingApproval: hasPending, connected });
      const kits = selectActiveKits({ loaded, historyKits: kitsOfTools(membership, names), preloads });
      const p = s.config.profile;
      if (p.provider !== 'groq') return build(reg.subset(this.conv.toolset, kits).definitions);
      const droppable = droppableKits({ active: kits, loaded, preloads, runKits: [...kitsOfTools(membership, runNames), ...runLoaded], required: this.conv.route === 'mission' ? ['missions'] : [] });
      const { req, dropped } = fitKitsToBudget({ kits, droppable, build: (k) => build(reg.subset(this.conv.toolset, k).definitions), maxPromptTokens: p.maxPromptTokens, maxOutputTokens: p.maxOutputTokens });
      if (dropped.length) log.info({ runId: this.run.id, dropped }, 'toolkits dropped to fit the prompt budget');
      return req;
    }

    runStartText(rows: readonly MessageRow[]): string {
      const i = runStartIndex(rows, this.run.id);
      return i >= 0 ? plainText(blocksOfRow(rows[i]!) as unknown as BetaContentBlockParam[]) : '';
    }

    maxTurns(): number {
      const r = s.config.routes[this.conv.route].maxTurns;
      const p = s.config.profile;
      return p.provider === 'groq' ? Math.min(r, p.maxToolSteps + 1) : r;
    }

    // ── the model loop
    /**
     * Mission budget (01 F8, integration with WP6b): once `missions.chargeCost` flipped the mission to
     * 'budget_exhausted', no further model call is made. The run ends at the next model-call boundary (after the tool
     * round the paid call asked for, so the transcript stays well-formed); ➕ Budget then continues the mission with an
     * event run (missions.wakeOrContinue), or wakes a run parked on `budget:<missionId>` by task_wait.
     */
    missionBudgetExhausted(): boolean {
      return this.missionStop() !== null;
    }

    /**
     * F1: a mission run makes no model call once its mission is anything but 'active' / 'parked': 'budget' for
     * budget_exhausted (resumable by ➕ Budget), 'ended' for done / failed / cancelled (a run that outlived Stop or
     * mission_finish).
     */
    missionStop(): 'budget' | 'ended' | null {
      const id = this.run.replyRef.missionId;
      if (this.conv.route !== 'mission' || !id) return null;
      try {
        const st = s.missions.get(id)?.status;
        if (st === undefined || st === 'active' || st === 'parked') return null;
        return st === 'budget_exhausted' ? 'budget' : 'ended';
      } catch {
        return null;
      }
    }

    async loop(): Promise<void> {
      for (let turn = this.run.turns; turn < this.maxTurns(); ) {
        const ms = this.missionStop();
        if (ms === 'budget') {
          this.appendSynthetic(MISSION_BUDGET_MARK);
          return this.finalize({ continueButton: false, stopCategory: 'budget' });
        }
        if (ms === 'ended') {
          this.appendSynthetic(MISSION_ENDED_MARK);
          return this.finalize({ continueButton: false, stopCategory: 'system_stop' });
        }
        const rows = this.rows();
        const req = this.requestFor(rows);
        let r: StreamResult;
        try {
          this.pending = '';
          r = await s.transport.stream(
            req,
            {
              onText: (x) => {
                this.pending += x;
                this.ch.text(x);
              },
              onBlockStart: (b) => {
                if (b.index === -1 && b.type === 'retry') this.pending = '';
                this.ch.blockStart(b);
              },
            },
            this.signal,
            { priority: this.run.priority, dek: `e:${this.conv.id}:${this.conv.epoch}` }, // derived media text is sealed under the epoch DEK
          );
        } catch (e) {
          const next = await this.handleError(e, req);
          if (next === 'retry') continue;
          return;
        }
        this.modelCalls += 1;
        recordMainCall(s, { run: this.run, conv: this.conv, epoch: this.conv.epoch, req, r, purpose: 'main' });
        const msg = fallbackEcho(r.message);
        if (msg.stop_reason === 'refusal') return this.refused(msg);
        if (msg.stop_reason === 'max_tokens' && hasClientToolUse(msg.content)) {
          this.ch.resetIteration();
          const p = s.config.profile;
          const cap = p.provider === 'groq' ? p.maxOutputTokens : MAX_TOKENS_CAP;
          const eff = Math.min(this.run.maxTokens, cap);
          if (eff * 2 > cap) return this.failed('too_long', t(this.run.userId, 'too_long'));
          s.repos.runs.update(this.run.id, { maxTokens: this.run.maxTokens * 2 });
          this.refresh();
          continue; // nothing persisted
        }
        if (msg.stop_reason === 'model_context_window_exceeded') {
          const again = await this.contextExceeded();
          if (again) continue;
          return;
        }
        const seq = this.appendAssistant(msg);
        this.ch.commitIteration();
        if (msg.stop_reason === 'pause_turn' || msg.stop_reason === 'compaction') {
          const c = this.run.continuations + 1;
          s.repos.runs.update(this.run.id, { continuations: c });
          this.refresh();
          if (c > MAX_CONTINUATIONS) return this.finalize({ continueButton: true });
          turn += 1;
          continue;
        }
        const uses = clientToolUses(msg.content);
        if (uses.length === 0) return this.finalize({ continueButton: msg.stop_reason === 'max_tokens' });
        const cont = await this.toolRound(seq, uses, msg, turn);
        if (!cont) return;
        turn += 1;
      }
      this.appendSynthetic(t(this.run.userId, 'step_cap'));
      return this.finalize({ continueButton: true });
    }

    appendAssistant(msg: BetaMessage): number {
      const [seq] = appendRows(this.conv.id, this.conv.epoch, [
        { role: 'assistant', kind: 'assistant', content: { role: 'assistant', content: msg.content as unknown as BetaContentBlockParam[] }, runId: this.run.id, ...(msg.stop_reason ? { stopReason: msg.stop_reason } : {}), hasClientToolUse: hasClientToolUse(msg.content) },
      ]);
      return seq!;
    }

    appendSynthetic(note: string): void {
      appendRows(this.conv.id, this.conv.epoch, [{ role: 'assistant', kind: 'synthetic', content: synthetic(note), runId: this.run.id }]);
    }

    /** Server-tool results in the assistant message taint the run ('web', 01 §11.2). */
    serverTaint(msg: BetaMessage | null): TaintSource[] {
      if (!msg) return [];
      return (msg.content as unknown as Block[]).some((b) => b['type'] === 'web_search_tool_result' || b['type'] === 'web_fetch_tool_result') ? ['web'] : [];
    }

    addTaint(add: readonly TaintSource[]): void {
      if (!add.length) return;
      const run = s.repos.runs.get(this.run.id) ?? this.run;
      const rt = [...new Set([...run.taint, ...add])];
      if (rt.length !== run.taint.length) s.repos.runs.update(this.run.id, { taint: rt });
      const ep = s.repos.conversations.currentEpoch(this.conv.id);
      const et = [...new Set([...ep.taint, ...add])];
      if (et.length !== ep.taint.length) s.repos.conversations.updateEpoch(this.conv.id, this.conv.epoch, { taint: et });
      this.refresh();
    }

    capResults(results: BetaToolResultBlockParam[]): BetaToolResultBlockParam[] {
      const p = s.config.profile;
      if (p.provider !== 'groq') return results;
      const max = Math.floor(s.config.limits.groqToolResultMaxTokens * CHARS_PER_TOKEN);
      return results.map((r) => {
        if (typeof r.content === 'string') return r.content.length > max ? { ...r, content: r.content.slice(0, max) + ' […truncated]' } : r;
        if (Array.isArray(r.content)) {
          const content = r.content.map((b) => {
            const x = b as unknown as Block;
            return x['type'] === 'text' && typeof x['text'] === 'string' && (x['text'] as string).length > max ? { ...(b as object), text: (x['text'] as string).slice(0, max) + ' […truncated]' } : b;
          });
          return { ...r, content } as BetaToolResultBlockParam;
        }
        return r;
      });
    }

    async toolRound(seq: number, uses: BetaToolUseBlock[], msg: BetaMessage | null, turn: number): Promise<boolean> {
      s.repos.runs.update(this.run.id, { phase: 'tools' });
      this.refresh();
      // Server-tool results (web_search/web_fetch) in this very assistant message taint the run BEFORE its client tools
      // are classified, so the executor's Sentinel sees run.taint ⊇ 'web' (TRUST-01; the executor also derives it).
      this.addTaint(this.serverTaint(msg));
      let out: RoundOutcome | null = null;
      let err: unknown = null;
      try {
        out = await s.executor.processRound(this.run, this.conv, seq, uses, this.ch, this.signal);
      } catch (e) {
        err = e;
      }
      if (this.signal.aborted) return this.stopDuringTools(seq, uses, out);
      if (!out) throw err ?? new Error('processRound returned nothing');
      return this.afterRound(seq, uses, out, msg, turn);
    }

    async afterRound(seq: number, uses: BetaToolUseBlock[], out: RoundOutcome, msg: BetaMessage | null, turn: number): Promise<boolean> {
      this.addTaint([...out.taintAdded, ...this.serverTaint(msg)]);
      this.effects.push(...out.effects);
      if (out.park) {
        await this.ch.checkpoint();
        s.repos.runs.update(this.run.id, { visibleText: this.ch.visibleText || null });
        s.repos.runs.park(this.run.id, out.park.wakeOn, out.park.wakeAt);
        if (out.park.wakeAt !== null) s.scheduler.schedule({ kind: 'run_wake', runAt: out.park.wakeAt, ...(this.run.userId ? { userId: this.run.userId } : {}), refId: this.run.id, payload: { runId: this.run.id, reason: 'timeout' }, dedupeKey: `wake:${this.run.id}` });
        log.info({ runId: this.run.id, wakeOn: out.park.wakeOn.length }, 'run parked');
        return false;
      }
      const results = this.capResults(orderResults(uses, out.results));
      const steeringInputs = s.repos.inputs.pending(this.conv.id);
      const tz = this.tz();
      const steer = steeringInputs.length ? await steeringBlocks(s, this.conv, this.run, steeringInputs, tz) : { blocks: [], taint: [] as TaintSource[] };
      const approvalsOrEvents = out.results.some((r) => JSON.stringify(r.content ?? '').includes('pending_approval'));
      const needCtx = this.needsContextAfterTools(approvalsOrEvents);
      let ctxText: string | null = null;
      if (needCtx) {
        const events = s.repos.inputs.takeEvents(this.conv.id, this.run.id);
        ctxText = await buildContextText(s, this.conv, this.run, { events, replyToCard: null, previousStopped: false, query: this.startText });
      }
      const inline = this.conv.contextMode === 'inline';
      const content: BetaContentBlockParam[] = [...(results as unknown as BetaContentBlockParam[]), ...steer.blocks, ...(ctxText && inline ? [text(ctxText)] : [])];
      const epochNo = this.conv.epoch;
      const clearAt = this.conv.betas.includes(s.config.betas.clearAt);
      s.db.tx(() => {
        const add: Parameters<Services['repos']['messages']['append']>[2] = [{ role: 'user', kind: 'tool_results', content: { role: 'user', content }, runId: this.run.id }];
        if (ctxText && !inline) add.push({ role: 'system', kind: 'context', content: { role: 'system', content: [{ type: 'text', text: ctxText }], ...(clearAt ? { clear_at: 'next_user_message' } : {}) } as BetaMessageParam, runId: this.run.id });
        appendRows(this.conv.id, epochNo, add);
        if (steeringInputs.length) s.repos.inputs.markConsumed(steeringInputs.map((i) => i.id), this.run.id, epochNo);
        s.repos.runs.update(this.run.id, { phase: 'model', turns: turn + 1 });
      });
      if (ctxText) this.lastContextAt = s.clock.now();
      this.addTaint(steer.taint);
      this.refresh();
      return true;
    }

    needsContextAfterTools(approvalsOrEvents: boolean): boolean {
      if (this.conv.betas.includes(s.config.betas.clearAt)) return true;
      if (approvalsOrEvents) return true;
      return s.clock.now() - this.lastContextAt > CONTEXT_REFRESH_MS;
    }

    tz(): string {
      const uid = this.run.userId ?? this.conv.userId;
      return (uid ? s.repos.users.getById(uid)?.tz : undefined) ?? 'UTC';
    }

    /** Crash recovery of phase 'tools' (01 §5.11). */
    async resumeInterruptedRound(): Promise<boolean> {
      const rows = this.rows();
      const last = rows[rows.length - 1];
      if (!last || last.role !== 'assistant' || !last.hasClientToolUse) {
        s.repos.runs.update(this.run.id, { phase: 'model' });
        this.refresh();
        return true;
      }
      const uses = clientToolUses(blocksOfRow(last));
      const out = await s.executor.finishInterruptedRound(this.run, this.conv, last.seq);
      if (this.signal.aborted) return this.stopDuringTools(last.seq, uses, out);
      return this.afterRound(last.seq, uses, out, null, this.run.turns);
    }

    // ── terminal paths
    async stopDuringTools(seq: number, uses: BetaToolUseBlock[], out: RoundOutcome | null): Promise<false> {
      const reason = String(this.signal.reason ?? '');
      if (reason === 'shutdown') return false; // recovery finishes the round after the restart
      const cancelled = s.executor.cancelUnstarted(this.run.id, seq);
      const stored = s.repos.runs.toolCallsFor(this.run.id, seq);
      const results: BetaToolResultBlockParam[] = uses.map((u) => {
        const a = out?.results.find((r) => r.tool_use_id === u.id) ?? cancelled.find((r) => r.tool_use_id === u.id);
        if (a) return a;
        const tc = stored.find((x) => x.toolUseId === u.id);
        if (tc && tc.result !== null && tc.result !== undefined) return { type: 'tool_result', tool_use_id: u.id, content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result), ...(tc.isError ? { is_error: true } : {}) };
        return { type: 'tool_result', tool_use_id: u.id, content: 'Cancelled by user before execution', is_error: true };
      });
      this.addTaint(out?.taintAdded ?? []); // mirrors afterRound (TRUST-02; the executor persists it too)
      s.db.tx(() => {
        appendRows(this.conv.id, this.conv.epoch, [
          { role: 'user', kind: 'tool_results', content: { role: 'user', content: this.capResults(results) as unknown as BetaContentBlockParam[] }, runId: this.run.id },
          { role: 'assistant', kind: 'synthetic', content: synthetic(STOPPED_MARK), runId: this.run.id },
        ]);
      });
      await this.endStopped();
      return false;
    }

    async endStopped(): Promise<void> {
      s.repos.runs.update(this.run.id, { state: 'cancelled', stopCategory: 'user_stop', visibleText: this.ch.visibleText || null, leaseUntil: null });
      await this.ch.stopped().catch((e) => log.warn({ err: errorMessage(e) }, 'ch.stopped failed'));
      s.repos.conversations.casActiveRun(this.conv.id, this.run.id, null);
      startNextSoon(this.conv.id);
    }

    async handleError(e: unknown, req: MainRequest): Promise<'retry' | 'end'> {
      const cls = e instanceof Error ? e.name : 'Error';
      if (e instanceof AbortedError || this.signal.aborted) {
        const reason = String(this.signal.reason ?? (e instanceof AbortedError ? e.reason : ''));
        if (reason === 'shutdown') return 'end'; // lease expires; recovery re-issues the call
        const partial = this.pending.trim();
        const last = s.repos.messages.last(this.conv.id, this.conv.epoch);
        if (last && last.role !== 'assistant') this.appendSynthetic(`${partial ? `${partial}\n\n` : ''}${STOPPED_MARK}`);
        await this.endStopped();
        return 'end';
      }
      recordFailedCall(s, { run: this.run, conv: this.conv, epoch: this.conv.epoch, req, purpose: 'main', errorClass: e instanceof TransientLlmError ? `transient:${e.kind}` : e instanceof BadRequestLlmError ? `bad_request:${e.code ?? ''}` : cls, requestId: (e as { requestId?: string | null }).requestId ?? null });
      if (e instanceof TransientLlmError) {
        this.ch.resetIteration();
        const retries = this.run.retries + 1;
        if (retries > RETRY_DELAYS_MS.length) {
          this.appendSynthetic(t(this.run.userId, 'no_reply_temp_error'));
          await this.terminal('failed', 'temp_error', () => this.ch.fail(t(this.run.userId, 'temp_error'), true));
          return 'end';
        }
        this.ch.status(t(this.run.userId, 'llm_busy'));
        const delay = Math.max(RETRY_DELAYS_MS[retries - 1]!, e.retryAfterMs ?? 0);
        const notBefore = s.clock.now() + delay;
        s.repos.runs.update(this.run.id, { state: 'retry_wait', retries, notBefore, leaseUntil: null, visibleText: this.ch.visibleText || null });
        s.scheduler.schedule({ kind: 'resume_run', runAt: notBefore, ...(this.run.userId ? { userId: this.run.userId } : {}), refId: this.run.id, payload: { runId: this.run.id }, dedupeKey: `resume:${this.run.id}` });
        log.info({ runId: this.run.id, kind: e.kind, retries, delay }, 'run retry_wait');
        return 'end';
      }
      // tool_use_failed is NOT retried here: the transport already made the one retry 03 R1 allows (with the tool-name
      // note); re-issuing the whole stream would multiply full-prompt calls against the TPM bucket.
      if (e instanceof JsonInputError) {
        this.ch.resetIteration();
        if (this.jsonRetries < 2) {
          this.jsonRetries += 1;
          return 'retry';
        }
      }
      if (e instanceof BadRequestLlmError) {
        log.error({ runId: this.run.id, requestId: e.requestId, code: e.code, requestHmac: '(recorded)' }, 'LLM bad request');
        if (e.code === 'prompt_budget' || e.code === 'too_large') {
          this.ch.resetIteration();
          const msg = t(this.run.userId, 'prompt_budget');
          this.ch.text(msg);
          this.appendSynthetic(msg);
          this.ch.commitIteration();
          await this.finalize({ continueButton: false, state: 'done', stopCategory: 'prompt_budget' });
          return 'end';
        }
        if (e.code === 'system_role_unsupported' && this.conv.contextMode !== 'inline' && !this.rotatedInRun) {
          this.ch.resetIteration();
          await this.rerunInNewEpoch('system_role_unsupported');
          return 'retry';
        }
        this.ch.resetIteration();
        const ref = e.requestId ?? this.run.id.slice(-8);
        this.appendSynthetic(`[no reply: error ref ${ref}]`);
        await this.terminal('failed', 'bad_request', () => this.ch.fail(t(this.run.userId, 'failed_ref', { ref }), false));
        return 'end';
      }
      log.error({ runId: this.run.id, err: errorMessage(e), name: cls }, 'unexpected error in model call');
      this.ch.resetIteration();
      this.appendSynthetic(t(this.run.userId, 'no_reply_temp_error'));
      await this.terminal('failed', 'unexpected', () => this.ch.fail(t(this.run.userId, 'failed_ref', { ref: this.run.id.slice(-8) }), true));
      return 'end';
    }

    /** Rotates mid-run (before any tool round) and re-writes this run's inputs as the new epoch's first row. */
    async rerunInNewEpoch(reason: EpochReason): Promise<void> {
      this.rotatedInRun = true;
      const inputs = s.repos.inputs.consumedBy(this.run.id);
      const rot = await rotate(d.epochs, this.conv, reason, { priority: this.run.priority, signal: this.signal, runId: this.run.id });
      this.conv = rot.conv;
      const evIn = inputs.find((i) => i.kind === 'event');
      const ev = evIn ? decodeEventInput(evIn) : null;
      const evB = ev ? await eventBlocks(s, this.run, ev) : null;
      const ib = await inputBlocks(s, this.conv, this.run, inputs.filter((i) => i.kind !== 'event'));
      const seed = rot.seed ?? { source: 'deterministic' as const, body: deterministicSeed(s, this.conv, s.repos.conversations.getEpoch(this.conv.id, rot.oldEpoch) ?? rot.epoch, { tainted: false }) };
      const ctxText = await buildContextText(s, this.conv, this.run, { events: [], replyToCard: null, previousStopped: false, query: this.startText });
      const inline = this.conv.contextMode === 'inline';
      const content: BetaContentBlockParam[] = [seedBlock(seed.source, seed.body), ...(evB?.blocks ?? []), ...ib.blocks, ...(inline ? [text(ctxText)] : [])];
      const epochNo = this.conv.epoch;
      s.db.tx(() => {
        const add: Parameters<Services['repos']['messages']['append']>[2] = [{ role: 'user', kind: 'seed', content: { role: 'user', content }, runId: this.run.id }];
        if (!inline) add.push({ role: 'system', kind: 'context', content: { role: 'system', content: [{ type: 'text', text: ctxText }] } as BetaMessageParam, runId: this.run.id });
        appendRows(this.conv.id, epochNo, add);
        if (inputs.length) s.repos.inputs.markConsumed(inputs.map((i) => i.id), this.run.id, epochNo);
        s.repos.runs.update(this.run.id, { epoch: epochNo, phase: 'model', turns: 0 });
      });
      for (const e of rot.shred) scheduleShred(s, this.conv.id, e, reason);
      this.modelCalls = 0;
      this.refresh();
    }

    async contextExceeded(): Promise<boolean> {
      this.ch.resetIteration();
      const last = s.repos.messages.last(this.conv.id, this.conv.epoch);
      if (last && last.role !== 'assistant' && last.kind !== 'tool_results' && !this.rotatedInRun) {
        await this.rerunInNewEpoch('context_exceeded');
        return true;
      }
      // mid-round: the tool_results row is already appended
      this.appendSynthetic(t(this.run.userId, 'context_full'));
      s.repos.conversations.update(this.conv.id, { rotatePending: 'context_exceeded' });
      await this.finalize({ continueButton: false });
      try {
        startEventRun(this.conv.id, { type: 'context_rotated', body: 'The earlier thread was full; continue the owner\'s last request in this fresh thread.' }, { channel: this.run.channel, replyRef: this.run.replyRef, priority: this.run.priority });
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'context_rotated event run failed');
      }
      return false;
    }

    async refused(msg: BetaMessage): Promise<void> {
      const category = ((msg.stop_details ?? null) as { category?: string | null } | null)?.category ?? null;
      log.info({ runId: this.run.id, category }, 'refusal');
      this.ch.resetIteration();
      this.appendSynthetic(t(this.run.userId, 'declined'));
      const uid = this.run.userId;
      let cooldown: number | null = null;
      if (uid) {
        try {
          s.ledger.append({ userId: uid, actor: 'agent', kind: 'refusal', summary: 'The model declined a request', detail: { category }, runId: this.run.id });
        } catch (e) {
          log.warn({ err: errorMessage(e) }, 'ledger refusal failed');
        }
        try {
          cooldown = s.quotas.recordRefusal(uid).cooldownUntil;
        } catch {
          /* optional */
        }
      }
      const friendly = t(uid, 'refusal');
      this.ch.text(friendly);
      if (cooldown) this.ch.text(`\n\n${t(uid, 'refusal_cooldown', { time: `${new Date(cooldown).toISOString().slice(11, 16)} UTC` })}`);
      this.ch.commitIteration();
      await this.finalize({ continueButton: false, state: 'refused', stopCategory: category ?? 'refusal' });
    }

    async failed(category: string, message: string): Promise<void> {
      this.appendSynthetic(`[no reply: ${category}]`);
      await this.terminal('failed', category, () => this.ch.fail(message, false));
    }

    async terminal(state: 'failed', category: string, send: () => Promise<void>): Promise<void> {
      s.repos.runs.update(this.run.id, { state, stopCategory: category, visibleText: this.ch.visibleText || null, leaseUntil: null });
      await send().catch((e) => log.warn({ err: errorMessage(e) }, 'channel fail() failed'));
      s.repos.conversations.casActiveRun(this.conv.id, this.run.id, null);
      await this.runHooks([]);
      startNextSoon(this.conv.id);
    }

    footerLines(): string[] {
      // spec 05 A5 minimal UI: footers only for pending approvals (Undo lines come from effects). No 🕶 incognito mark
      // and no "free messages left" line; the quota template still appears when a quota is actually hit.
      const lines: string[] = [];
      const uid = this.run.userId;
      if (!uid || !(this.conv.kind === 'dm' || this.conv.kind === 'topic' || this.conv.kind === 'mission')) return lines;
      try {
        for (const a of s.approvals.listPending(uid).filter((x) => x.runId === this.run.id)) lines.push(`⏳ ${a.summary} (${a.id})`);
      } catch {
        /* optional */
      }
      return lines;
    }

    async finalize(o: { continueButton: boolean; state?: 'done' | 'refused'; stopCategory?: string }): Promise<void> {
      s.repos.runs.update(this.run.id, { phase: 'finalize' });
      const effects = [...this.effects];
      if (o.continueButton && this.run.userId) {
        const u = s.repos.users.getById(this.run.userId);
        if (u) {
          try {
            effects.push({ kind: 'buttons', rows: [[{ text: t(u.id, 'continue_button'), callback_data: s.telegram.codec.encode('ct', [this.conv.id, 'c'], u.tgUserId) }]] });
          } catch (e) {
            log.warn({ err: errorMessage(e) }, 'continue button failed');
          }
        }
      }
      const rows = this.rows();
      const allowed = allowedFromRows(rows);
      let sent: SentRef[] = [];
      try {
        sent = await this.ch.finalize({ footerLines: this.footerLines(), effects, allowedLinkHosts: allowed.hosts, allowedEmails: allowed.emails });
      } catch (e) {
        log.error({ runId: this.run.id, err: errorMessage(e) }, 'channel finalize failed');
      }
      const lastAssistant = [...rows].reverse().find((r) => r.role === 'assistant');
      sent.forEach((m, part) => {
        try {
          s.telegram.links.record({ chatId: m.chatId, messageId: m.messageId, kind: 'answer', userId: this.run.userId, conversationId: this.conv.id, epoch: this.conv.epoch, seq: lastAssistant?.seq ?? null, runId: this.run.id, part, ...(this.run.replyRef.businessConnectionId && this.conv.kind === 'biz_draft' ? {} : {}) });
        } catch {
          /* the channel may have recorded it already */
        }
      });
      s.repos.runs.update(this.run.id, { state: o.state ?? 'done', leaseUntil: null, ...(o.stopCategory ? { stopCategory: o.stopCategory } : {}) });
      s.repos.conversations.casActiveRun(this.conv.id, this.run.id, null);
      this.scheduleAfterRun();
      await this.runHooks(sent);
      startNextSoon(this.conv.id);
    }

    scheduleAfterRun(): void {
      const c = this.conv;
      try {
        const incognito = (() => {
          const until = c.userId ? s.repos.users.getById(c.userId)?.incognitoUntil : null;
          return until != null && until > s.clock.now();
        })();
        // Incognito (X4): no extraction job — the watermark is sealed past this run anyway (memory run hook).
        if ((c.kind === 'dm' || c.kind === 'topic' || c.kind === 'mission') && c.userId && !incognito) {
          s.scheduler.schedule({ kind: 'memory_extract', runAt: s.clock.now() + 2 * 60_000, userId: c.userId, refId: c.id, payload: { conversationId: c.id, runId: this.run.id }, dedupeKey: `mx:${c.id}` });
        }
        scheduleHandoffFork(s, c, s.repos.conversations.currentEpoch(c.id));
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'post-run scheduling failed');
      }
    }

    async runHooks(sent: SentRef[]): Promise<void> {
      const run = s.repos.runs.get(this.run.id) ?? this.run;
      for (const h of s.runHooks) {
        try {
          await h.onRunFinished(run, this.conv, sent);
        } catch (e) {
          log.warn({ hook: h.name, err: errorMessage(e) }, 'run hook failed');
        }
      }
    }

    /** phase 'finalize' after a crash: mark done; re-send the final text if no final message was recorded (01 §5.11). */
    async recoverFinalize(): Promise<void> {
      const rows = this.rows();
      const last = [...rows].reverse().find((r) => r.role === 'assistant');
      const links = s.telegram.links.byRun(this.run.id).filter((l) => l.kind === 'answer');
      if (!links.length && last && this.run.channel !== 'biz_owner') {
        const raw = plainText(blocksOfRow(last) as unknown as BetaContentBlockParam[]).trim();
        const allowed = allowedFromRows(rows);
        const txt = raw ? s.telegram.render.sanitize(raw, { allowedLinkHosts: allowed.hosts, allowedEmails: allowed.emails }) : '';
        if (txt) {
          const parts = s.telegram.render.split(txt);
          parts.forEach((md, part) => {
            s.telegram.outbox.enqueue({
              idempotencyKey: `run:${this.run.id}:final:${part}`, ...(this.run.userId ? { userId: this.run.userId } : {}), chatId: this.run.replyRef.chatId,
              ...(this.run.replyRef.threadId ? { threadId: this.run.replyRef.threadId } : {}), method: 'sendRichMessage', payload: {}, markdown: md, refKind: 'run_final', refId: this.run.id,
            });
          });
        }
      }
      s.repos.runs.update(this.run.id, { state: 'done', leaseUntil: null });
      s.repos.conversations.casActiveRun(this.conv.id, this.run.id, null);
      await this.runHooks([]);
      startNextSoon(this.conv.id);
    }
  }

  // ───────────────────────── wake (01 §5.6)

  async function wake(token: string, p: WakePayload): Promise<number> {
    const runs = s.repos.runs.byWaitToken(token).filter((r) => r.state === 'parked');
    let n = 0;
    for (const r of runs) if (await wakeRun(r, p)) n += 1;
    return n;
  }

  function taskWaitResult(p: WakePayload, waitedMin: number): Record<string, unknown> {
    switch (p.reason) {
      case 'approval':
        return { woke_because: 'approval', approval: { id: p.approvalId, decision: p.decision, executed: p.executed, ...(p.summary ? { summary: p.summary } : {}) }, waited_minutes: waitedMin };
      case 'watcher':
        return { woke_because: 'watcher', watcher: { id: p.watcherId, summary: p.summary }, waited_minutes: waitedMin };
      case 'budget':
        return { woke_because: 'budget', spent_usd: p.spentUsd, budget_usd: p.budgetUsd, waited_minutes: waitedMin };
      default:
        return { woke_because: p.reason, waited_minutes: waitedMin };
    }
  }

  async function wakeRun(run: RunRow, p: WakePayload): Promise<boolean> {
    const conv = s.repos.conversations.get(run.conversationId);
    if (!conv || run.state !== 'parked') return false;
    const rows = s.repos.messages.load(conv.id, conv.epoch);
    const last = rows[rows.length - 1];
    if (!last || last.role !== 'assistant' || !last.hasClientToolUse) {
      s.repos.runs.clearWaits(run.id);
      s.repos.runs.update(run.id, { state: 'failed', error: 'parked without a pending round' });
      s.repos.conversations.casActiveRun(conv.id, run.id, null);
      return false;
    }
    const uses = clientToolUses(blocksOfRow(last));
    const calls = s.repos.runs.toolCallsFor(run.id, last.seq);
    const waited = Math.max(0, Math.round((s.clock.now() - last.createdAt) / 60_000));
    const results: BetaToolResultBlockParam[] = uses.map((u) => {
      const tc = calls.find((c) => c.toolUseId === u.id);
      if (tc && (tc.status === 'waiting' || u.name === 'task_wait')) {
        const res = taskWaitResult(p, waited);
        try {
          s.repos.runs.updateToolCall(u.id, { status: 'done', result: res, isError: false });
        } catch {
          /* best effort */
        }
        return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(res) };
      }
      if (tc && tc.result !== null && tc.result !== undefined) return { type: 'tool_result', tool_use_id: u.id, content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result), ...(tc.isError ? { is_error: true } : {}) };
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ error: 'OUTCOME_UNKNOWN', note: 'No stored result for this call; do not assume it ran.' }), is_error: true };
    });
    const cancelled = p.reason === 'cancelled';
    const steeringInputs = p.reason === 'user_input' ? s.repos.inputs.pending(conv.id) : [];
    const user = run.userId ? s.repos.users.getById(run.userId) : undefined;
    const steer = steeringInputs.length ? await steeringBlocks(s, conv, run, steeringInputs, user?.tz ?? 'UTC') : { blocks: [], taint: [] as TaintSource[] };
    const events = cancelled ? [] : s.repos.inputs.takeEvents(conv.id, run.id);
    const ctxText = cancelled ? null : await buildContextText(s, conv, run, { events, replyToCard: null, previousStopped: false, query: '' });
    const inline = conv.contextMode === 'inline';
    const content: BetaContentBlockParam[] = [...(results as unknown as BetaContentBlockParam[]), ...steer.blocks, ...(ctxText && inline ? [text(ctxText)] : [])];
    const epochNo = conv.epoch;
    s.db.tx(() => {
      const add: Parameters<Services['repos']['messages']['append']>[2] = [{ role: 'user', kind: 'tool_results', content: { role: 'user', content }, runId: run.id }];
      if (cancelled) add.push({ role: 'assistant', kind: 'synthetic', content: synthetic(conv.route === 'mission' ? CANCELLED_MISSION_MARK : STOPPED_MARK), runId: run.id });
      else if (ctxText && !inline) add.push({ role: 'system', kind: 'context', content: { role: 'system', content: [{ type: 'text', text: ctxText }] } as BetaMessageParam, runId: run.id });
      appendRows(conv.id, epochNo, add);
      if (steeringInputs.length) s.repos.inputs.markConsumed(steeringInputs.map((i) => i.id), run.id, epochNo);
      s.repos.runs.clearWaits(run.id);
      if (cancelled) s.repos.runs.update(run.id, { state: 'cancelled', stopCategory: 'user_stop', wakeOn: [], wakeAt: null });
      else s.repos.runs.update(run.id, { state: 'queued', phase: 'model', wakeOn: [], wakeAt: null, turns: run.turns + 1 });
    });
    try {
      s.scheduler.cancel(`wake:${run.id}`);
    } catch {
      /* the timer job may not exist */
    }
    if (steer.taint.length) {
      const rt = [...new Set([...run.taint, ...steer.taint])];
      s.repos.runs.update(run.id, { taint: rt });
    }
    if (cancelled) {
      s.repos.conversations.casActiveRun(conv.id, run.id, null);
      startNextSoon(conv.id);
      return true;
    }
    launch(run.id);
    return true;
  }

  // ───────────────────────── stop (01 §5.7)

  async function stopByDraft(chatId: number, threadId: number, draftId: number): Promise<boolean> {
    for (const l of live.values()) {
      if (l.draft && l.draft.chatId === chatId && l.draft.threadId === threadId && l.draft.draftId === draftId) return stopRun(l.runId, 'user');
    }
    // not live: a run waiting to retry (retry_wait) or queued still shows its draft with Stop → match runs.draft_id
    const waiting = s.repos.runs.byDraft(chatId, threadId, draftId)[0];
    return waiting ? stopRun(waiting.id, 'user') : false;
  }

  async function stopRun(runId: string, by: 'user' | 'system'): Promise<boolean> {
    const l = live.get(runId);
    if (l) {
      l.abort.abort(by === 'user' ? 'user_stop' : 'system_stop');
      return true;
    }
    const run = s.repos.runs.get(runId);
    if (!run) return false;
    if (run.state === 'parked') return wakeRun(run, { reason: 'cancelled' });
    if (run.state === 'queued' || run.state === 'retry_wait') {
      const conv = s.repos.conversations.get(run.conversationId);
      if (conv) {
        const last = s.repos.messages.last(conv.id, conv.epoch);
        if (last && last.role !== 'assistant' && last.runId === run.id) appendRows(conv.id, conv.epoch, [{ role: 'assistant', kind: 'synthetic', content: synthetic(STOPPED_MARK), runId: run.id }]);
        s.repos.runs.update(run.id, { state: 'cancelled', stopCategory: by === 'user' ? 'user_stop' : 'system_stop', leaseUntil: null });
        s.repos.conversations.casActiveRun(conv.id, run.id, null);
        try {
          s.scheduler.cancel(`resume:${run.id}`);
        } catch {
          /* none */
        }
      }
      return true;
    }
    return false;
  }

  // ───────────────────────── recovery (01 §5.11)

  async function recover(): Promise<void> {
    const now = s.clock.now();
    // at boot no process holds any lease (single process): every 'running' run is an orphan, whatever its lease says
    const runs = s.repos.runs.recoverable(now + LEASE_MS + 1);
    for (const r of runs) {
      try {
        if (r.state === 'retry_wait' && (r.notBefore ?? 0) > now) continue;
        const conv = s.repos.conversations.get(r.conversationId);
        if (!conv) continue;
        if (conv.activeRunId && conv.activeRunId !== r.id) {
          const other = s.repos.runs.get(conv.activeRunId);
          if (other && (other.state === 'running' || other.state === 'parked' || other.state === 'retry_wait')) continue; // queued behind it
          s.repos.conversations.casActiveRun(conv.id, conv.activeRunId, null);
        }
        if (!conv.activeRunId || conv.activeRunId !== r.id) {
          if (!s.repos.conversations.casActiveRun(conv.id, null, r.id)) continue;
        }
        if (r.state === 'running') s.repos.runs.update(r.id, { state: 'queued', leaseUntil: null });
        log.info({ runId: r.id, phase: r.phase, state: r.state }, 'recovering run');
        launch(r.id);
      } catch (e) {
        log.error({ runId: r.id, err: errorMessage(e) }, 'recovery failed for run');
      }
    }
  }

  async function idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      // flush coalescing timers (tests and shutdown drain)
      for (const c of [...kicks.keys()]) fireKick(c);
      if (inflight.size === 0) {
        await Promise.resolve();
        if (inflight.size === 0 && kicks.size === 0) return;
      }
      await Promise.allSettled([...inflight]);
    }
  }

  async function shutdown(timeoutMs: number): Promise<void> {
    shuttingDown = true;
    for (const k of kicks.values()) s.clock.clearTimeout(k.handle);
    kicks.clear();
    // streams are aborted ('shutdown'); a tool round in progress may finish within the grace period
    for (const l of live.values()) {
      const run = s.repos.runs.get(l.runId);
      if (run?.phase !== 'tools') l.abort.abort('shutdown');
    }
    const all = Promise.allSettled([...inflight]);
    let timer: unknown = null;
    await Promise.race([all, new Promise<void>((res) => (timer = s.clock.setTimeout(res, timeoutMs)))]);
    if (timer !== null) s.clock.clearTimeout(timer);
    for (const l of live.values()) l.abort.abort('shutdown');
    // aborted calls unwind through microtasks only: let them finish before the DB closes (bounded, no timers)
    let done = false;
    void Promise.allSettled([...inflight]).then(() => (done = true));
    for (let i = 0; i < 200 && !done; i++) await Promise.resolve();
  }

  function requestRotation(conversationId: string, reason: EpochReason, o?: { excludeTexts?: string[] }): void {
    s.repos.conversations.update(conversationId, { rotatePending: reason });
    if (o?.excludeTexts?.length) d.excludeTexts.set(conversationId, [...(d.excludeTexts.get(conversationId) ?? []), ...o.excludeTexts]);
    s.scheduler.schedule({ kind: 'epoch_rotate', runAt: s.clock.now(), refId: conversationId, payload: { conversationId, reason }, dedupeKey: `rotate:${conversationId}` });
  }

  /**
   * epoch_rotate job: rotate an idle conversation now so forgotten content is shredded promptly. Serialized per
   * conversation: while it awaits the handoff, a run start waits on `rotations` instead of rotating a second time.
   */
  async function rotateNow(conversationId: string): Promise<'done' | 'busy' | 'none'> {
    const conv = s.repos.conversations.get(conversationId);
    if (!conv || !conv.rotatePending) return 'none';
    if (conv.activeRunId || rotations.has(conversationId)) return 'busy';
    let release!: () => void;
    const p = new Promise<void>((res) => (release = res));
    rotations.set(conversationId, p);
    try {
      const reason = conv.rotatePending as EpochReason;
      const ex = d.excludeTexts.get(conversationId);
      const rows = s.repos.messages.load(conv.id, conv.epoch);
      if (rows.length === 0) {
        s.repos.conversations.update(conv.id, { rotatePending: null });
        return 'done';
      }
      const rot = await rotate(d.epochs, conv, reason, { ...(ex ? { excludeTexts: ex } : {}), priority: 'background' });
      d.excludeTexts.delete(conversationId);
      // the seed waits on the new (empty) epoch for the next run start
      if (rot.seed) s.repos.conversations.updateEpoch(conv.id, rot.epoch.epoch, { handoffSummary: rot.seed.body });
      for (const e of rot.shred) scheduleShred(s, conv.id, e, reason);
      return 'done';
    } finally {
      rotations.delete(conversationId);
      release();
    }
  }

  async function wakeById(runId: string, p: WakePayload): Promise<boolean> {
    const r = s.repos.runs.get(runId);
    return r && r.state === 'parked' ? wakeRun(r, p) : false;
  }

  return { kick, startEventRun, wake, stopByDraft, stopRun, recover, idle, shutdown, requestRotation, startNext, rotateNow, launch, wakeById };
}

/** Results in tool_use order (the executor already returns them so; this guards against a reordering). */
export function orderResults(uses: readonly BetaToolUseBlock[], results: readonly BetaToolResultBlockParam[]): BetaToolResultBlockParam[] {
  const byId = new Map(results.map((r) => [r.tool_use_id, r]));
  return uses.map((u) => byId.get(u.id) ?? { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ error: 'NO_RESULT' }), is_error: true });
}
