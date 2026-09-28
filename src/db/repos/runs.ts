// db/repos/runs.ts (WP1) — runs, run_waits, tool_calls, llm_calls, run_memory_uses.
// Encrypted columns use the run's epoch DEK: runs.visible_text_enc ('runs|visible_text_enc|<runId>'),
// tool_calls.input_enc / result_enc ('tool_calls|input_enc|<toolUseId>' …), llm_calls.raw_enc ('llm_calls|raw_enc|<id>').
import type { TaintSource } from '../../contracts/common.ts';
import type { Priority } from '../../contracts/llm.ts';
import type { LlmCallRecord, ReplyRef, RunRow, RunsRepo, SqlValue, ToolCallRow } from '../../contracts/storage.ts';
import { canonicalJson } from '../../kernel/canonicalJson.ts';
import { newId } from '../../kernel/ids.ts';
import { isShredded } from '../crypto.ts';
import { b2i, epochDek, has, i2b, num, numOrNull, parseJson, strOrNull, type RepoCtx } from './common.ts';

type Raw = Record<string, SqlValue>;
const TERMINAL: ReadonlySet<string> = new Set(['done', 'refused', 'failed', 'cancelled']);
const TC_STARTED: ReadonlySet<string> = new Set(['executing']);
const TC_FINISHED: ReadonlySet<string> = new Set(['done', 'error', 'denied', 'cancelled', 'unknown', 'executed_after_approval', 'declined_after_approval', 'expired']);

const aadVisible = (runId: string) => `runs|visible_text_enc|${runId}`;
const aadTcInput = (id: string) => `tool_calls|input_enc|${id}`;
const aadTcResult = (id: string) => `tool_calls|result_enc|${id}`;
const aadRaw = (id: string) => `llm_calls|raw_enc|${id}`;

export function createRunsRepo(x: RepoCtx): RunsRepo {
  const { db, crypto, clock } = x;

  const tryOpen = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch (e) {
      if (isShredded(e)) return fallback;
      throw e;
    }
  };

  const waitsOf = (runId: string) => db.prepare('SELECT token FROM run_waits WHERE run_id = ? ORDER BY token').all<{ token: string }>(runId).map((r) => r.token);
  const toRun = (r: Raw): RunRow => {
    const id = String(r['id']);
    const vt = r['visible_text_enc'];
    return {
      id,
      conversationId: String(r['conversation_id']),
      userId: strOrNull(r['user_id']),
      epoch: num(r['epoch']),
      trigger: r['trigger'] as RunRow['trigger'],
      triggerRef: strOrNull(r['trigger_ref']),
      state: r['state'] as RunRow['state'],
      priority: r['priority'] as Priority,
      phase: r['phase'] as RunRow['phase'],
      channel: r['channel'] as RunRow['channel'],
      replyRef: parseJson<ReplyRef>(r['reply_ref_json'], { chatId: 0 }),
      draftId: numOrNull(r['draft_id']),
      wakeOn: waitsOf(id),
      wakeAt: numOrNull(r['wake_at']),
      notBefore: numOrNull(r['not_before']),
      turns: num(r['turns']),
      continuations: num(r['continuations']),
      maxTokens: num(r['max_tokens']),
      retries: num(r['retries']),
      taint: parseJson<TaintSource[]>(r['taint_json'], []),
      costMicros: num(r['cost_micros']),
      error: strOrNull(r['error']),
      leaseUntil: numOrNull(r['lease_until']),
      createdAt: num(r['created_at']),
      visibleText: vt instanceof Uint8Array ? tryOpen(() => crypto.openText(vt, aadVisible(id)), null) : null,
      stopCategory: strOrNull(r['stop_category']),
    };
  };
  const get = (id: string) => {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get<Raw>(id);
    return r ? toRun(r) : undefined;
  };
  const needRunKey = (id: string) => {
    const r = db.prepare('SELECT conversation_id, epoch FROM runs WHERE id = ?').get<{ conversation_id: string; epoch: number }>(id);
    if (!r) throw new Error(`runs: no run ${id}`);
    return r;
  };

  const toToolCall = (r: Raw): ToolCallRow => {
    const id = String(r['tool_use_id']);
    const res = r['result_enc'];
    return {
      toolUseId: id,
      runId: String(r['run_id']),
      conversationId: String(r['conversation_id']),
      epoch: num(r['epoch']),
      userId: strOrNull(r['user_id']),
      assistantSeq: num(r['assistant_seq']),
      ordinal: num(r['ordinal']),
      name: String(r['name']),
      actionClass: strOrNull(r['action_class']),
      risk: numOrNull(r['risk']),
      input: tryOpen(() => crypto.openJson<unknown>(r['input_enc'] as Uint8Array, aadTcInput(id)), null),
      decision: (r['decision'] ?? null) as ToolCallRow['decision'],
      ruleId: strOrNull(r['rule_id']),
      status: r['status'] as ToolCallRow['status'],
      pendingActionId: strOrNull(r['pending_action_id']),
      result: res instanceof Uint8Array ? tryOpen(() => crypto.openJson<unknown>(res, aadTcResult(id)), null) : null,
      isError: i2b(r['is_error']),
    };
  };

  const repo: RunsRepo = {
    create(r) {
      const now = clock.now();
      const id = newId('run', now);
      db.prepare(
        `INSERT INTO runs(id, conversation_id, user_id, epoch, trigger, trigger_ref, state, priority, channel, reply_ref_json, not_before, max_tokens, taint_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, r.conversationId, r.userId, r.epoch, r.trigger, r.triggerRef, r.priority ?? 'interactive', r.channel, JSON.stringify(r.replyRef), r.notBefore ?? null, r.maxTokens,
        JSON.stringify([...new Set(r.taint ?? [])]), now,
      );
      return get(id)!;
    },
    get,
    claim(id, leaseMs) {
      const now = clock.now();
      const u = db
        .prepare(
          `UPDATE runs SET state = 'running', lease_until = ?, started_at = COALESCE(started_at, ?)
           WHERE id = ? AND (state = 'queued' OR (state = 'retry_wait' AND COALESCE(not_before, 0) <= ?) OR (state = 'running' AND COALESCE(lease_until, 0) < ?))`,
        )
        .run(now + leaseMs, now, id, now, now);
      return Number(u.changes) === 1 ? get(id) : undefined;
    },
    renewLease(id, leaseMs) {
      db.prepare('UPDATE runs SET lease_until = ? WHERE id = ?').run(clock.now() + leaseMs, id);
    },
    update(id, patch) {
      db.tx(() => {
        const key = needRunKey(id);
        const p: Array<[string, SqlValue]> = [];
        const epoch = has(patch, 'epoch') ? patch.epoch! : num(key.epoch);
        if (Object.prototype.hasOwnProperty.call(patch, 'userId')) p.push(['user_id', patch.userId ?? null]);
        if (has(patch, 'epoch')) p.push(['epoch', patch.epoch!]);
        if (has(patch, 'trigger')) p.push(['trigger', patch.trigger!]);
        if (Object.prototype.hasOwnProperty.call(patch, 'triggerRef')) p.push(['trigger_ref', patch.triggerRef ?? null]);
        if (has(patch, 'state')) {
          p.push(['state', patch.state!]);
          if (TERMINAL.has(patch.state!)) p.push(['finished_at', clock.now()]);
        }
        if (has(patch, 'priority')) p.push(['priority', patch.priority!]);
        if (has(patch, 'phase')) p.push(['phase', patch.phase!]);
        if (has(patch, 'channel')) p.push(['channel', patch.channel!]);
        if (has(patch, 'replyRef')) p.push(['reply_ref_json', JSON.stringify(patch.replyRef)]);
        if (Object.prototype.hasOwnProperty.call(patch, 'draftId')) p.push(['draft_id', patch.draftId ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'wakeAt')) p.push(['wake_at', patch.wakeAt ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'notBefore')) p.push(['not_before', patch.notBefore ?? null]);
        if (has(patch, 'turns')) p.push(['turns', patch.turns!]);
        if (has(patch, 'continuations')) p.push(['continuations', patch.continuations!]);
        if (has(patch, 'maxTokens')) p.push(['max_tokens', patch.maxTokens!]);
        if (has(patch, 'retries')) p.push(['retries', patch.retries!]);
        if (has(patch, 'taint')) p.push(['taint_json', JSON.stringify([...new Set(patch.taint)])]);
        if (has(patch, 'costMicros')) p.push(['cost_micros', Math.round(patch.costMicros!)]);
        if (Object.prototype.hasOwnProperty.call(patch, 'error')) p.push(['error', patch.error ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'leaseUntil')) p.push(['lease_until', patch.leaseUntil ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'stopCategory')) p.push(['stop_category', patch.stopCategory ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'visibleText')) {
          const vt = patch.visibleText;
          p.push(['visible_text_enc', vt == null ? null : crypto.seal(epochDek(key.conversation_id, epoch), vt, aadVisible(id))]);
        }
        if (p.length) db.prepare(`UPDATE runs SET ${p.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...p.map(([, v]) => v), id);
        if (has(patch, 'wakeOn')) {
          db.prepare('DELETE FROM run_waits WHERE run_id = ?').run(id);
          const ins = db.prepare('INSERT OR IGNORE INTO run_waits(run_id, token) VALUES (?, ?)');
          for (const t of patch.wakeOn!) ins.run(id, t);
        }
      });
    },
    park(id, wakeOn, wakeAt) {
      db.tx(() => {
        const u = db.prepare(`UPDATE runs SET state = 'parked', wake_at = ?, lease_until = NULL WHERE id = ?`).run(wakeAt, id);
        if (Number(u.changes) === 0) throw new Error(`runs.park: no run ${id}`);
        db.prepare('DELETE FROM run_waits WHERE run_id = ?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO run_waits(run_id, token) VALUES (?, ?)');
        for (const t of wakeOn) ins.run(id, t);
      });
    },
    byWaitToken(token) {
      return db
        .prepare(`SELECT r.* FROM runs r JOIN run_waits w ON w.run_id = r.id WHERE w.token = ? AND r.state = 'parked' ORDER BY r.created_at, r.id`)
        .all<Raw>(token)
        .map(toRun);
    },
    clearWaits(id) {
      db.prepare('DELETE FROM run_waits WHERE run_id = ?').run(id);
    },
    recoverable(now) {
      return db
        .prepare(
          `SELECT * FROM runs WHERE (state = 'running' AND COALESCE(lease_until, 0) < ?) OR state = 'queued' OR (state = 'retry_wait' AND COALESCE(not_before, 0) <= ?)
           ORDER BY created_at, id`,
        )
        .all<Raw>(now, now)
        .map(toRun);
    },
    byDraft(chatId, threadId, draftId) {
      return db
        .prepare(`SELECT * FROM runs WHERE draft_id = ? AND state IN ('queued', 'retry_wait') ORDER BY created_at, id`)
        .all<Raw>(draftId)
        .map(toRun)
        .filter((r) => r.replyRef.chatId === chatId && (r.replyRef.threadId ?? 0) === threadId);
    },
    stageToolCalls(rows) {
      if (!rows.length) return;
      db.tx(() => {
        const now = clock.now();
        const ins = db.prepare(
          `INSERT OR IGNORE INTO tool_calls(tool_use_id, run_id, conversation_id, epoch, user_id, assistant_seq, ordinal, name, input_enc, input_hmac, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)`,
        );
        for (const r of rows) {
          ins.run(
            r.toolUseId, r.runId, r.conversationId, r.epoch, r.userId, r.assistantSeq, r.ordinal, r.name,
            crypto.sealJson(epochDek(r.conversationId, r.epoch), r.input ?? null, aadTcInput(r.toolUseId)), crypto.hmac('input', canonicalJson(r.input ?? null)), now,
          );
        }
      });
    },
    updateToolCall(toolUseId, patch) {
      db.tx(() => {
        const cur = db.prepare('SELECT conversation_id, epoch FROM tool_calls WHERE tool_use_id = ?').get<{ conversation_id: string; epoch: number }>(toolUseId);
        if (!cur) throw new Error(`runs.updateToolCall: no tool call ${toolUseId}`);
        const conv = has(patch, 'conversationId') ? patch.conversationId! : cur.conversation_id;
        const epoch = has(patch, 'epoch') ? patch.epoch! : num(cur.epoch);
        const dek = epochDek(conv, epoch);
        const p: Array<[string, SqlValue]> = [];
        if (has(patch, 'runId')) p.push(['run_id', patch.runId!]);
        if (has(patch, 'conversationId')) p.push(['conversation_id', patch.conversationId!]);
        if (has(patch, 'epoch')) p.push(['epoch', patch.epoch!]);
        if (Object.prototype.hasOwnProperty.call(patch, 'userId')) p.push(['user_id', patch.userId ?? null]);
        if (has(patch, 'assistantSeq')) p.push(['assistant_seq', patch.assistantSeq!]);
        if (has(patch, 'ordinal')) p.push(['ordinal', patch.ordinal!]);
        if (has(patch, 'name')) p.push(['name', patch.name!]);
        if (Object.prototype.hasOwnProperty.call(patch, 'actionClass')) p.push(['action_class', patch.actionClass ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'risk')) p.push(['risk', patch.risk ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'input')) {
          p.push(['input_enc', crypto.sealJson(dek, patch.input ?? null, aadTcInput(toolUseId))]);
          p.push(['input_hmac', crypto.hmac('input', canonicalJson(patch.input ?? null))]);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'decision')) p.push(['decision', patch.decision ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'ruleId')) p.push(['rule_id', patch.ruleId ?? null]);
        if (has(patch, 'status')) {
          p.push(['status', patch.status!]);
          if (TC_STARTED.has(patch.status!)) p.push(['started_at', clock.now()]);
          if (TC_FINISHED.has(patch.status!)) p.push(['finished_at', clock.now()]);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'pendingActionId')) p.push(['pending_action_id', patch.pendingActionId ?? null]);
        if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
          p.push(['result_enc', patch.result === undefined || patch.result === null ? null : crypto.sealJson(dek, patch.result, aadTcResult(toolUseId))]);
        }
        if (has(patch, 'isError')) p.push(['is_error', b2i(patch.isError)]);
        if (p.length) db.prepare(`UPDATE tool_calls SET ${p.map(([c]) => `${c} = ?`).join(', ')} WHERE tool_use_id = ?`).run(...p.map(([, v]) => v), toolUseId);
      });
    },
    toolCallsFor(runId, assistantSeq) {
      const rows = assistantSeq === undefined
        ? db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY assistant_seq, ordinal').all<Raw>(runId)
        : db.prepare('SELECT * FROM tool_calls WHERE run_id = ? AND assistant_seq = ? ORDER BY ordinal').all<Raw>(runId, assistantSeq);
      return rows.map(toToolCall);
    },
    recordLlmCall(c: LlmCallRecord) {
      const now = clock.now();
      const id = newId('llm', now);
      let raw: Uint8Array | null = null;
      if (c.raw !== null && c.raw !== undefined) {
        const dek = c.conversationId && c.epoch !== null ? epochDek(c.conversationId, c.epoch) : c.userId ? `u:${c.userId}` : 'sys';
        try {
          if (!crypto.isDestroyed(dek)) raw = crypto.sealJson(dek, c.raw, aadRaw(id));
        } catch {
          raw = null; // e.g. the epoch DEK does not exist: diagnostics are optional, the record is not
        }
      }
      const u = c.usage;
      db.prepare(
        `INSERT INTO llm_calls(id, run_id, conversation_id, epoch, user_id, purpose, request_hmac, model_requested, model_served, served_by_fallback, stop_reason, refusal_category,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, web_search_requests, web_fetch_requests, iterations_json, cost_micros,
           latency_ms, ttft_ms, request_id, error_class, raw_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, c.runId, c.conversationId, c.epoch, c.userId, c.purpose, c.requestHmac, c.modelRequested, c.modelServed, b2i(c.servedByFallback), c.stopReason, c.refusalCategory,
        u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWrite5m, u.cacheWrite1h, u.webSearchRequests, u.webFetchRequests,
        c.iterations === null || c.iterations === undefined ? null : JSON.stringify(c.iterations), Math.round(c.costMicros), c.latencyMs, c.ttftMs, c.requestId, c.errorClass, raw, now,
      );
    },
    recordMemoryUses(runId, factIds) {
      if (!factIds.length) return;
      db.tx(() => {
        const ins = db.prepare('INSERT OR IGNORE INTO run_memory_uses(run_id, fact_id, rank) VALUES (?, ?, ?)');
        factIds.forEach((f, i) => ins.run(runId, f, i + 1));
      });
    },
    memoryUses(runId) {
      return db.prepare('SELECT fact_id, rank FROM run_memory_uses WHERE run_id = ? ORDER BY rank').all<{ fact_id: string; rank: number }>(runId).map((r) => ({ factId: r.fact_id, rank: num(r.rank) }));
    },
    llmCallsFor(runId) {
      return db
        .prepare('SELECT purpose, model_requested, model_served, served_by_fallback, stop_reason, refusal_category, created_at FROM llm_calls WHERE run_id = ? ORDER BY created_at, id')
        .all<Raw>(runId)
        .map((r) => ({
          purpose: r['purpose'] as LlmCallRecord['purpose'],
          modelRequested: String(r['model_requested']),
          modelServed: strOrNull(r['model_served']),
          servedByFallback: i2b(r['served_by_fallback']),
          stopReason: strOrNull(r['stop_reason']),
          refusalCategory: strOrNull(r['refusal_category']),
          createdAt: num(r['created_at']),
        }));
    },
    conversationsUsingFact(factId) {
      return db
        .prepare('SELECT r.id AS run_id, r.conversation_id, r.epoch FROM run_memory_uses m JOIN runs r ON r.id = m.run_id WHERE m.fact_id = ? ORDER BY r.created_at, r.id')
        .all<{ run_id: string; conversation_id: string; epoch: number }>(factId)
        .map((r) => ({ runId: r.run_id, conversationId: r.conversation_id, epoch: num(r.epoch) }));
    },
  };
  return repo;
}
