// agent/usage.ts (WP3) — 01 §5.4 recordUsage: llm_calls row (raw response sealed by the repo), per-user usage_daily +
// cost cap (quotas.recordUsage), run cost, mission budget, epoch inputTokensLast / lastRequestAt. Also side calls
// (03 R6 "every Groq call records usage"). Never throws: accounting failures are logged, not fatal to the run.
import type { ConversationRow, LlmCallPurpose, MainRequest, RunRow, Services, StreamResult, UsageNumbers, UserId } from '../contracts/index.ts';
import { servedByFallback } from './fallbackEcho.ts';
import { bareModel, costFromBeta, costMicros, usageFromBeta } from './pricing.ts';

export function requestHmac(s: Pick<Services, 'crypto'>, req: unknown): string {
  try {
    return s.crypto.hmac('content', JSON.stringify(req));
  } catch {
    return '';
  }
}

/** Tokens the epoch's last request carried (drives idle / size rotation). */
export function promptTokensOf(u: UsageNumbers): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWrite5m + u.cacheWrite1h;
}

export interface MainCallRecord {
  run: RunRow;
  conv: ConversationRow;
  epoch: number;
  req: MainRequest;
  r: StreamResult;
  purpose: LlmCallPurpose;
}

/** A completed main-loop (or handoff) call. Returns the cost in micros. */
export function recordMainCall(s: Services, c: MainCallRecord): number {
  const msg = c.r.message;
  const usage = usageFromBeta(msg.usage);
  const served = msg.model ?? c.req.model;
  const overrides = s.config.anthropic.pricingOverrides;
  const cost = s.config.profile.provider === 'groq' || served.startsWith('groq:') ? costMicros(served, usage, overrides) : costFromBeta(served, msg.usage, overrides);
  const refusalCategory = msg.stop_reason === 'refusal' ? (((msg.stop_details ?? null) as { category?: string | null } | null)?.category ?? null) : null;
  const now = s.clock.now();
  try {
    s.repos.runs.recordLlmCall({
      runId: c.run.id || null, conversationId: c.conv.id, epoch: c.epoch, userId: c.run.userId, purpose: c.purpose,
      requestHmac: requestHmac(s, c.req), modelRequested: c.req.model, modelServed: served, servedByFallback: servedByFallback(msg),
      stopReason: msg.stop_reason ?? null, refusalCategory, usage, iterations: (msg.usage as { iterations?: unknown } | null)?.iterations ?? null,
      costMicros: cost, latencyMs: c.r.latencyMs, ttftMs: c.r.ttftMs, requestId: c.r.requestId, errorClass: null, raw: msg,
    });
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.message : String(e), runId: c.run.id }, 'recordLlmCall failed');
  }
  accountCost(s, c.run.userId, usage, cost);
  // F4: Anthropic server tools (web_search / web_fetch) never pass the executor; they spend the 'web_search' quota here.
  const webUses = usage.webSearchRequests + usage.webFetchRequests;
  if (c.run.userId && webUses > 0) {
    try {
      s.quotas.consume(c.run.userId, 'web_search', webUses);
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'quotas.consume(web_search) failed');
    }
  }
  try {
    if (c.run.id) {
      const cur = s.repos.runs.get(c.run.id);
      s.repos.runs.update(c.run.id, { costMicros: (cur?.costMicros ?? c.run.costMicros) + cost });
    }
    if (c.purpose === 'main') s.repos.conversations.updateEpoch(c.conv.id, c.epoch, { inputTokensLast: promptTokensOf(usage), lastRequestAt: now });
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.message : String(e), runId: c.run.id }, 'run/epoch usage update failed');
  }
  if (c.conv.route === 'mission' && c.run.replyRef.missionId) {
    try {
      s.missions.chargeCost(c.run.replyRef.missionId, cost);
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'mission chargeCost failed');
    }
  }
  return cost;
}

/** A failed main call (error class only; nothing else is known). */
export function recordFailedCall(s: Services, c: { run: RunRow; conv: ConversationRow; epoch: number; req: MainRequest; purpose: LlmCallPurpose; errorClass: string; requestId: string | null }): void {
  try {
    s.repos.runs.recordLlmCall({
      runId: c.run.id, conversationId: c.conv.id, epoch: c.epoch, userId: c.run.userId, purpose: c.purpose, requestHmac: requestHmac(s, c.req),
      modelRequested: c.req.model, modelServed: null, servedByFallback: false, stopReason: null, refusalCategory: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearchRequests: 0, webFetchRequests: 0 },
      iterations: null, costMicros: 0, latencyMs: null, ttftMs: null, requestId: c.requestId, errorClass: c.errorClass, raw: null,
    });
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'recordLlmCall (failure) failed');
  }
}

/** Side / parse calls. */
export function recordSideCall(s: Services, c: { purpose: LlmCallPurpose; model: string; usage: UsageNumbers; requestId: string | null; stopReason: string | null; userId?: UserId | null; conversationId?: string | null; runId?: string | null; hmacOf: unknown }): number {
  const cost = costMicros(bareModel(c.model), c.usage, s.config.anthropic.pricingOverrides);
  try {
    s.repos.runs.recordLlmCall({
      runId: c.runId ?? null, conversationId: c.conversationId ?? null, epoch: null, userId: c.userId ?? null, purpose: c.purpose,
      requestHmac: requestHmac(s, c.hmacOf), modelRequested: c.model, modelServed: c.model, servedByFallback: false, stopReason: c.stopReason,
      refusalCategory: null, usage: c.usage, iterations: null, costMicros: cost, latencyMs: null, ttftMs: null, requestId: c.requestId, errorClass: null, raw: null,
    });
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'recordLlmCall (side) failed');
  }
  accountCost(s, c.userId ?? null, c.usage, cost);
  return cost;
}

function accountCost(s: Services, userId: UserId | null, u: UsageNumbers, cost: number): void {
  if (!userId) return;
  try {
    s.quotas.recordUsage(userId, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, costMicros: cost });
  } catch (e) {
    s.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'quotas.recordUsage failed');
  }
}
