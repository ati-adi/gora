// trust/approvals.ts (WP4) — 01 §5.6 approval lifecycle: create (card via the outbox), resolve (CAS, 24 h grant,
// executeApproved, card edit, wake/notify), revise, expire, void, list/get views, and the typed-"yes" re-show.
import type {
  ApprovalDiff, ApprovalService, Classification, Decision, Ms, PendingActionView, Services, Target, ToolCtx, UserId, WakePayload,
} from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import { approvalCard, outcomeMarkdown, ownerLang, type Outcome } from './approvalCards.ts';
import type { GrantsImpl } from './grants.ts';
import type { PaRepo, PaRow, PaStatus } from './repo.ts';

export interface CreateInternal {
  userId: UserId; runId: string | null; conversationId: string | null; toolUseId: string; version: number; supersedesId: string | null;
  toolName: string; input: unknown; cls: Classification; diff: ApprovalDiff; decision: Extract<Decision, { kind: 'ask' }>;
  expiresAt: Ms; card: { chatId: number; threadId?: number }; sourceRefs: string[]; extraWarnings?: string[];
}

export interface ExecutorHooks {
  executeApproved(id: string): Promise<{ status: 'executed' | 'superseded' | 'denied_by_policy' | 'failed' | 'unknown'; summary: string }>;
  revise(id: string, newInput: unknown, ctx: ToolCtx | null, opts?: { ownerText?: string; extraWarnings?: string[] }): Promise<{ newId: string } | { error: string }>;
  /** TOCTOU check of a pending card without executing it: true when the remote object no longer matches the card. */
  isStale(id: string): Promise<boolean>;
  /** Finishes approvals stuck in 'approved' / 'executing' after a crash or restart. */
  recoverStuck(now: Ms): Promise<number>;
}

/** Owner-typed values of a Mini App edit (strings only), used as owner text for recipient provenance. */
function editedText(edits: unknown): string {
  if (!edits || typeof edits !== 'object') return '';
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const v of Object.values(edits as Record<string, unknown>)) walk(v);
  return out.join('\n');
}

/**
 * Fields the Mini App may edit per tool, mapped to their path in the tool input (01 §12 "edit fields"). The Mini App
 * sends only the edited fields; resolve() merges them into the stored input before revising (integration fix: WP8
 * request). gmail_send_draft takes only a draft id, so it has no editable fields.
 */
const EDIT_PATHS: Record<string, Record<string, readonly string[]>> = {
  gmail_create_draft: { to: ['to'], cc: ['cc'], subject: ['subject'], body: ['body'] },
  calendar_create_event: { title: ['title'], start: ['start_local'], end: ['end_local'] },
  calendar_update_event: { title: ['patch', 'title'], start: ['patch', 'start_local'], end: ['patch', 'end_local'] },
  business_draft_reply: { text: ['text'] },
};
const EDITABLE: Record<string, string[]> = Object.fromEntries(Object.entries(EDIT_PATHS).map(([k, v]) => [k, Object.keys(v)]));

/** Merges the edited fields (only those declared editable) into a deep copy of the stored input. */
export function applyEdits(toolName: string, original: unknown, edits: unknown): unknown {
  const paths = EDIT_PATHS[toolName] ?? {};
  const out = structuredClone((original && typeof original === 'object' ? original : {}) as Record<string, unknown>);
  if (!edits || typeof edits !== 'object') return out;
  for (const [field, value] of Object.entries(edits as Record<string, unknown>)) {
    const path = paths[field];
    if (!path) continue;
    let node: Record<string, unknown> = out;
    for (const seg of path.slice(0, -1)) {
      const next = node[seg];
      if (!next || typeof next !== 'object') node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    node[path[path.length - 1]!] = value;
  }
  return out;
}

export function createApprovals(s: Services, pa: PaRepo, grants: GrantsImpl, exec: () => ExecutorHooks) {
  const str = (key: 'already_handled' | 'tap_the_card' | 'draft_changed', lang: string | null): string => {
    try {
      return s.strings.t(key, uiLang(lang));
    } catch {
      return key;
    }
  };
  const tzOf = (userId: string): string => {
    try {
      return s.repos.users.getById(userId)?.tz ?? 'UTC';
    } catch {
      return 'UTC';
    }
  };

  const sendCard = async (row: PaRow): Promise<number | null> => {
    const user = s.repos.users.getById(row.user_id);
    if (!user || row.card_chat_id === null) return null;
    const targets = safeTargets(row);
    const diff = pa.diff(row);
    const { markdown, replyMarkup } = approvalCard(s, {
      id: row.id, title: diff.title, rows: diff.rows, ...(diff.body ? { body: diff.body } : {}), warnings: JSON.parse(row.warnings_json) as string[],
      expiresAt: row.expires_at, chatId: row.card_chat_id, grantable: row.grantable === 1, ladderOffer: row.ladder_offer === 1,
      ownerTgId: user.tgUserId, lang: user.languageCode, ...(targets[0] ? { firstTargetDisplay: targets[0].value } : {}),
    });
    const refs = await s.telegram.outbox.sendNow({
      idempotencyKey: `pa:card:${row.id}:${s.clock.now()}`,
      userId: row.user_id,
      chatId: row.card_chat_id,
      ...(row.card_thread_id !== null ? { threadId: row.card_thread_id } : {}),
      method: 'sendRichMessage',
      payload: { reply_markup: replyMarkup },
      markdown,
      priority: 1,
      refKind: 'pending_action',
      refId: row.id,
    });
    const first = refs[0];
    if (!first) return null;
    pa.setCardMessage(row.id, first.messageId);
    try {
      for (const [i, r] of refs.entries()) {
        s.telegram.links.record({ chatId: r.chatId, messageId: r.messageId, kind: 'card', userId: row.user_id, conversationId: row.conversation_id, runId: row.run_id, pendingActionId: row.id, part: i });
      }
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: tg link record failed');
    }
    return first.messageId;
  };

  const safeTargets = (row: PaRow): Target[] => {
    try {
      return pa.targets(row);
    } catch {
      return [];
    }
  };

  /** Edits the card into its outcome (no buttons). Best effort: the DB state is authoritative. */
  const editCard = async (row: PaRow, outcome: Outcome, o: { summary?: string; ledgerSeq?: number; note?: string } = {}): Promise<void> => {
    if (row.card_chat_id === null || row.card_message_id === null) return;
    let title = row.tool_name;
    try {
      title = pa.diff(row).title;
    } catch {
      /* DEK gone */
    }
    const markdown = outcomeMarkdown(s, { outcome, title, ...(o.summary ? { summary: o.summary } : {}), at: s.clock.now(), tz: tzOf(row.user_id), ...(o.ledgerSeq ? { ledgerSeq: o.ledgerSeq } : {}), lang: ownerLang(s, row.user_id), ...(o.note ? { note: o.note } : {}) });
    try {
      s.telegram.outbox.enqueue({
        idempotencyKey: `pa:edit:${row.id}:${outcome}`,
        userId: row.user_id,
        chatId: row.card_chat_id,
        method: 'editMessageText',
        payload: { message_id: row.card_message_id, rich_message: { markdown, skip_entity_detection: true }, reply_markup: { inline_keyboard: [] } },
        markdown,
        priority: 1,
      });
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: card edit failed');
    }
  };

  /** Hands the outcome back to the model: wake a parked run waiting on approval:<id>, else a conv_events row. */
  const notify = async (row: PaRow, decision: Extract<WakePayload, { reason: 'approval' }>['decision'], executed: boolean, summary: string): Promise<void> => {
    const token = `approval:${row.id}`;
    let waiting = 0;
    try {
      waiting = s.repos.runs.byWaitToken(token).length;
    } catch {
      waiting = 0;
    }
    if (waiting > 0) {
      try {
        await s.runner.wake(token, { reason: 'approval', approvalId: row.id, decision, executed, summary });
        return;
      } catch (e) {
        s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: wake failed; writing an event');
      }
    }
    if (!row.conversation_id) return;
    const hhmm = (() => {
      try {
        return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tzOf(row.user_id) }).format(new Date(s.clock.now()));
      } catch {
        return '';
      }
    })();
    // conv_events carry operator authority: code-owned text only (tool name, outcome), never the diff summary or a
    // tool's output (third-party text). The parked-run wake above still gets the summary as a tool result.
    const verb = decision === 'approved' ? (executed ? 'approved and done' : 'approved but not completed') : decision === 'denied' ? 'denied by the owner' : decision === 'expired' ? 'expired without a decision' : 'superseded';
    try {
      s.repos.inputs.addEvent(row.conversation_id, `${row.id} (${row.tool_name}) ${verb}${hhmm ? ` ${hhmm}` : ''}`);
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: addEvent failed');
    }
  };

  const toolCallStatus = (row: PaRow, status: 'executed_after_approval' | 'declined_after_approval' | 'expired'): void => {
    const base = row.tool_use_id.split('~')[0]!;
    try {
      s.repos.runs.updateToolCall(base, { status });
    } catch {
      /* no tool_calls row (e.g. created outside a round) */
    }
  };

  const ledger = (row: PaRow, summary: string, detail: Record<string, unknown>, actor: 'user' | 'system' = 'user'): number | undefined => {
    try {
      return s.ledger.append({ userId: row.user_id, actor, kind: 'approval_resolved', summary, detail, pendingActionId: row.id, ...(row.run_id ? { runId: row.run_id } : {}) });
    } catch {
      return undefined;
    }
  };

  const view = (row: PaRow): PendingActionView | undefined => {
    let diff: ApprovalDiff;
    try {
      diff = pa.diff(row);
    } catch {
      return undefined;
    }
    const targets = safeTargets(row);
    return {
      id: row.id, toolName: row.tool_name, title: diff.title, summary: diff.summary, rows: diff.rows, ...(diff.body ? { body: diff.body } : {}),
      warnings: JSON.parse(row.warnings_json) as string[], status: row.status, expiresAt: row.expires_at, grantable: row.grantable === 1,
      ladderOffer: row.ladder_offer === 1, editableFields: EDITABLE[row.tool_name] ?? [], runId: row.run_id, conversationId: row.conversation_id,
      targets: targets.map((t) => ({ kind: t.kind, display: t.value, provenance: t.provenance })),
      ...(row.card_chat_id !== null ? { card: { chatId: row.card_chat_id, threadId: row.card_thread_id, messageId: row.card_message_id } } : {}),
    };
  };

  const createInternal = async (p: CreateInternal): Promise<{ id: string }> => {
    const id = pa.newId();
    const warnings = [...new Set([...(p.extraWarnings ?? []), ...p.decision.warnings, ...p.diff.warnings])];
    const grantable = p.decision.grantable && p.cls.grantable !== false;
    const ladderOffer = grantable && grants.ladderMet(p.userId, p.toolName, p.diff.targets);
    pa.insert({
      id, userId: p.userId, conversationId: p.conversationId, runId: p.runId, toolUseId: p.toolUseId, version: p.version, supersedesId: p.supersedesId,
      toolName: p.toolName, actionClass: p.cls.actionClass, risk: p.cls.risk, targets: p.diff.targets, input: p.input, diff: p.diff, warnings,
      grantable, ladderOffer, sourceRefs: p.sourceRefs, expiresAt: p.expiresAt, card: p.card,
    });
    try {
      s.ledger.append({ userId: p.userId, actor: 'sentinel', kind: 'approval_requested', summary: `Approval requested: ${p.toolName}`, detail: { rule: p.decision.ruleId, tool: p.toolName, risk: p.cls.risk }, pendingActionId: id, toolUseId: p.toolUseId, ...(p.runId ? { runId: p.runId } : {}) });
    } catch {
      /* ledger best effort */
    }
    try {
      s.scheduler.schedule({ kind: 'approval_expire', runAt: p.expiresAt, userId: p.userId, refId: id, dedupeKey: `approval_expire:${id}`, maxAttempts: 5 });
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: expiry job schedule failed (the sweeper covers it)');
    }
    const row = pa.get(id)!;
    try {
      await sendCard(row);
    } catch (e) {
      // The row is durable; the owner can still get the card via reshowPending / the Mini App.
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: card send failed');
    }
    return { id };
  };

  const service: ApprovalService = {
    async create(p) {
      if (!p.run.userId) throw new Error('approvals need an owner');
      return createInternal({
        userId: p.run.userId, runId: p.run.id, conversationId: p.conv.id, toolUseId: p.toolUseId, version: 1, supersedesId: null, toolName: p.spec.name,
        input: p.input, cls: p.cls, diff: p.diff, decision: p.decision, expiresAt: p.expiresAt, card: p.card, sourceRefs: p.sourceRefs ?? [],
      });
    },

    async resolve(id, d) {
      let row = pa.get(id);
      const lang = row ? ownerLang(s, row.user_id) : null;
      if (!row) return { status: 'not_found', message: str('already_handled', lang) };
      const owner = s.repos.users.getById(row.user_id);
      if (!owner || owner.tgUserId !== d.byTgId) return { status: 'forbidden', message: 'Not yours.' };
      if (d.editedInput !== undefined && d.decision === 'approve') {
        // Mini App edits: the same revision path, followed by the approval of the new version — but only when the owner
        // saw everything that v2 will do (01 §5.6 step 3.2). If the remote object changed since the card (v1 is stale),
        // or v2 carries a warning v1 did not, v2 is left pending for review instead of being approved unseen.
        if (row.status !== 'pending' || row.expires_at <= s.clock.now()) return { status: 'already_handled', message: str('already_handled', lang) };
        const stale = await exec().isStale(id);
        const r = await exec().revise(id, applyEdits(row.tool_name, pa.input(row), d.editedInput), null, {
          ownerText: editedText(d.editedInput),
          ...(stale ? { extraWarnings: [`⚠ ${str('draft_changed', lang)}`] } : {}),
        });
        if ('error' in r) return { status: 'invalid', message: r.error };
        const v2 = pa.get(r.newId);
        const before = new Set(JSON.parse(row.warnings_json) as string[]);
        const added = v2 ? (JSON.parse(v2.warnings_json) as string[]).filter((w) => !before.has(w)) : [];
        if (stale || added.length > 0) return { status: 'superseded', message: `${str('draft_changed', lang)} (${r.newId})` };
        return service.resolve(r.newId, { decision: d.decision, scope: d.scope, byTgId: d.byTgId, via: d.via });
      }
      if (d.decision === 'deny') {
        if (!pa.cas(id, 'pending', 'denied', { decidedBy: d.byTgId, via: d.via, requireUnexpired: true })) return { status: 'already_handled', message: str('already_handled', lang) };
        row = pa.get(id)!;
        ledger(row, `Denied ${row.tool_name}`, { decision: 'deny', via: d.via });
        toolCallStatus(row, 'declined_after_approval');
        await editCard(row, 'denied');
        await notify(row, 'denied', false, 'denied');
        return { status: 'denied', message: s.strings ? safeT(s, 'approval_not_sent', lang) : 'Not sent' };
      }
      const scope = d.scope === '24h' && row.grantable === 1 && row.ladder_offer === 1 ? '24h' : 'once';
      if (!pa.cas(id, 'pending', 'approved', { scope, decidedBy: d.byTgId, via: d.via, requireUnexpired: true })) return { status: 'already_handled', message: str('already_handled', lang) };
      row = pa.get(id)!;
      if (scope === '24h') {
        // A grant never applies retroactively to a tainted run: S14 ignores every grant there.
        try {
          grants.create24h(row.user_id, row.tool_name, safeTargets(row), row.id);
        } catch (e) {
          s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: grant creation failed');
        }
      }
      ledger(row, `Approved ${row.tool_name}`, { decision: 'approve', scope, via: d.via });
      const r = await exec().executeApproved(id);
      return { status: r.status, message: r.summary };
    },

    async revise(id, newInput, ctx) {
      return exec().revise(id, newInput, ctx);
    },

    async expireDue(now) {
      let n = 0;
      for (const row of pa.dueForExpiry(now)) {
        if (!pa.cas(row.id, 'pending', 'expired', { via: 'system', decidedBy: 0 })) continue;
        n++;
        const r = pa.get(row.id)!;
        ledger(r, `Expired ${r.tool_name}`, { decision: 'expired' }, 'system');
        toolCallStatus(r, 'expired');
        await editCard(r, 'expired');
        await notify(r, 'expired', false, 'expired');
      }
      // The same sweep (boot + cron) also finishes approvals stuck mid-execution by a crash or restart (after the
      // expiries, so a pending row is expired first and never races other jobs of the same tick).
      try {
        n += await exec().recoverStuck(now);
      } catch (e) {
        s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: stuck recovery failed');
      }
      return n;
    },

    async voidBySourceRef(ref, reason) {
      let n = 0;
      for (const row of pa.pendingWithSourceRefs()) {
        let refs: string[] = [];
        try {
          refs = JSON.parse(row.source_refs_json) as string[];
        } catch {
          refs = [];
        }
        if (!refs.includes(ref)) continue;
        if (!pa.cas(row.id, 'pending', 'voided', { via: 'system', decidedBy: 0 })) continue;
        n++;
        const r = pa.get(row.id)!;
        ledger(r, `Voided ${r.tool_name}`, { decision: 'voided', reason: reason.slice(0, 80) }, 'system');
        toolCallStatus(r, 'declined_after_approval');
        await editCard(r, 'voided', { note: reason });
        await notify(r, 'denied', false, `voided: ${reason}`);
      }
      return n;
    },

    listPending(userId) {
      const now = s.clock.now();
      return pa
        .listByUser(userId, ['pending'])
        .filter((r) => r.expires_at > now)
        .map(view)
        .filter((v): v is PendingActionView => !!v);
    },

    get(id, userId) {
      const row = pa.get(id);
      if (!row || row.user_id !== userId) return undefined;
      return view(row);
    },

    async reshowPending(userId, chat) {
      const now = s.clock.now();
      const rows = pa.listByUser(userId, ['pending'], 3).filter((r) => r.expires_at > now);
      if (rows.length === 0) return 0;
      const lang = ownerLang(s, userId);
      try {
        await s.telegram.outbox.sendNow({ idempotencyKey: `pa:tap:${userId}:${now}`, userId, chatId: chat.chatId, ...(chat.threadId ? { threadId: chat.threadId } : {}), method: 'sendMessage', payload: { text: str('tap_the_card', lang) } });
      } catch (e) {
        s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: tap_the_card send failed');
      }
      let n = 0;
      for (const r of rows) {
        const moved = { ...r, card_chat_id: chat.chatId, card_thread_id: chat.threadId ?? null };
        s.db.prepare('UPDATE pending_actions SET card_chat_id = ?, card_thread_id = ? WHERE id = ?').run(chat.chatId, chat.threadId ?? null, r.id);
        try {
          if ((await sendCard(moved)) !== null) n++;
        } catch (e) {
          s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'approvals: re-show failed');
        }
      }
      return n;
    },
  };

  return { service, createInternal, editCard, notify, toolCallStatus, ledger, view, sendCard, str };
}
export type ApprovalsImpl = ReturnType<typeof createApprovals>;
export type { PaStatus };

function safeT(s: Services, key: 'approval_not_sent', lang: string | null): string {
  try {
    return s.strings.t(key, uiLang(lang));
  } catch {
    return 'Not sent';
  }
}
