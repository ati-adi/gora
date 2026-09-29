// trust/executor.ts (WP4) — 01 §5.6 tool rounds, approval gating and resume. The ONLY place that calls spec.execute,
// spec.undo and spec.reconcile. Every decision is recorded (sentinel_decisions + ledger). Results are returned in
// tool_use order; task_wait's own result is written by the runner when the run wakes.
import type {
  BetaToolResultBlockParam, BetaToolUseBlock, Classification, ConversationRow, Decision, Effect, Priority, ProposedAction, ReplyChannel, RoundOutcome,
  RunRow, Services, Surface, TaintSource, Target, ToolCallRow, ToolCtx, ToolExecutor, ToolOutput, ToolSpec, UserId, ApprovalDiff,
} from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { ownerLang } from './approvalCards.ts';
import type { ApprovalsImpl } from './approvals.ts';
import type { GrantsImpl } from './grants.ts';
import { consultLlmSentinel } from './llmSentinel.ts';
import { blocksText, resolveTargetsInEpoch, type TrustedTargetsImpl } from './provenance.ts';
import { diffHmac, recordDecision, type PaRepo, type PaRow } from './repo.ts';
import { evaluateRules } from './rules.ts';
import type { SentinelImpl } from './sentinel.ts';
import { persistTaint, runTaint, serverToolTaint, taintOfOutput, taintOfStoredResult } from './taint.ts';

export const PARALLEL_READS = 4;
const READ_CLASSES = new Set(['read_public', 'read_private']);
/** spec 05 A6: tools whose success may carry the lazy tz button (plus Google Calendar writes). */
const TZ_HINT_TOOLS: ReadonlySet<string> = new Set(['reminder_create', 'reminder_manage']);
const EVENT_TRIGGERS = new Set(['event', 'biz_draft']);
export const SURFACE_OF: Record<ConversationRow['kind'], Surface> = { dm: 'dm', topic: 'topic', mission: 'mission', group: 'group', guest: 'guest', biz_draft: 'biz_draft' };
export const DM_WAIT_CAP_MS = 24 * 3_600_000;
/** An approval still 'approved' / 'executing' this long after the tap is stuck (crash or restart mid-execution). */
export const STUCK_AFTER_MS = 10 * 60_000;

export function denyText(d: Extract<Decision, { kind: 'deny' }>): string {
  return `Blocked by policy (${d.ruleId}): ${d.reason}. Do not retry; tell the user.`;
}
export function pendingResult(id: string, summary: string): string {
  return JSON.stringify({
    status: 'pending_approval',
    approval_id: id,
    performed: false,
    summary,
    note: `Waiting for the owner to tap Approve on the card. Do not say it is done. Do not re-propose. In a mission, call task_wait with on:["approval:${id}"] if later steps depend on it.`,
  });
}
const errBlock = (id: string, body: Record<string, unknown> | string): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: typeof body === 'string' ? body : JSON.stringify(body), is_error: true });
const okBlock = (id: string, content: string): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content });

/** revise(): Mini App edits are owner text for provenance; extra card warnings (e.g. "changed since you saw it"). */
export interface ReviseOpts { ownerText?: string; extraWarnings?: string[] }

interface Deps { pa: PaRepo; grants: GrantsImpl; tt: TrustedTargetsImpl; sentinel: SentinelImpl; approvals: () => ApprovalsImpl }

interface CallState {
  use: { id: string; name: string; input: unknown }; spec?: ToolSpec; input?: unknown; ctx?: ToolCtx; cls?: Classification; targets?: Target[];
  result?: BetaToolResultBlockParam; pushed: Effect[];
}

export function createExecutor(s: Services, d: Deps) {
  const safe = <T,>(f: () => T, fb: T): T => {
    try {
      return f();
    } catch {
      return fb;
    }
  };
  const updateCall = (id: string, patch: Partial<Omit<ToolCallRow, 'toolUseId'>>) => safe(() => s.repos.runs.updateToolCall(id, patch), undefined);

  const buildCtx = (p: { run: RunRow | null; conv: ConversationRow | null; userId: UserId | null; toolUseId: string; idemKey: string; signal: AbortSignal; pushed: Effect[]; taint: ReadonlySet<TaintSource>; priority: Priority; chat?: { chatId: number; threadId?: number }; approvedPendingActionId?: string }): ToolCtx => {
    const user = p.userId ? safe(() => s.repos.users.getById(p.userId!), undefined) : undefined;
    const conv = p.conv;
    const rr = p.run?.replyRef;
    const chatId = rr?.chatId ?? p.chat?.chatId ?? user?.dmChatId ?? 0;
    const threadId = rr?.threadId ?? p.chat?.threadId;
    return {
      toolUseId: p.toolUseId, runId: p.run?.id ?? '', conversationId: conv?.id ?? p.run?.conversationId ?? '', epoch: p.run?.epoch ?? conv?.epoch ?? 0,
      userId: p.userId, tgUserId: user?.tgUserId ?? null, surface: conv ? SURFACE_OF[conv.kind] : 'dm',
      scope: conv?.kind === 'group' && conv.tgChatId !== null ? { kind: 'group', chatId: conv.tgChatId } : p.userId ? { kind: 'user', userId: p.userId } : null,
      tz: user?.tz ?? 'UTC', lang: user?.languageCode ?? 'en', now: s.clock.now(),
      chat: {
        chatId,
        ...(threadId !== undefined ? { threadId } : {}),
        ...(rr?.triggerMessageId !== undefined ? { triggerMessageId: rr.triggerMessageId } : {}),
        ...(rr?.businessConnectionId !== undefined ? { businessConnectionId: rr.businessConnectionId } : {}),
      },
      ...(rr?.missionId !== undefined ? { missionId: rr.missionId } : {}),
      taint: p.taint, signal: p.signal, effects: { push: (e) => void p.pushed.push(e) }, services: s, log: s.log, idemKey: p.idemKey, priority: p.priority,
      ...(p.approvedPendingActionId ? { approvedAction: { pendingActionId: p.approvedPendingActionId } } : {}),
    };
  };

  const toolsetHas = (conv: ConversationRow | null, name: string): boolean => {
    if (!conv) return true;
    return safe(() => s.registry.toolset(conv.toolset).names.has(name), false);
  };

  const ownerRunText = (run: RunRow | null): string => {
    if (!run) return '';
    return safe(
      () =>
        s.repos.inputs
          .consumedBy(run.id)
          .filter((i) => i.author === 'owner' && !i.untrusted)
          .map((i) => blocksText(i.content))
          .join('\n'),
      '',
    );
  };

  /** `extraOwnerText`: owner-authored text outside the conversation (Mini App edits) that counts as owner text. */
  const resolveTargets = async (spec: ToolSpec, input: unknown, ctx: ToolCtx, conv: ConversationRow | null, userId: UserId | null, extraOwnerText?: string): Promise<Target[]> => {
    if (!spec.targets) return [];
    const raw = await spec.targets(input, ctx);
    if (!conv) return raw.map((t) => ({ ...t, provenance: 'unknown' as const }));
    return resolveTargetsInEpoch(s, d.tt, userId, conv.id, ctx.epoch, raw, uiLang(ctx.lang), extraOwnerText);
  };

  /** Rules + (03 R5) LLM Sentinel, recorded. */
  const decide = async (p: { a: ProposedAction; run: RunRow | null; conv: ConversationRow | null; userId: UserId | null; input: unknown; extraTaint: Iterable<TaintSource>; chatRef?: string | null; pendingActionId?: string | null }): Promise<Decision> => {
    const snap = d.sentinel.snapshotWith(p.userId, p.run, p.a, { extraTaint: p.extraTaint, ...(p.chatRef !== undefined ? { chatRef: p.chatRef } : {}) });
    const spec = s.registry.get(p.a.toolName);
    const surfaceAllowed = !!spec && spec.surfaces.includes(p.a.surface) && toolsetHas(p.conv, p.a.toolName);
    let decision = evaluateRules(p.a, snap, { surfaceAllowed, lang: p.userId ? ownerLang(s, p.userId) : null });
    if (p.a.phase === 'propose') {
      decision = await consultLlmSentinel(
        {
          cap: safe(() => s.capabilities?.llmSentinel ?? s.caps?.llmSentinel, undefined),
          enabled: !!s.config.groq?.apiKey,
          clock: s.clock,
          log: s.log,
          safetyLine: (r) => `⚠ ${safe(() => s.strings.t('safety_check', uiLang(p.userId ? ownerLang(s, p.userId) : null), { rationale: r }), `Safety check: ${r}`)}`,
        },
        {
          decision, actionClass: p.a.cls.actionClass, tainted: snap.taint.size > 0, eventRun: !!p.run && EVENT_TRIGGERS.has(p.run.trigger),
          tool: p.a.toolName, input: p.input, ownerText: ownerRunText(p.run), taint: [...snap.taint], priority: p.run?.priority ?? 'background',
          userId: p.userId, runId: p.run?.id ?? null, conversationId: p.conv?.id ?? null,
        },
      );
    }
    safe(
      () =>
        recordDecision(s, { userId: p.userId, runId: p.run?.id ?? null, toolUseId: p.a.toolUseId, pendingActionId: p.pendingActionId ?? null, toolName: p.a.toolName, actionClass: p.a.cls.actionClass, risk: p.a.cls.risk, d: decision, tainted: snap.taint.size > 0, phase: p.a.phase }),
      undefined,
    );
    if (p.userId) {
      safe(
        () =>
          s.ledger.append({ userId: p.userId!, actor: 'sentinel', kind: 'tool_call', summary: `${p.a.toolName}: ${decision.kind} (${decision.ruleId})`, detail: { rule: decision.ruleId, decision: decision.kind, phase: p.a.phase, tainted: snap.taint.size > 0 }, toolUseId: p.a.toolUseId, ...(p.run ? { runId: p.run.id } : {}) }),
        0,
      );
    }
    if (decision.kind === 'allow' && decision.grantId) safe(() => d.grants.countUse(decision.grantId!), undefined);
    return decision;
  };

  /** Redact / wrap the output, issue Undo, write ledger lines. Returns the model-facing content and added taint. */
  const finishOutput = async (spec: ToolSpec, cls: Classification, ctx: ToolCtx, out: ToolOutput): Promise<{ content: string; taint: TaintSource | null; effects: Effect[] }> => {
    const taint = taintOfOutput(spec.outputTaint, out.untrusted);
    const raw = typeof out.content === 'string' ? out.content : JSON.stringify(out.content ?? '');
    const content = taint
      ? (await s.untrusted.wrap({ source: taint, label: out.untrusted?.label ?? spec.name, text: raw, userId: ctx.userId, runId: ctx.runId || null, priority: ctx.priority })).text
      : s.untrusted.redact(raw);
    const effects: Effect[] = [...(out.effects ?? [])];
    if (out.undo && ctx.userId && !out.isError && cls.actionClass === 'write_self') {
      const undoId = s.undo.issue({ userId: ctx.userId, toolUseId: ctx.toolUseId, toolName: spec.name, payload: out.undo.payload, ttlMs: s.config.limits.undoTtlMs });
      effects.push({ kind: 'line', markdown: out.undo.line, undoId });
    }
    if (ctx.userId) {
      for (const l of out.ledger ?? []) safe(() => s.ledger.append({ ...l, userId: ctx.userId!, actor: 'agent', toolUseId: ctx.toolUseId, ...(ctx.runId ? { runId: ctx.runId } : {}) }), 0);
      if (cls.actionClass === 'read_private' && !out.isError) safe(() => s.ledger.append({ userId: ctx.userId!, actor: 'agent', kind: 'data_read', summary: `Read via ${spec.name}`, toolUseId: ctx.toolUseId, ...(ctx.runId ? { runId: ctx.runId } : {}) }), 0);
    }
    return { content, taint, effects };
  };

  /** F4: S06 checks cls.quotaKind; a successful execution spends one unit ('mission'/'watcher' are live counts: no-op). */
  const consumeQuota = (userId: UserId | null | undefined, cls: Classification): void => {
    if (!userId || !cls.quotaKind) return;
    safe(() => s.quotas.consume(userId, cls.quotaKind!), undefined);
  };

  const runAllowed = async (c: CallState, taintAcc: Set<TaintSource>, effectsOut: Effect[], run: RunRow | null): Promise<void> => {
    const spec = c.spec!;
    const ctx = c.ctx!;
    updateCall(c.use.id, { status: 'executing' });
    try {
      const out = await spec.execute(c.input, ctx);
      const f = await finishOutput(spec, c.cls!, ctx, out);
      if (f.taint) {
        taintAcc.add(f.taint);
        persistTaint(s, run, [f.taint]); // before the wrapped text is stored anywhere (crash / Stop safe)
      }
      c.pushed.push(...f.effects);
      if (!out.isError) {
        const hint = tzHintEffect(spec, c.cls!, ctx);
        if (hint) c.pushed.push(hint);
      }
      effectsOut.push(...c.pushed);
      updateCall(c.use.id, { status: out.isError ? 'error' : 'done', result: f.content, isError: !!out.isError });
      if (!out.isError) consumeQuota(ctx.userId, c.cls!);
      c.result = out.isError ? { type: 'tool_result', tool_use_id: c.use.id, content: f.content, is_error: true } : okBlock(c.use.id, f.content);
    } catch (e) {
      const msg = s.untrusted.redact(errorMessage(e)).slice(0, 300);
      effectsOut.push(...c.pushed);
      // F2: a throw after the side effect may have happened (e.g. OutcomeUnknownError from a timed-out send) is
      // reconciled like finishInterruptedRound does: 'done' → done, 'unknown' → unknown, only 'not_done' → error.
      let verdict: 'done' | 'not_done' | 'unknown' = e instanceof Error && e.name === 'OutcomeUnknownError' ? 'unknown' : 'not_done';
      if (spec.reconcile) verdict = await spec.reconcile(c.input, ctx).catch(() => 'unknown' as const);
      if (verdict === 'done') {
        const body = 'Done (confirmed after an error).';
        updateCall(c.use.id, { status: 'done', isError: false, result: body });
        c.result = okBlock(c.use.id, body);
      } else if (verdict === 'unknown') {
        const body = 'The outcome is unknown. Do not retry; tell the user to check.';
        updateCall(c.use.id, { status: 'unknown', isError: true, result: body });
        c.result = errBlock(c.use.id, { error: 'OUTCOME_UNKNOWN', message: body });
      } else {
        updateCall(c.use.id, { status: 'error', isError: true, result: msg });
        c.result = errBlock(c.use.id, { error: 'TOOL_FAILED', message: msg });
      }
    }
  };

  /**
   * spec 05 A6 lazy time zone: a time-dependent tool that succeeded while the owner's zone is still the best guess
   * (tz_source 'default') gets ONE compact web_app button under the reply, at most once per LIMITS.tzHintEveryMs
   * (users.tz_hint_at). Private surfaces only (web_app buttons do not work in groups).
   */
  const tzHintEffect = (spec: ToolSpec, cls: Classification, ctx: ToolCtx): Effect | null => {
    if (!ctx.userId || !(ctx.surface === 'dm' || ctx.surface === 'topic' || ctx.surface === 'mission')) return null;
    const timed = TZ_HINT_TOOLS.has(spec.name) || (cls.integration === 'gcal' && !READ_CLASSES.has(cls.actionClass));
    if (!timed) return null;
    const u = safe(() => s.repos.users.getById(ctx.userId!), undefined);
    if (!u || u.tzSource !== 'default') return null;
    const now = s.clock.now();
    if (u.tzHintAt !== null && now - u.tzHintAt < s.config.limits.tzHintEveryMs) return null;
    safe(() => s.repos.users.update(u.id, { tzHintAt: now }), undefined);
    const text = safe(() => s.strings.t('tz_hint_button', uiLang(u.languageCode)), '🕒 Set my time zone');
    return { kind: 'buttons', rows: [[{ text, web_app: { url: `${s.config.publicUrl}/app/?screen=tz` } }]] };
  };

  const sideCardForDeny = async (dec: Extract<Decision, { kind: 'deny' }>, cls: Classification, userId: UserId | null, chat: { chatId: number; threadId?: number }): Promise<void> => {
    if (!userId || !chat.chatId) return;
    try {
      if (dec.code === 'not_connected' && (cls.integration === 'gmail' || cls.integration === 'gcal')) await s.integrations.sendConnectCard(userId, cls.integration, chat, 'needed');
      else if (dec.code === 'quota') await s.notices.quotaExceeded(userId, cls.quotaKind && !s.quotas.check(userId, cls.quotaKind).ok ? cls.quotaKind : 'cost_micros', chat);
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error', code: dec.code }, 'executor: deny side card failed');
    }
  };

  const fallbackDiff = (spec: ToolSpec, input: unknown, lang: string, targets: Target[]): ApprovalDiff => {
    const rows: Array<[string, string]> = [];
    if (input && typeof input === 'object') for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 8)) rows.push([k, typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200)]);
    const label = safe(() => spec.statusLabel(input, lang), spec.name);
    return { title: label, summary: label, rows, warnings: [], targets };
  };

  const defaultExpiry = (conv: ConversationRow | null, userId: UserId): number => {
    const now = s.clock.now();
    if (conv?.kind === 'mission') return now + s.config.limits.missionApprovalMaxMs;
    const min = safe(() => s.repos.users.settings(userId).approvalExpiryMin, s.config.limits.approvalExpiryDefaultMin);
    return now + Math.max(1, min || s.config.limits.approvalExpiryDefaultMin) * 60_000;
  };

  const chatRefOf = (input: unknown): string | null => {
    const v = input && typeof input === 'object' ? (input as Record<string, unknown>)['chat_ref'] : undefined;
    return typeof v === 'string' ? v : null;
  };

  /**
   * s07 (spec 07 A4, BR): the picture shown with an approval card (the browser submit card's page screenshot). Sent into
   * the card's chat/thread right BEFORE the card (createInternal sends the card itself, so this runs just before it),
   * as a user-owned blob. Idempotency 'pa_photo:<runId>:<toolUseId>' (the pending-action id does not exist yet). Never
   * part of the sealed, HMAC-compared diff. Any error is logged and the card still goes out.
   */
  const sendApprovalAttachment = async (spec: ToolSpec, input: unknown, ctx: ToolCtx, run: { id: string; userId: UserId | null }, card: { chatId: number; threadId?: number }, toolUseId: string): Promise<void> => {
    if (!spec.approvalAttachment || !run.userId || !card.chatId) return;
    try {
      const att = await spec.approvalAttachment(input, ctx);
      if (!att || att.kind !== 'photo' || att.bytes.length === 0) return;
      const blobId = s.repos.messages.putBlob({ ownerUserId: run.userId, dek: `u:${run.userId}`, mime: 'image/jpeg', bytes: att.bytes });
      await s.telegram.outbox.sendNow({
        idempotencyKey: `pa_photo:${run.id}:${toolUseId}`, userId: run.userId, chatId: card.chatId, ...(card.threadId !== undefined ? { threadId: card.threadId } : {}),
        method: 'sendPhoto', payload: { blob_id: blobId, filename: 'page.jpg', ...(att.caption ? { caption: att.caption.slice(0, 200) } : {}) }, priority: 1, disableNotification: true,
      });
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error', tool: spec.name }, 'executor: approval attachment failed; sending the card without it');
    }
  };

  const askFlow = async (c: CallState, dec: Extract<Decision, { kind: 'ask' }>, run: RunRow, conv: ConversationRow, ch: ReplyChannel | null): Promise<void> => {
    const spec = c.spec!;
    const ctx = c.ctx!;
    if (!run.userId) {
      // No owner to ask (group/guest): an ask can never be satisfied there.
      updateCall(c.use.id, { status: 'denied', decision: 'ask', ruleId: dec.ruleId, isError: true });
      c.result = errBlock(c.use.id, `Blocked by policy (${dec.ruleId}): needs the owner's approval, which is not available here. Do not retry; tell the user.`);
      return;
    }
    const rendered = spec.renderDiff ? await spec.renderDiff(c.input, ctx) : fallbackDiff(spec, c.input, ctx.lang, c.targets ?? []);
    const diff: ApprovalDiff = { ...rendered, targets: c.targets ?? [] };
    const meta = spec.approvalMeta ? await spec.approvalMeta(c.input, ctx) : {};
    const card = meta.card ?? { chatId: ctx.chat.chatId, ...(ctx.chat.threadId !== undefined ? { threadId: ctx.chat.threadId } : {}) };
    const expiresAt = meta.expiresAt ?? defaultExpiry(conv, run.userId);
    if (ch) await ch.checkpoint().catch(() => undefined);
    if (spec.approvalAttachment) await sendApprovalAttachment(spec, c.input, ctx, run, card, c.use.id);
    const { id } = await d.approvals().createInternal({
      userId: run.userId, runId: run.id, conversationId: conv.id, toolUseId: c.use.id, version: 1, supersedesId: null, toolName: spec.name,
      input: c.input, cls: c.cls!, diff, decision: dec, expiresAt, card, sourceRefs: meta.sourceRefs ?? [],
    });
    const content = pendingResult(id, diff.summary);
    updateCall(c.use.id, { status: 'pending_approval', decision: 'ask', ruleId: dec.ruleId, pendingActionId: id, result: content, isError: false });
    c.result = okBlock(c.use.id, content);
  };

  async function round(run: RunRow, conv: ConversationRow, uses: Array<{ id: string; name: string; input: unknown }>, ch: ReplyChannel | null, signal: AbortSignal, seedTaint: readonly TaintSource[] = []): Promise<RoundOutcome> {
    const taintAdded = new Set<TaintSource>(seedTaint);
    const effects: Effect[] = [];
    const states: CallState[] = uses.map((u) => ({ use: u, pushed: [] }));
    let park: RoundOutcome['park'] = null;
    let batch: CallState[] = [];
    const flush = async () => {
      const b = batch;
      batch = [];
      for (let i = 0; i < b.length; i += PARALLEL_READS) {
        const slice = b.slice(i, i + PARALLEL_READS);
        const localEffects: Effect[][] = slice.map(() => []);
        await Promise.all(slice.map((c, j) => runAllowed(c, taintAdded, localEffects[j]!, run)));
        for (const e of localEffects) effects.push(...e); // keep tool_use order
      }
    };
    for (const c of states) {
      if (signal.aborted) break;
      const { use } = c;
      if (use.name === 'task_wait') {
        await flush();
        const inp = (use.input ?? {}) as { on?: unknown; timeout_hours?: unknown };
        const on = Array.isArray(inp.on) ? inp.on.filter((x): x is string => typeof x === 'string' && /^(approval:[A-Z0-9]{6}|watcher:[A-Za-z0-9_-]+|user_input)$/.test(x)).slice(0, 5) : [];
        const hours = typeof inp.timeout_hours === 'number' && Number.isFinite(inp.timeout_hours) ? Math.min(336, Math.max(0.05, inp.timeout_hours)) : null;
        if (on.length === 0 || hours === null || !s.registry.get('task_wait') || !toolsetHas(conv, 'task_wait')) {
          updateCall(use.id, { status: 'error', isError: true });
          c.result = errBlock(use.id, { error: 'INVALID_INPUT', issues: [{ path: 'on', message: 'on: 1..5 of approval:<ID>|watcher:<id>|user_input; timeout_hours 0.05..336' }] });
          continue;
        }
        let ms = Math.round(hours * 3_600_000);
        if (conv.kind === 'dm' || conv.kind === 'topic') ms = Math.min(ms, DM_WAIT_CAP_MS);
        const wakeOn = on.map((t) => (t === 'user_input' ? `user_input:${conv.id}` : t));
        park = park ? { wakeOn: [...new Set([...park.wakeOn, ...wakeOn])], wakeAt: Math.min(park.wakeAt ?? Infinity, s.clock.now() + ms) } : { wakeOn, wakeAt: s.clock.now() + ms };
        updateCall(use.id, { status: 'waiting', decision: 'allow', ruleId: 'S18', actionClass: 'control', risk: 0 });
        continue;
      }
      if (/^(pa|undo):/.test(use.id)) {
        // idempotency keys 'pa:<id>' / 'undo:<id>' belong to the approval / undo paths; a provider-supplied id never takes them
        updateCall(use.id, { status: 'error', isError: true });
        c.result = errBlock(use.id, { error: 'INVALID_TOOL_USE_ID' });
        continue;
      }
      const spec = s.registry.get(use.name);
      if (!spec) {
        updateCall(use.id, { status: 'error', isError: true });
        c.result = errBlock(use.id, { error: 'UNKNOWN_TOOL' });
        continue;
      }
      const parsed = spec.input.safeParse(use.input);
      if (!parsed.success) {
        updateCall(use.id, { status: 'error', isError: true });
        c.result = errBlock(use.id, { error: 'INVALID_INPUT', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        continue;
      }
      c.spec = spec;
      c.input = parsed.data;
      let cls: Classification;
      try {
        cls = spec.classify(parsed.data, buildCtx({ run, conv, userId: run.userId, toolUseId: use.id, idemKey: use.id, signal, pushed: c.pushed, taint: runTaint(s, run, conv, taintAdded), priority: run.priority }));
      } catch (e) {
        updateCall(use.id, { status: 'error', isError: true });
        c.result = errBlock(use.id, { error: 'INVALID_INPUT', issues: [{ path: '', message: s.untrusted.redact(errorMessage(e)).slice(0, 200) }] });
        continue;
      }
      c.cls = cls;
      const parallel = spec.parallelSafe && READ_CLASSES.has(cls.actionClass);
      if (!parallel) await flush(); // later decisions see the taint of earlier outputs
      const taint = runTaint(s, run, conv, taintAdded);
      c.ctx = buildCtx({ run, conv, userId: run.userId, toolUseId: use.id, idemKey: use.id, signal, pushed: c.pushed, taint, priority: run.priority });
      try {
        c.targets = await resolveTargets(spec, parsed.data, c.ctx, conv, run.userId);
      } catch (e) {
        updateCall(use.id, { status: 'error', isError: true });
        c.result = errBlock(use.id, { error: 'TOOL_FAILED', message: s.untrusted.redact(errorMessage(e)).slice(0, 200) });
        continue;
      }
      const a: ProposedAction = { toolName: spec.name, toolUseId: use.id, cls, targets: c.targets, surface: SURFACE_OF[conv.kind], phase: 'propose' };
      const dec = await decide({ a, run, conv, userId: run.userId, input: parsed.data, extraTaint: taintAdded, chatRef: chatRefOf(parsed.data) });
      updateCall(use.id, { actionClass: cls.actionClass, risk: cls.risk, decision: dec.kind, ruleId: dec.ruleId });
      if (dec.kind === 'deny') {
        updateCall(use.id, { status: 'denied', isError: true });
        c.result = errBlock(use.id, denyText(dec));
        await sideCardForDeny(dec, cls, run.userId, c.ctx.chat);
        continue;
      }
      if (dec.kind === 'ask') {
        try {
          await askFlow(c, dec, run, conv, ch);
        } catch (e) {
          updateCall(use.id, { status: 'error', isError: true });
          c.result = errBlock(use.id, { error: 'APPROVAL_FAILED', message: s.untrusted.redact(errorMessage(e)).slice(0, 200) });
        }
        continue;
      }
      if (parallel) {
        batch.push(c);
        continue;
      }
      ch?.status(safe(() => spec.statusLabel(parsed.data, c.ctx!.lang), null));
      await runAllowed(c, taintAdded, effects, run);
      ch?.status(null);
    }
    await flush();
    const results = states.filter((c) => c.result).map((c) => c.result!);
    return { results, park, taintAdded: [...taintAdded], effects };
  }

  // ── approvals: execution after the tap (no model call in between)

  /** Approvals executing in this process right now; the stuck-row sweep never touches them. */
  const inFlight = new Set<string>();

  interface Prepared { spec: ToolSpec; input: unknown; storedTargets: Target[]; run: RunRow | null; conv: ConversationRow | null; ctx: ToolCtx; cls: Classification; pushed: Effect[] }

  /** Everything needed to re-check or run a stored approval: spec, stored input/targets, run/conv and a ctx (idemKey pa:<id>). */
  const prepare = (row: PaRow): Prepared | { error: string } => {
    const spec = s.registry.get(row.tool_name);
    if (!spec) return { error: 'Tool no longer available' };
    let input: unknown;
    let storedTargets: Target[];
    try {
      input = d.pa.input(row);
      storedTargets = d.pa.targets(row);
    } catch {
      return { error: 'Approval data is no longer available' };
    }
    const run = row.run_id ? safe(() => s.repos.runs.get(row.run_id!), undefined) ?? null : null;
    const conv = row.conversation_id ? safe(() => s.repos.conversations.get(row.conversation_id!), undefined) ?? null : null;
    const pushed: Effect[] = [];
    const ctx = buildCtx({ run, conv, userId: row.user_id, toolUseId: row.tool_use_id, idemKey: `pa:${row.id}`, approvedPendingActionId: row.id, signal: new AbortController().signal, pushed, taint: runTaint(s, run, conv), priority: 'approval', chat: row.card_chat_id !== null ? { chatId: row.card_chat_id, ...(row.card_thread_id !== null ? { threadId: row.card_thread_id } : {}) } : undefined });
    let cls: Classification;
    try {
      cls = spec.classify(input, ctx);
    } catch {
      return { error: 'Could not classify the action' };
    }
    return { spec, input, storedTargets, run, conv, ctx, cls, pushed };
  };

  /**
   * TOCTOU (01 §5.6 step 3.2): re-render the diff from the stored input AND re-resolve its targets from the current
   * remote object, so a recipient added remotely changes the HMAC and is provenance-checked on the new card.
   */
  const freshDiff = async (p: Prepared, row: PaRow): Promise<ApprovalDiff> => {
    const targets = p.spec.targets ? await resolveTargets(p.spec, p.input, p.ctx, p.conv, row.user_id) : p.storedTargets;
    const r = p.spec.renderDiff ? await p.spec.renderDiff(p.input, p.ctx) : fallbackDiff(p.spec, p.input, p.ctx.lang, targets);
    return { ...r, targets };
  };

  /** True when the action no longer matches the card the owner saw (or cannot be re-checked). */
  const isStale = async (id: string): Promise<boolean> => {
    const row = d.pa.get(id);
    if (!row) return true;
    const p = prepare(row);
    if ('error' in p) return true;
    try {
      return diffHmac(s, await freshDiff(p, row)) !== row.diff_hmac;
    } catch {
      return true;
    }
  };

  const executeApproved: ToolExecutor['executeApproved'] = async (id) => {
    inFlight.add(id);
    try {
      return await executeApprovedInner(id);
    } finally {
      inFlight.delete(id);
    }
  };

  const executeApprovedInner: ToolExecutor['executeApproved'] = async (id) => {
    const ap = d.approvals();
    let row = d.pa.get(id);
    if (!row) return { status: 'failed', summary: 'Approval not found' };
    if (!d.pa.cas(id, 'approved', 'executing')) {
      // Idempotent: report the outcome of the earlier execution.
      const cur = d.pa.get(id)!;
      const res = d.pa.result(cur);
      const map: Record<string, 'executed' | 'superseded' | 'failed' | 'unknown'> = { executed: 'executed', superseded: 'superseded', failed: 'failed', unknown: 'unknown', executing: 'unknown' };
      return { status: map[cur.status] ?? 'failed', summary: res?.summary ?? ap.str('already_handled', ownerLang(s, cur.user_id)) };
    }
    row = d.pa.get(id)!;
    const finish = async (status: 'executed' | 'failed' | 'unknown', summary: string, outcome: 'executed' | 'failed' | 'unknown' | 'blocked', ledgerSeq?: number) => {
      d.pa.setResult(row!, { summary, ok: status === 'executed', executedAt: s.clock.now(), ...(ledgerSeq ? { ledgerSeq } : {}) });
      d.pa.cas(id, 'executing', status);
      ap.toolCallStatus(row!, status === 'executed' ? 'executed_after_approval' : 'declined_after_approval');
      await ap.editCard(row!, outcome, { summary, ...(ledgerSeq ? { ledgerSeq } : {}) });
      await ap.notify(row!, 'approved', status === 'executed', summary);
    };
    const p = prepare(row);
    if ('error' in p) {
      await finish('failed', p.error, 'failed');
      return { status: 'failed', summary: p.error };
    }
    const { spec, input, storedTargets, run, conv, ctx, cls, pushed } = p;
    // 1. Sentinel again, phase 'execute': /pause, revocations, quota and the business window still win.
    const a: ProposedAction = { toolName: spec.name, toolUseId: row.tool_use_id, cls, targets: storedTargets, surface: ctx.surface, phase: 'execute', approvedPendingActionId: id };
    const dec = await decide({ a, run, conv, userId: row.user_id, input, extraTaint: [], chatRef: chatRefOf(input), pendingActionId: id });
    if (dec.kind === 'deny') {
      await blocked(row, dec);
      return { status: 'denied_by_policy', summary: denyText(dec) };
    }
    // 2. TOCTOU: recompute the diff (and its targets) from the stored input and compare its HMAC.
    let fresh: ApprovalDiff;
    try {
      fresh = await freshDiff(p, row);
    } catch (e) {
      await finish('failed', 'Could not re-check the action', 'failed');
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'executor: renderDiff at execution failed');
      return { status: 'failed', summary: 'Could not re-check the action' };
    }
    if (diffHmac(s, fresh) !== row.diff_hmac) {
      const newId = await supersedeWith(row, p, fresh);
      if (newId === 'blocked') return { status: 'denied_by_policy', summary: 'Blocked by policy after the change' };
      return { status: 'superseded', summary: newId ? `Changed since the card; new approval ${newId}` : 'Changed since the card' };
    }
    // 3. Execute the stored input with idemKey 'pa:<id>'.
    let out: ToolOutput;
    try {
      out = await spec.execute(input, ctx);
    } catch (e) {
      let status: 'failed' | 'unknown' | 'executed' = 'failed';
      if (spec.reconcile) {
        const rec = await spec.reconcile(input, ctx).catch(() => 'unknown' as const);
        status = rec === 'done' ? 'executed' : rec === 'not_done' ? 'failed' : 'unknown';
      }
      const summary = status === 'executed' ? fresh.summary : status === 'unknown' ? 'Outcome unknown' : `Failed: ${s.untrusted.redact(errorMessage(e)).slice(0, 120)}`;
      if (status === 'executed') afterExecuted(row, fresh.targets);
      await finish(status, summary, status);
      return { status, summary };
    }
    const f = await finishOutput(spec, cls, ctx, out);
    if (out.isError) {
      await finish('failed', `Failed: ${f.content.slice(0, 160)}`, 'failed');
      return { status: 'failed', summary: `Failed: ${f.content.slice(0, 160)}` };
    }
    afterExecuted(row, fresh.targets);
    consumeQuota(row.user_id, cls);
    const seq = safe(() => s.ledger.append({ userId: row!.user_id, actor: 'agent', kind: 'tool_call', summary: `Executed approved ${spec.name}`, pendingActionId: id, toolUseId: row!.tool_use_id, ...(row!.run_id ? { runId: row!.run_id } : {}) }), 0);
    await finish('executed', fresh.summary, 'executed', seq || undefined);
    deliverEffects(row, [...pushed, ...f.effects]);
    return { status: 'executed', summary: fresh.summary };
  };

  /** A row in 'executing' blocked by policy: failed, card edited to 'blocked', the run told. */
  const blocked = async (row: PaRow, dec: Extract<Decision, { kind: 'deny' }>): Promise<void> => {
    const ap = d.approvals();
    d.pa.setResult(row, { summary: denyText(dec), ok: false });
    d.pa.cas(row.id, 'executing', 'failed');
    ap.toolCallStatus(row, 'declined_after_approval');
    await ap.editCard(row, 'blocked', { note: dec.reason });
    await ap.notify(row, 'approved', false, `blocked by policy (${dec.ruleId})`);
  };

  /** Targets of executed approvals become trusted (source approved_action). */
  const afterExecuted = (row: PaRow, targets: Target[]) => {
    for (const t of targets) safe(() => d.tt.addApproved(row.user_id, { kind: t.kind, value: t.value }, row.id), undefined);
  };

  /** Effect lines of an approved execution (e.g. Undo) go to the card's chat as a short message. */
  const deliverEffects = (row: PaRow, effects: Effect[]) => {
    if (row.card_chat_id === null) return;
    for (const [i, e] of effects.entries()) {
      if (e.kind !== 'line') continue;
      const owner = safe(() => s.repos.users.getById(row.user_id), undefined);
      const buttons = e.undoId && owner ? [[{ text: safe(() => s.strings.t('undo_button', uiLang(owner.languageCode)), '↩ Undo'), callback_data: s.telegram.codec.encode('ud', [e.undoId], owner.tgUserId) }]] : [];
      safe(
        () =>
          s.telegram.outbox.enqueue({
            idempotencyKey: `pa:effect:${row.id}:${i}`,
            userId: row.user_id,
            chatId: row.card_chat_id!,
            ...(row.card_thread_id !== null ? { threadId: row.card_thread_id } : {}),
            method: 'sendRichMessage',
            payload: buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {},
            markdown: e.markdown,
          }),
        '',
      );
    }
  };

  /**
   * TOCTOU: the old card becomes superseded and a new card is shown with "Draft changed since you saw it". The changed
   * action goes through the Sentinel again (phase 'propose'): fresh targets get their S13 provenance warnings, the LLM
   * Sentinel may add its own, and the original card's warnings are carried over. A deny blocks it instead.
   */
  const supersedeWith = async (row: PaRow, p: Prepared, diff: ApprovalDiff): Promise<string | null | 'blocked'> => {
    const ap = d.approvals();
    const lang = ownerLang(s, row.user_id);
    const version = row.version + 1;
    const base = row.tool_use_id.split('~')[0]!;
    const toolUseId = `${base}~v${version}`;
    const a: ProposedAction = { toolName: p.spec.name, toolUseId, cls: p.cls, targets: diff.targets, surface: p.ctx.surface, phase: 'propose' };
    const dec = await decide({ a, run: p.run, conv: p.conv, userId: row.user_id, input: p.input, extraTaint: [], chatRef: chatRefOf(p.input), pendingActionId: row.id });
    if (dec.kind === 'deny') {
      await blocked(row, dec);
      return 'blocked';
    }
    const oldWarnings = safe(() => JSON.parse(row.warnings_json) as string[], []);
    const newWarnings = dec.kind === 'ask' ? dec.warnings : [];
    d.pa.setResult(row, { summary: 'superseded', ok: false });
    d.pa.cas(row.id, 'executing', 'superseded');
    await ap.editCard(row, 'superseded');
    let newId: string | null = null;
    const newCard = row.card_chat_id !== null ? { chatId: row.card_chat_id, ...(row.card_thread_id !== null ? { threadId: row.card_thread_id } : {}) } : { chatId: p.ctx.chat.chatId };
    // the replacement card carries its own picture too (A4: the browser submit card always shows the page)
    if (p.spec.approvalAttachment) await sendApprovalAttachment(p.spec, p.input, p.ctx, { id: row.run_id ?? row.id, userId: row.user_id }, newCard, toolUseId);
    try {
      const r = await ap.createInternal({
        userId: row.user_id, runId: row.run_id, conversationId: row.conversation_id, toolUseId, version, supersedesId: row.id, toolName: row.tool_name,
        input: p.input, cls: p.cls, diff, decision: { kind: 'ask', ruleId: 'T01', reason: 'Changed since the card', grantable: false, warnings: newWarnings },
        expiresAt: Math.max(row.expires_at, s.clock.now() + 60 * 60_000), card: newCard,
        sourceRefs: safe(() => JSON.parse(row.source_refs_json) as string[], []), extraWarnings: [`⚠ ${ap.str('draft_changed', lang)}`, ...oldWarnings],
      });
      newId = r.id;
      updateCall(base, { pendingActionId: newId, status: 'pending_approval' });
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'executor: supersede card failed');
    }
    await ap.notify(row, 'superseded', false, newId ? `changed since the card; new approval ${newId}` : 'changed since the card');
    return newId;
  };

  /**
   * Rows left in 'approved' or 'executing' by a crash, restart or exception between the tap and the end of execution
   * (01 §5.11). 'approved' never started: it runs now while the approval is still valid (idemKey pa:<id> keeps it
   * exactly-once), else it fails with a note. 'executing' may have run: never re-executed; reconciled when the tool
   * can, else 'unknown'. Either way the card is edited and the run told.
   */
  const recoverStuck = async (now: number): Promise<number> => {
    const ap = d.approvals();
    let n = 0;
    for (const stuck of d.pa.stuck(now - STUCK_AFTER_MS)) {
      if (inFlight.has(stuck.id)) continue;
      try {
        if (stuck.status === 'approved') {
          if (stuck.expires_at > now) {
            await executeApproved(stuck.id);
            n++;
            continue;
          }
          if (!d.pa.cas(stuck.id, 'approved', 'executing')) continue;
          const row = d.pa.get(stuck.id)!;
          const summary = 'Not done: interrupted by a restart before it ran. Ask again if still needed.';
          d.pa.setResult(row, { summary, ok: false });
          d.pa.cas(row.id, 'executing', 'failed');
          ap.toolCallStatus(row, 'declined_after_approval');
          await ap.editCard(row, 'failed', { summary });
          await ap.notify(row, 'approved', false, summary);
          n++;
          continue;
        }
        // 'executing'
        inFlight.add(stuck.id);
        try {
          const row = d.pa.get(stuck.id);
          if (!row || row.status !== 'executing') continue;
          const p = prepare(row);
          let verdict: 'done' | 'not_done' | 'unknown' = 'unknown';
          if (!('error' in p) && p.spec.reconcile) verdict = await p.spec.reconcile(p.input, p.ctx).catch(() => 'unknown' as const);
          const status = verdict === 'done' ? 'executed' : verdict === 'not_done' ? 'failed' : 'unknown';
          const summary = status === 'executed' ? 'Done (completed before a restart).' : status === 'failed' ? 'Not done: interrupted by a restart. Ask again if still needed.' : 'Outcome unknown after a restart; please check.';
          if (!d.pa.cas(row.id, 'executing', status)) continue;
          d.pa.setResult(row, { summary, ok: status === 'executed', executedAt: s.clock.now() });
          if (status === 'executed' && !('error' in p)) afterExecuted(row, p.storedTargets);
          ap.toolCallStatus(row, status === 'executed' ? 'executed_after_approval' : 'declined_after_approval');
          await ap.editCard(row, status, { summary });
          await ap.notify(row, 'approved', status === 'executed', summary);
          n++;
        } finally {
          inFlight.delete(stuck.id);
        }
      } catch (e) {
        s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'executor: stuck approval recovery failed');
      }
    }
    return n;
  };

  /** revise_pending_action and Mini App edits: validate with the target tool's schema, ask again, supersede the old card. */
  const revise = async (id: string, newInput: unknown, callerCtx: ToolCtx | null, opts: ReviseOpts = {}): Promise<{ newId: string } | { error: string }> => {
    const ap = d.approvals();
    const row = d.pa.get(id);
    if (!row) return { error: 'NOT_FOUND' };
    if (callerCtx && callerCtx.userId !== row.user_id) return { error: 'NOT_FOUND' };
    if (row.status !== 'pending' || row.expires_at <= s.clock.now()) return { error: 'NOT_PENDING' };
    const spec = s.registry.get(row.tool_name);
    if (!spec) return { error: 'UNKNOWN_TOOL' };
    const parsed = spec.input.safeParse(newInput);
    if (!parsed.success) return { error: JSON.stringify({ error: 'INVALID_INPUT', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }) };
    const run = row.run_id ? safe(() => s.repos.runs.get(row.run_id!), undefined) ?? null : null;
    const conv = row.conversation_id ? safe(() => s.repos.conversations.get(row.conversation_id!), undefined) ?? null : null;
    const version = row.version + 1;
    const base = row.tool_use_id.split('~')[0]!;
    const toolUseId = `${base}~v${version}`;
    const pushed: Effect[] = [];
    const extraTaint = callerCtx ? [...callerCtx.taint] : [];
    const ctx = buildCtx({ run, conv, userId: row.user_id, toolUseId, idemKey: toolUseId, signal: callerCtx?.signal ?? new AbortController().signal, pushed, taint: runTaint(s, run, conv, extraTaint), priority: callerCtx?.priority ?? 'interactive', chat: row.card_chat_id !== null ? { chatId: row.card_chat_id, ...(row.card_thread_id !== null ? { threadId: row.card_thread_id } : {}) } : undefined });
    const cls = spec.classify(parsed.data, ctx);
    const targets = await resolveTargets(spec, parsed.data, ctx, conv, row.user_id, opts.ownerText);
    const a: ProposedAction = { toolName: spec.name, toolUseId, cls, targets, surface: ctx.surface, phase: 'propose' };
    const dec = await decide({ a, run, conv, userId: row.user_id, input: parsed.data, extraTaint, chatRef: chatRefOf(parsed.data), pendingActionId: row.id });
    if (dec.kind === 'deny') return { error: denyText(dec) };
    const ask: Extract<Decision, { kind: 'ask' }> = dec.kind === 'ask' ? dec : { kind: 'ask', ruleId: 'R01', reason: 'Revised action', grantable: false, warnings: [] };
    const rendered = spec.renderDiff ? await spec.renderDiff(parsed.data, ctx) : fallbackDiff(spec, parsed.data, ctx.lang, targets);
    const diff: ApprovalDiff = { ...rendered, targets };
    if (!d.pa.cas(id, 'pending', 'superseded', { via: 'system', decidedBy: 0 })) return { error: 'NOT_PENDING' };
    const newCard = row.card_chat_id !== null ? { chatId: row.card_chat_id, ...(row.card_thread_id !== null ? { threadId: row.card_thread_id } : {}) } : { chatId: ctx.chat.chatId };
    if (spec.approvalAttachment) await sendApprovalAttachment(spec, parsed.data, ctx, { id: row.run_id ?? row.id, userId: row.user_id }, newCard, toolUseId);
    const r = await ap.createInternal({
      userId: row.user_id, runId: row.run_id, conversationId: row.conversation_id, toolUseId, version, supersedesId: row.id, toolName: spec.name,
      input: parsed.data, cls, diff, decision: ask, expiresAt: row.expires_at, card: newCard,
      sourceRefs: safe(() => JSON.parse(row.source_refs_json) as string[], []), ...(opts.extraWarnings?.length ? { extraWarnings: opts.extraWarnings } : {}),
    });
    updateCall(base, { pendingActionId: r.id });
    const old = d.pa.get(id)!;
    await ap.editCard(old, 'superseded');
    await ap.notify(old, 'superseded', false, `revised; new approval ${r.id}`);
    return { newId: r.id };
  };

  /** Runs spec.undo for the UndoService (executor is the only caller of spec.undo). */
  const runUndo = async (p: { userId: UserId; toolName: string; toolUseId: string; payload: unknown }): Promise<void> => {
    const spec = s.registry.get(p.toolName);
    if (!spec?.undo) throw new Error('tool has no undo');
    const user = s.repos.users.getById(p.userId);
    const ctx = buildCtx({ run: null, conv: null, userId: p.userId, toolUseId: p.toolUseId, idemKey: `undo:${p.toolUseId}`, signal: new AbortController().signal, pushed: [], taint: new Set(), priority: 'interactive', chat: { chatId: user?.dmChatId ?? 0 } });
    await spec.undo(p.payload, ctx);
  };

  /**
   * Taint of the stored assistant message of this round: server-tool results (web_search / web_fetch) that the model
   * read in the SAME response before choosing its client tool calls. Persisted and fed to every decision of the round.
   */
  const assistantTaint = (run: RunRow, assistantSeq: number): TaintSource[] => {
    const row = safe(() => {
      const last = s.repos.messages.last(run.conversationId, run.epoch);
      return last?.seq === assistantSeq ? last : s.repos.messages.load(run.conversationId, run.epoch).find((m) => m.seq === assistantSeq);
    }, undefined);
    if (!row || row.role !== 'assistant') return [];
    return serverToolTaint((row.content as { content?: unknown }).content);
  };

  const executor: ToolExecutor = {
    async processRound(run, conv, assistantSeq, uses: BetaToolUseBlock[], ch, signal) {
      const existing = new Set(safe(() => s.repos.runs.toolCallsFor(run.id, assistantSeq), [] as ToolCallRow[]).map((c) => c.toolUseId));
      const toStage = uses
        .map((u, ordinal) => ({ toolUseId: u.id, runId: run.id, conversationId: conv.id, epoch: run.epoch, userId: run.userId, assistantSeq, ordinal, name: u.name, input: u.input }))
        .filter((r) => !existing.has(r.toolUseId));
      if (toStage.length) s.repos.runs.stageToolCalls(toStage);
      const seed = assistantTaint(run, assistantSeq);
      persistTaint(s, run, seed);
      return round(run, conv, uses.map((u) => ({ id: u.id, name: u.name, input: u.input })), ch, signal, seed);
    },

    async finishInterruptedRound(run, conv, assistantSeq) {
      const calls = safe(() => s.repos.runs.toolCallsFor(run.id, assistantSeq), [] as ToolCallRow[]).sort((a, b) => a.ordinal - b.ordinal);
      const results: BetaToolResultBlockParam[] = [];
      const effects: Effect[] = [];
      // Taint of what already reached this round before the restart: server-tool results in the assistant message
      // and the wrapped outputs of calls that finished. Re-derived here, since the engine never saw that round end.
      const taint = new Set<TaintSource>(assistantTaint(run, assistantSeq));
      for (const c of calls) for (const t of taintOfStoredResult(c.result)) taint.add(t);
      persistTaint(s, run, taint);
      let park: RoundOutcome['park'] = null;
      for (const c of calls) {
        const content = typeof c.result === 'string' ? c.result : c.result === null || c.result === undefined ? '' : JSON.stringify(c.result);
        switch (c.status) {
          case 'done':
          case 'error':
          case 'denied':
          case 'pending_approval':
          case 'cancelled':
          case 'executed_after_approval':
          case 'declined_after_approval':
          case 'expired':
            if (c.status === 'pending_approval' && !content && c.pendingActionId) results.push(okBlock(c.toolUseId, pendingResult(c.pendingActionId, c.name)));
            else results.push({ type: 'tool_result', tool_use_id: c.toolUseId, content: content || (c.isError ? 'Error' : 'Done'), ...(c.isError ? { is_error: true } : {}) });
            break;
          case 'executing':
          case 'unknown': {
            // Started before the crash: never blindly re-execute a side effect. Reconcile if the tool can.
            const spec = s.registry.get(c.name);
            let verdict: 'done' | 'not_done' | 'unknown' = 'unknown';
            if (spec?.reconcile) {
              const pushed: Effect[] = [];
              const ctx = buildCtx({ run, conv, userId: run.userId, toolUseId: c.toolUseId, idemKey: c.toolUseId, signal: new AbortController().signal, pushed, taint: runTaint(s, run, conv), priority: run.priority });
              verdict = await spec.reconcile(c.input, ctx).catch(() => 'unknown' as const);
            }
            if (verdict === 'not_done' && spec) {
              const r = await round(run, conv, [{ id: c.toolUseId, name: c.name, input: c.input }], null, new AbortController().signal, [...taint]);
              results.push(...r.results);
              effects.push(...r.effects);
              r.taintAdded.forEach((t) => taint.add(t));
              park = park ?? r.park;
            } else {
              const body = verdict === 'done' ? 'Done (completed before a restart).' : 'The outcome is unknown after a restart. Do not retry; tell the user to check.';
              updateCall(c.toolUseId, { status: verdict === 'done' ? 'done' : 'unknown', result: body, isError: verdict !== 'done' });
              results.push({ type: 'tool_result', tool_use_id: c.toolUseId, content: body, ...(verdict !== 'done' ? { is_error: true } : {}) });
            }
            break;
          }
          case 'waiting':
            break; // task_wait: its result is written by the runner on wake
          default: {
            // staged: not started — safe to process now.
            const r = await round(run, conv, [{ id: c.toolUseId, name: c.name, input: c.input }], null, new AbortController().signal, [...taint]);
            results.push(...r.results);
            effects.push(...r.effects);
            r.taintAdded.forEach((t) => taint.add(t));
            if (r.park) park = park ? { wakeOn: [...new Set([...park.wakeOn, ...r.park.wakeOn])], wakeAt: Math.min(park.wakeAt ?? Infinity, r.park.wakeAt ?? Infinity) } : r.park;
          }
        }
      }
      return { results, park, taintAdded: [...taint], effects };
    },

    cancelUnstarted(runId, assistantSeq) {
      const calls = safe(() => s.repos.runs.toolCallsFor(runId, assistantSeq), [] as ToolCallRow[]).sort((a, b) => a.ordinal - b.ordinal);
      return calls
        .filter((c) => c.status === 'staged')
        .map((c) => {
          updateCall(c.toolUseId, { status: 'cancelled', isError: true, result: 'Cancelled by user before execution' });
          return errBlock(c.toolUseId, 'Cancelled by user before execution');
        });
    },

    executeApproved,
  };

  return { executor, revise, runUndo, buildCtx, isStale, recoverStuck };
}
export type ExecutorImpl = ReturnType<typeof createExecutor>;
