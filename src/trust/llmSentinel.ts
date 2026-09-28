// trust/llmSentinel.ts (WP4) — 03 R5 LLM Sentinel (defense in depth; it can only make decisions stricter).
// Consulted ONLY when the rules Sentinel allowed an action of class write_self | send_external | spend | destructive |
// account_admin AND the run is tainted or is an event run. violation → ask with '⚠ Safety check: <rationale>';
// error / timeout (3 s) / invalid → ask. Never turns ask or deny into allow. Disabled without a Groq key.
import type { ActionClass, Clock, Decision, LlmSentinelCapability, Logger, Priority, TaintSource, UserId } from '../contracts/index.ts';
import { canonicalJson } from '../kernel/canonicalJson.ts';

export const LLM_SENTINEL_CLASSES: ReadonlySet<ActionClass> = new Set(['write_self', 'send_external', 'spend', 'destructive', 'account_admin']);
export const LLM_SENTINEL_TIMEOUT_MS = 3_000;
export const LLM_SENTINEL_INPUT_CHARS = 2_000;
export const LLM_SENTINEL_OWNER_CHARS = 500;
export const LLM_SENTINEL_RATIONALE_CHARS = 120;

export interface LlmSentinelDeps { cap: LlmSentinelCapability | undefined; enabled: boolean; clock: Clock; log: Logger; safetyLine: (rationale: string) => string }
export interface LlmSentinelInput {
  decision: Decision; actionClass: ActionClass; tainted: boolean; eventRun: boolean;
  tool: string; input: unknown; ownerText: string; taint: readonly TaintSource[];
  priority?: Priority; userId?: UserId | null; runId?: string | null; conversationId?: string | null;
}

export function shouldConsult(i: Pick<LlmSentinelInput, 'decision' | 'actionClass' | 'tainted' | 'eventRun'>): boolean {
  return i.decision.kind === 'allow' && LLM_SENTINEL_CLASSES.has(i.actionClass) && (i.tainted || i.eventRun);
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

/** Returns the (possibly stricter) decision. Never returns allow unless `i.decision` was allow. */
export async function consultLlmSentinel(d: LlmSentinelDeps, i: LlmSentinelInput): Promise<Decision> {
  if (!d.enabled || !d.cap || !shouldConsult(i)) return i.decision;
  const askFor = (reason: string, warning: string): Decision => ({ kind: 'ask', ruleId: 'L01', reason, grantable: false, warnings: [warning] });
  let input: string;
  try {
    input = clip(canonicalJson(i.input ?? null), LLM_SENTINEL_INPUT_CHARS);
  } catch {
    input = '';
  }
  let timer: unknown;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = d.clock.setTimeout(() => resolve('timeout'), LLM_SENTINEL_TIMEOUT_MS);
  });
  let r: Awaited<ReturnType<LlmSentinelCapability['check']>> | 'timeout';
  try {
    r = await Promise.race([
      d.cap.check({
        tool: i.tool,
        input,
        ownerText: clip(i.ownerText ?? '', LLM_SENTINEL_OWNER_CHARS),
        taint: [...i.taint],
        ...(i.priority ? { priority: i.priority } : {}),
        meta: { userId: i.userId ?? undefined, runId: i.runId ?? undefined, conversationId: i.conversationId ?? undefined },
      }),
      timeout,
    ]);
  } catch (e) {
    d.log.warn({ err: e instanceof Error ? e.name : 'error', tool: i.tool }, 'llm sentinel: check failed; asking');
    r = null;
  } finally {
    d.clock.clearTimeout(timer);
  }
  if (r === 'timeout') return askFor('Safety check timed out', d.safetyLine('unavailable'));
  if (!r || typeof r.violation !== 'boolean') return askFor('Safety check unavailable', d.safetyLine('unavailable'));
  if (r.violation) {
    const rationale = clip(String(r.rationale ?? '').replace(/\s+/g, ' ').trim(), LLM_SENTINEL_RATIONALE_CHARS) || 'possible injected instruction';
    return askFor('Safety check flagged the action', d.safetyLine(rationale));
  }
  return i.decision;
}
