// agent/side.ts (WP3) — SideCalls (01 §4.4 agent.ts) over transport.parse with the static side prompts (prompt/side.ts).
// Every call records usage (llm_calls purpose 'side' / 'handoff', per-user cost) with its CallMeta, and carries a priority
// (default 'background', 03 R6). Parse failures return null; TransientLlmError / AbortedError propagate so a job can retry.
import { z } from 'zod';
import type { Extracted, FactKind, LlmCallPurpose, Services, SideCallMeta, SideCalls, SidePurpose, SideRequest, Triage } from '../contracts/index.ts';
import { AbortedError, TransientLlmError } from '../kernel/errors.ts';
import { SIDE_PROMPTS } from './prompt/side.ts';
import { recordSideCall } from './usage.ts';

const FACT_KINDS = ['profile', 'preference', 'person', 'relationship', 'goal', 'routine', 'date', 'fact', 'group_decision'] as const satisfies readonly FactKind[];

export const TriageSchema = z.object({
  needs_reply: z.boolean(),
  urgency: z.number().int().min(0).max(3),
  summary: z.string().max(400),
  category: z.enum(['question', 'request', 'info', 'social', 'spam', 'other']),
  commitment: z.object({ direction: z.enum(['i_owe', 'they_owe']), text: z.string().max(300), due_local: z.string().nullable(), source_message_id: z.number().int().nullable().optional() }).nullable(),
});

export const ExtractSchema = z.object({
  facts: z.array(
    z.object({
      text: z.string().min(1).max(300),
      kind: z.enum(FACT_KINDS),
      subject: z.string().nullable(),
      sensitivity: z.enum(['normal', 'sensitive']),
      confidence: z.number().min(0).max(1),
      source_input_id: z.string(),
      supersedes_id: z.string().nullable(),
      explicit: z.boolean(),
      // spec 05 B1 (optional so older scripted parses stay valid): 0–1, and a TTL in days for mood / context signals
      importance: z.number().min(0).max(1).optional(),
      ttl_days: z.number().min(0).max(365).nullable().optional(),
    }),
  ).max(20),
  commitments: z.array(
    z.object({ text: z.string().min(1).max(300), direction: z.enum(['i_owe', 'they_owe']), counterpart: z.string().nullable(), due_local: z.string().nullable(), source_input_id: z.string() }),
  ).max(10),
});

export const ImportSchema = z.object({ facts: z.array(z.object({ text: z.string().min(1).max(300), kind: z.enum(FACT_KINDS), sensitivity: z.enum(['normal', 'sensitive']) })).max(100) });
export const TitleSchema = z.object({ title: z.string().max(60).nullable() });
export const SemanticSchema = z.object({ met: z.boolean(), summary: z.string().max(300) });
export const HandoffSchema = z.object({ note: z.string().min(1).max(4000) });

export interface SideCallsImpl extends SideCalls {
  /** 03 R2 Groq handoff note (fast model, ≤ 250 words), used by epochs.rotate when profile.caching is false. */
  handoffNote(transcript: string, exclude: readonly string[], lang: string, meta?: SideCallMeta): Promise<string | null>;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function createSideCalls(s: Services): SideCallsImpl {
  const sideModel = () => (s.config.profile.provider === 'groq' ? s.config.profile.models.fast : s.config.anthropic.sideModel);

  const mainModel = () => s.config.profile.models.main;

  async function call<T>(purpose: SidePurpose, user: string, schema: z.ZodType<T>, meta: SideCallMeta | undefined, recordAs: LlmCallPurpose = 'side', maxTokens?: number, o: { system?: string; role?: 'fast' | 'main' } = {}): Promise<T | null> {
    const req: SideRequest<T> = {
      purpose,
      system: o.system ?? SIDE_PROMPTS[purpose as keyof typeof SIDE_PROMPTS] ?? '',
      user,
      schema,
      ...(maxTokens ? { maxTokens } : {}),
      ...(o.role === 'main' ? { role: 'main' as const } : {}),
      ...(meta ? { meta: { userId: meta.userId ?? null, conversationId: meta.conversationId ?? null, runId: meta.runId ?? null } } : {}),
    };
    try {
      const r = await s.transport.parse(req, meta?.signal, { priority: meta?.priority ?? 'background' });
      recordSideCall(s, { purpose: recordAs, model: o.role === 'main' ? mainModel() : sideModel(), usage: r.usage, requestId: r.requestId, stopReason: r.stopReason, userId: meta?.userId ?? null, conversationId: meta?.conversationId ?? null, runId: meta?.runId ?? null, hmacOf: { purpose, user } });
      return r.parsed;
    } catch (e) {
      if (e instanceof TransientLlmError || e instanceof AbortedError) throw e;
      s.log.warn({ purpose, err: e instanceof Error ? e.name : 'error' }, 'side call failed');
      return null;
    }
  }

  return {
    async triage(i, meta) {
      const user = `Language: ${i.lang}\nLocal time: ${i.nowLocal}\nOther person: ${cut(i.peerName, 80)}\n\nTranscript:\n${i.transcript}`;
      return (await call('triage', user, TriageSchema, meta)) as Triage | null;
    },
    async extract(i, meta) {
      const owner = i.inputs.map((x) => `[${x.id}] ${x.text}`).join('\n');
      const existing = i.existing.length ? i.existing.map((x) => `[${x.id}] ${x.text}`).join('\n') : '(none)';
      const user = `Language: ${i.lang}\nLocal time: ${i.nowLocal}\n\nExisting facts:\n${existing}\n\nOwner messages:\n${owner}`;
      const r = await call('extract', user, ExtractSchema, meta);
      if (!r) return null;
      const ids = new Set(i.inputs.map((x) => x.id));
      const known = new Set(i.existing.map((x) => x.id));
      // never trust ids the model invented
      return {
        facts: r.facts.filter((f) => ids.has(f.source_input_id)).map((f) => ({ ...f, supersedes_id: f.supersedes_id && known.has(f.supersedes_id) ? f.supersedes_id : null })),
        commitments: r.commitments.filter((c) => ids.has(c.source_input_id)),
      } satisfies Extracted;
    },
    async importFacts(text, lang, meta) {
      const r = await call('import', `Language: ${lang}\n\nText:\n${text}`, ImportSchema, meta);
      return r?.facts ?? [];
    },
    async topicTitle(firstMessage, lang, meta) {
      const r = await call('title', `Language: ${lang}\n\nFirst message:\n${cut(firstMessage, 2_000)}`, TitleSchema, meta);
      const t = r?.title?.trim().replace(/^["'«]+|["'»]+$/g, '').replace(/[.!?…]+$/, '');
      return t ? cut(t, 60) : null;
    },
    async semanticCheck(description, before, after, meta) {
      const user = `Condition: ${description}\n\nOld snapshot:\n${cut(before, 6_000)}\n\nNew snapshot:\n${cut(after, 6_000)}`;
      return call('semantic', user, SemanticSchema, meta);
    },
    async structured(req, meta) {
      // friend-mode (spec 05): the caller owns the prompt and schema; usage is recorded here like every side call
      return call(req.purpose, req.user, req.schema, meta, 'side', req.maxTokens, { system: req.system, ...(req.role ? { role: req.role } : {}) });
    },
    async handoffNote(transcript, exclude, lang, meta) {
      const ex = exclude.length ? `\n\nexclude:\n${exclude.map((x) => `- ${x}`).join('\n')}` : '';
      const r = await call('handoff', `Language: ${lang}\n\nConversation:\n${transcript}${ex}`, HandoffSchema, meta, 'handoff');
      if (!r) return null;
      const words = r.note.trim().split(/\s+/);
      return words.length > 260 ? words.slice(0, 250).join(' ') + ' …' : r.note.trim();
    },
  };
}
