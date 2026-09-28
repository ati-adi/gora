// trust/taint.ts (WP4) — 01 §11.2 taint. A run's taint = the epoch's taint ∪ what the run has ingested.
import type { ConversationRow, RunRow, Services, TaintSource } from '../contracts/index.ts';

export const TAINT_SOURCES: readonly TaintSource[] = ['web', 'email', 'calendar', 'business_peer', 'forward', 'group_member', 'guest', 'file', 'import', 'derived'];

export function isTaintSource(v: unknown): v is TaintSource {
  return typeof v === 'string' && (TAINT_SOURCES as readonly string[]).includes(v);
}

/** Union of the epoch taint and the run's own taint (plus `extra`), deduplicated, in canonical order. */
export function runTaint(s: Services, run: RunRow | null, conv?: ConversationRow | null, extra: Iterable<TaintSource> = []): Set<TaintSource> {
  const set = new Set<TaintSource>();
  for (const t of run?.taint ?? []) if (isTaintSource(t)) set.add(t);
  const convId = run?.conversationId ?? conv?.id;
  if (convId) {
    try {
      const ep = run ? s.repos.conversations.getEpoch(convId, run.epoch) : s.repos.conversations.currentEpoch(convId);
      for (const t of ep?.taint ?? []) if (isTaintSource(t)) set.add(t);
    } catch {
      /* conversation missing: the run taint alone */
    }
  }
  for (const t of extra) if (isTaintSource(t)) set.add(t);
  return new Set(TAINT_SOURCES.filter((t) => set.has(t)));
}

/** Taint added by one tool call: the output's declared source, else the spec's outputTaint. */
export function taintOfOutput(outputTaint: TaintSource | undefined, declared: { source: TaintSource } | undefined): TaintSource | null {
  if (declared && isTaintSource(declared.source)) return declared.source;
  if (outputTaint && isTaintSource(outputTaint)) return outputTaint;
  return null;
}

/**
 * Taint carried by a stored tool result (crash recovery, 01 §5.11): every `<untrusted source="…">` wrapper in it.
 * Only untrusted.wrap emits a literal '<untrusted' (inbound text has reserved tags neutralized), so this never
 * misses a wrapped result; an unknown source still taints ('derived').
 */
export function taintOfStoredResult(content: unknown): TaintSource[] {
  const text = typeof content === 'string' ? content : content === null || content === undefined ? '' : JSON.stringify(content);
  const out = new Set<TaintSource>();
  for (const m of text.matchAll(/<untrusted\s+source=\\?"([^"\\]*)\\?"/g)) {
    const src = m[1] === 'guest_reply' ? 'guest' : m[1];
    out.add(isTaintSource(src) ? src : 'derived');
  }
  return [...out];
}

/** Server-tool results (web_search / web_fetch) inside an assistant message taint the run with 'web' (01 §11.2). */
export function serverToolTaint(blocks: unknown): TaintSource[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.some((b) => !!b && typeof b === 'object' && ((b as { type?: unknown }).type === 'web_search_tool_result' || (b as { type?: unknown }).type === 'web_fetch_tool_result')) ? ['web'] : [];
}

/**
 * Persists taint on the run and on its epoch right away (idempotent union). The executor calls this as soon as
 * third-party text is produced, so a crash, shutdown or user Stop before the engine's afterRound cannot leave an
 * epoch that holds untrusted text marked clean.
 */
export function persistTaint(s: Services, run: RunRow | null, add: Iterable<TaintSource>): void {
  const list = [...new Set([...add].filter(isTaintSource))];
  if (!run || list.length === 0) return;
  try {
    const cur = s.repos.runs.get(run.id) ?? run;
    const rt = [...new Set([...cur.taint, ...list])];
    if (rt.length !== cur.taint.length) s.repos.runs.update(run.id, { taint: rt });
  } catch {
    /* best effort; the engine adds it again after the round */
  }
  try {
    const ep = s.repos.conversations.getEpoch(run.conversationId, run.epoch);
    if (ep) {
      const et = [...new Set([...ep.taint, ...list])];
      if (et.length !== ep.taint.length) s.repos.conversations.updateEpoch(run.conversationId, run.epoch, { taint: et });
    }
  } catch {
    /* best effort */
  }
}
