// memory/extract.ts (WP6a; friend mode, spec 05 B1/A5) — background extraction (01 §9 "Extraction", 02 §D): memory is
// on by default (memoryEnabled: off only when the owner turned it off or incognito is active), the memory_extract job is
// batched per conversation (after LIMITS.memoryExtractExchanges owner exchanges since the watermark, or
// LIMITS.memoryExtractIdleMs idle, whichever first; priority background, so it pauses with the LLM budget), reads
// owner-authored inputs only, keeps confidence ≥ 0.8, respects the fingerprints, stores importance and a TTL for
// mood/context signals, keeps a sensitive fact only when the owner plainly stated it about themselves (explicit), hands
// commitments to WP6b, and acknowledges with a ✍ reaction on each owner message a fact came from (no cards, no markup).
import type { Ms } from '../contracts/common.ts';
import type { FactKind } from '../contracts/memory.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import { LIMITS } from '../config.ts';
import type { JobHandler, JobResult } from '../contracts/scheduler.ts';
import { JOB_LLM_PRIORITY } from '../contracts/scheduler.ts';
import type { RunHook, Services } from '../contracts/services.ts';
import type { ConversationRow, InputRow, RunRow } from '../contracts/storage.ts';
import { errorMessage } from '../kernel/errors.ts';
import { isoWithOffset } from '../kernel/timeMath.ts';
import type { MemoryStore } from './store.ts';
import { sentences, tokens } from './text.ts';

export const MIN_CONFIDENCE = 0.8;
const DAY = 86_400_000;
/** B1 TTL bounds for mood / context facts (days). */
export const MAX_TTL_DAYS = 90;
const EXTRACT_KINDS: ReadonlySet<InputRow['kind']> = new Set(['text', 'voice', 'choice']);
const FACT_KINDS: ReadonlySet<FactKind> = new Set(['profile', 'preference', 'person', 'relationship', 'goal', 'routine', 'date', 'fact']);
const EXTRACT_SURFACES: ReadonlySet<ConversationRow['kind']> = new Set(['dm', 'topic', 'mission']);

export const extractKey = (conversationId: string) => `mx:${conversationId}`;

/** Owner-typed text of an input (text blocks only; voice inputs carry their transcript as text). */
export function inputText(i: InputRow): string {
  return i.content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * The provenance quote of an extracted fact: only the sentence(s) of the input that support it, never the whole input
 * (a sibling fact's quote must not carry a sentence the user later forgets). Falls back to the input when nothing overlaps.
 */
export function supportingQuote(input: string, fact: string, lang = 'en'): string {
  const want = new Set(tokens(fact, lang));
  const parts = sentences(input);
  if (want.size && parts.length > 1) {
    let best = 0;
    const scored = parts.map((p) => {
      const n = new Set(tokens(p, lang).filter((t) => want.has(t))).size;
      best = Math.max(best, n);
      return n;
    });
    if (best > 0) return parts.filter((_, i) => scored[i] === best).join(' ').slice(0, 300);
  }
  return input.slice(0, 300);
}

interface Limits { maxInputs: number; maxInputChars: number; maxTotalChars: number; maxExisting: number; maxExistingChars: number }
const LIMITS_ANTHROPIC: Limits = { maxInputs: 30, maxInputChars: 2000, maxTotalChars: 12_000, maxExisting: 200, maxExistingChars: 20_000 };
/** 02 §D: on the Groq free tier extraction reads the last exchange only and stays small. */
const LIMITS_GROQ: Limits = { maxInputs: 6, maxInputChars: 1200, maxTotalChars: 2500, maxExisting: 40, maxExistingChars: 2000 };

export function createExtraction(s: Services, store: MemoryStore) {
  const log = () => s.log.child({ mod: 'memory' });
  const groq = () => (s.profile ?? s.config.profile).id !== 'anthropic';

  const eligible = (conv: ConversationRow | undefined, now: Ms): boolean => {
    if (!conv || !conv.userId || !EXTRACT_SURFACES.has(conv.kind)) return false;
    const u = s.repos.users.getById(conv.userId);
    return !!u && memoryEnabled(u, now);
  };

  /** Owner exchanges (distinct runs that consumed owner-authored inputs) of a conversation since its watermark. */
  const exchangesSinceMark = (conv: ConversationRow): number => {
    try {
      const mark = store.repo().watermark(conv.id)?.lastInputCreatedAt ?? 0;
      const runs = new Set<string>();
      for (const i of s.repos.inputs.ownerAuthoredSince(conv.id, mark)) if (i.consumedRunId !== null && i.author === 'owner' && !i.untrusted) runs.add(i.consumedRunId);
      return runs.size;
    } catch {
      return 0;
    }
  };

  /**
   * B1 batching: the extraction of a conversation runs once LIMITS.memoryExtractExchanges owner exchanges piled up since
   * the watermark, or after LIMITS.memoryExtractIdleMs without a new exchange (each finished run pushes that back).
   */
  const schedule = (conv: ConversationRow, runId: string | null): void => {
    const now = s.clock.now();
    const due = exchangesSinceMark(conv) >= LIMITS.memoryExtractExchanges ? now : now + LIMITS.memoryExtractIdleMs;
    s.scheduler.schedule({
      kind: 'memory_extract', runAt: due, userId: conv.userId ?? undefined, refId: conv.id, dedupeKey: extractKey(conv.id),
      priority: 7, maxAttempts: 4, payload: runId ? { runId } : {},
    });
  };

  const runHook: RunHook = {
    name: 'memory_extract',
    onRunFinished(run: RunRow, conv: ConversationRow) {
      if (run.state !== 'done') return;
      if (!eligible(conv, s.clock.now())) return;
      schedule(conv, run.id);
    },
  };

  /** A5: a ✍ reaction on each owner message a new fact came from (idempotent per input); never a card or markup. */
  const acknowledge = (conv: ConversationRow, userId: string, sources: ReadonlyMap<string, InputRow>): void => {
    for (const [inputId, row] of sources) {
      const chatId = row.tgChatId ?? conv.tgChatId;
      if (row.tgMessageId === null || chatId === null) continue;
      try {
        s.telegram.outbox.enqueue({
          idempotencyKey: `mmrx:${inputId}`, userId, chatId, method: 'setMessageReaction', priority: 5,
          payload: { message_id: row.tgMessageId, reaction: [{ type: 'emoji', emoji: '✍' }] },
        });
      } catch (e) {
        log().warn({ err: errorMessage(e) }, 'memory reaction failed');
      }
    }
  };

  const extract = async (conversationId: string, runId: string | null, signal?: AbortSignal): Promise<void> => {
    const now = s.clock.now();
    const conv = s.repos.conversations.get(conversationId);
    if (!conv || !conv.userId) return;
    const R = store.repo();
    if (!eligible(conv, now)) {
      // nothing written while memory is off or incognito, and those inputs are never read later either
      R.setWatermark(conversationId, now, now);
      return;
    }
    const userId = conv.userId;
    // An incognito window that expired but was not finalized yet (incognito_end pending): nothing written up to its end
    // is ever read, whatever epoch it was consumed in (01 §9: no memory is written during incognito).
    const until = s.repos.users.getById(userId)?.incognitoUntil ?? null;
    const mark = Math.max(R.watermark(conversationId)?.lastInputCreatedAt ?? 0, until !== null ? Math.min(until, now) - 1 : 0);
    const scope = { kind: 'user' as const, userId };
    const all = s.repos.inputs.ownerAuthoredSince(conversationId, mark).sort((a, b) => a.createdAt - b.createdAt);
    const firstUnconsumed = all.find((i) => i.consumedRunId === null);
    const consumed = all.filter((i) => i.consumedRunId !== null && (!firstUnconsumed || i.createdAt < firstUnconsumed.createdAt));
    if (!consumed.length) return;
    const newMark = consumed.at(-1)!.createdAt;
    // Belt and braces: an input consumed in an incognito epoch is never extracted (the watermarks moved by the incognito
    // run hook and the incognito_end job cover the other epochs and conversations).
    const incognitoEpochs = new Map<number, boolean>();
    const inIncognito = (epoch: number | null): boolean => {
      if (epoch === null) return false;
      let v = incognitoEpochs.get(epoch);
      if (v === undefined) {
        v = s.repos.conversations.getEpoch(conversationId, epoch)?.reason === 'incognito_start';
        incognitoEpochs.set(epoch, v);
      }
      return v;
    };
    const L = groq() ? LIMITS_GROQ : LIMITS_ANTHROPIC;
    // the whole batch since the watermark (B1: ~3 exchanges), newest kept first when it does not fit the limits
    let pool = consumed.filter((i) => EXTRACT_KINDS.has(i.kind) && !i.untrusted && i.author === 'owner' && !inIncognito(i.consumedEpoch));
    pool = pool.slice(-L.maxInputs);
    const inputs: Array<{ id: string; text: string; row: InputRow }> = [];
    let total = 0;
    for (const i of [...pool].reverse()) {
      // forgotten text never goes back to a model: fingerprinted sentences are dropped first
      const text = store.filterFingerprinted(scope, sentences(inputText(i))).join(' ').slice(0, L.maxInputChars);
      if (!text) continue;
      if (total + text.length > L.maxTotalChars) break;
      total += text.length;
      inputs.unshift({ id: i.id, text, row: i });
    }
    if (!inputs.length) {
      R.setWatermark(conversationId, newMark, now);
      return;
    }
    const facts = store.load(scope).facts.filter((f) => f.row.status === 'active');
    const existing: Array<{ id: string; text: string }> = [];
    let echars = 0;
    for (const f of [...facts].sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || b.row.useCount - a.row.useCount || b.row.updatedAt - a.row.updatedAt)) {
      if (existing.length >= L.maxExisting || echars + f.text.length > L.maxExistingChars) break;
      echars += f.text.length;
      existing.push({ id: f.row.id, text: f.text });
    }
    const u = s.repos.users.getById(userId)!;
    const res = await s.side.extract(
      { inputs: inputs.map(({ id, text }) => ({ id, text })), existing, nowLocal: isoWithOffset(now, u.tz), lang: u.languageCode ?? 'en' },
      { userId, conversationId, ...(runId ? { runId } : {}), priority: JOB_LLM_PRIORITY.memory_extract ?? 'background', ...(signal ? { signal } : {}) },
    );
    const lang = u.languageCode ?? 'en';
    const byId = new Map(inputs.map((i) => [i.id, i]));
    const existingIds = new Set(facts.map((f) => f.row.id));
    const sources = new Map<string, InputRow>();
    for (const f of res?.facts ?? []) {
      if (!(f.confidence >= MIN_CONFIDENCE) || !FACT_KINDS.has(f.kind)) continue;
      // B1: health / finances / intimate facts only when the owner plainly stated them about themselves (no ✓/✗ card)
      if (f.sensitivity === 'sensitive' && !f.explicit) continue;
      const src = byId.get(f.source_input_id);
      if (!src) continue; // provenance must point at an owner-authored input we actually sent
      const ttl = typeof f.ttl_days === 'number' && Number.isFinite(f.ttl_days) && f.ttl_days > 0 ? Math.min(MAX_TTL_DAYS, f.ttl_days) : null;
      const r = store.save(
        scope,
        {
          text: f.text, kind: f.kind, ...(f.subject ? { subject: f.subject } : {}), sensitivity: f.sensitivity, explicit: f.explicit, authorUserId: userId,
          source: { kind: 'user_message', conversationId, inputId: src.id, ...(src.row.tgMessageId !== null ? { tgMessageId: src.row.tgMessageId } : {}), quote: supportingQuote(src.text, f.text, lang) },
          importance: typeof f.importance === 'number' && Number.isFinite(f.importance) ? Math.min(1, Math.max(0, f.importance)) : 0.5,
          ...(ttl !== null ? { expiresAt: now + Math.round(ttl * DAY) } : {}),
        },
        { createdBy: 'extractor', confidence: f.confidence, supersedesId: f.supersedes_id && existingIds.has(f.supersedes_id) ? f.supersedes_id : null },
      );
      if ('id' in r && !existingIds.has(r.id)) {
        existingIds.add(r.id);
        sources.set(src.id, src.row);
      }
    }
    for (const c of res?.commitments ?? []) {
      if (!byId.has(c.source_input_id) || !c.text.trim()) continue;
      try {
        s.commitments.add({
          userId, source: 'dm', direction: c.direction, text: c.text.slice(0, 300), ...(c.counterpart ? { counterpart: c.counterpart.slice(0, 100) } : {}),
          dueLocal: c.due_local, sourceInputId: c.source_input_id,
        });
      } catch (e) {
        log().warn({ err: errorMessage(e) }, 'commitment hand-off failed');
      }
    }
    R.setWatermark(conversationId, newMark, now);
    acknowledge(conv, userId, sources);
  };

  const handler: JobHandler = async (job, ctx): Promise<JobResult> => {
    if (!job.refId) return { status: 'done' };
    try {
      const runId = typeof job.payload['runId'] === 'string' ? (job.payload['runId'] as string) : null;
      await extract(job.refId, runId, ctx?.signal);
      return { status: 'done' };
    } catch (e) {
      log().warn({ conversationId: job.refId, err: e instanceof Error ? e.name : 'error' }, 'memory extraction failed');
      return { status: 'retry', error: errorMessage(e) };
    }
  };

  return { runHook, handler, extract, schedule };
}
