// memory/tools.ts (WP6a; friend mode, spec 05 A5/B5) — memory_save (✍ reaction ack), memory_search (hybrid; about_me
// returns the profile card, the top facts and the Mini App link), memory_forget (01 §6, §9).
// app.ts passes this array to createToolRegistry(profile, external); names match TOOL_OWNERS.
import { z } from 'zod';
import type { Scope } from '../contracts/common.ts';
import type { FactKind } from '../contracts/memory.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import type { ApprovalDiff, Classification, ToolCtx, ToolOutput, ToolSpec } from '../contracts/tools.ts';
import { errorMessage } from '../kernel/errors.ts';
import { storeOf } from './impl.ts';
import type { Fact, MemoryStore } from './store.ts';

const SURFACES = ['dm', 'topic', 'mission', 'group'] as const;
const FACT_KINDS = ['profile', 'preference', 'person', 'relationship', 'goal', 'routine', 'date', 'fact', 'group_decision'] as const satisfies readonly FactKind[];
const MEMORY: Classification = Object.freeze({ actionClass: 'memory', risk: 1 });
const READ_PRIVATE: Classification = Object.freeze({ actionClass: 'read_private', risk: 0 });
const CONFIRM: Classification = Object.freeze({ actionClass: 'destructive', risk: 3 });
/** DM: up to this many facts in an untainted run are forgotten without a confirm card. */
export const FORGET_WITHOUT_CARD = 3;

const ru = (lang: string) => /^(ru|uk|kk|be)/i.test(lang);
const err = (code: string, message: string): ToolOutput<never> => ({ content: JSON.stringify({ error: code, message }), isError: true });
const need = (ctx: ToolCtx): MemoryStore => {
  const st = storeOf(ctx.services);
  if (!st) throw new Error('memory module is not initialised');
  return st;
};
/** The scope comes from the surface, never from input (01 §6 memory_search). */
function runScope(ctx: ToolCtx): Scope | null {
  if (ctx.surface === 'guest' || ctx.surface === 'biz_draft') return null;
  if (ctx.scope) return ctx.scope;
  return ctx.userId ? { kind: 'user', userId: ctx.userId } : null;
}

// ── memory_save
const saveInput = z.object({
  text: z.string().min(1).max(500),
  kind: z.enum(FACT_KINDS),
  subject: z.string().max(100).optional(),
  sensitivity: z.enum(['normal', 'sensitive']),
  explicit: z.boolean().describe('user asked to remember'),
});
type SaveIn = z.infer<typeof saveInput>;

const DENIED: Record<'consent' | 'incognito' | 'fingerprint' | 'limit', [string, string]> = {
  consent: ['MEMORY_OFF', 'memory is off for this user (or, in a group, the user did not explicitly ask); nothing was saved'],
  incognito: ['INCOGNITO', 'incognito is on; nothing is remembered until it ends'],
  fingerprint: ['FORGOTTEN', 'the user asked to forget this earlier; do not save it again'],
  limit: ['LIMIT', 'the memory is full of pinned facts; nothing was saved'],
};

const memorySave: ToolSpec<SaveIn> = {
  name: 'memory_save',
  description: 'Save a durable fact about the user or group.',
  input: saveInput,
  surfaces: SURFACES,
  parallelSafe: false,
  classify: () => MEMORY,
  statusLabel: (_i, lang) => (ru(lang) ? 'Запоминаю…' : 'Remembering…'),
  async execute(i, ctx) {
    const st = need(ctx);
    const scope = runScope(ctx);
    if (!scope) return err('NO_SCOPE', 'memory is not available here');
    const group = scope.kind === 'group';
    if (group && !i.explicit) return err('NOT_EXPLICIT', 'in a group, save only when a member explicitly asked to remember');
    const tainted = ctx.taint.size > 0;
    const r = st.save(
      scope,
      {
        text: i.text, kind: group && i.kind === 'profile' ? 'group_decision' : i.kind, ...(i.subject ? { subject: i.subject } : {}), sensitivity: i.sensitivity,
        explicit: i.explicit, authorUserId: ctx.userId,
        source: {
          kind: group ? 'group_explicit' : i.explicit ? 'tool_explicit' : 'user_message', conversationId: ctx.conversationId,
          ...(ctx.chat.triggerMessageId ? { tgMessageId: ctx.chat.triggerMessageId } : {}),
        },
      },
      // A run that read third-party content may only propose: the owner confirms on a ✓/✗ card (§11.2).
      { createdBy: 'model_tool', forcePending: tainted && !group },
    );
    if ('denied' in r) {
      const [code, msg] = DENIED[r.denied];
      return err(code, msg);
    }
    if (ctx.chat.triggerMessageId && r.status === 'active') {
      try {
        ctx.services.telegram.outbox.enqueue({
          idempotencyKey: `mmsave:${ctx.idemKey}`, ...(ctx.userId ? { userId: ctx.userId } : {}), chatId: ctx.chat.chatId, method: 'setMessageReaction', priority: 1,
          payload: { message_id: ctx.chat.triggerMessageId, reaction: [{ type: 'emoji', emoji: '✍' }] },
        });
      } catch (e) {
        ctx.log.warn({ err: errorMessage(e) }, 'memory_save reaction failed');
      }
    }
    return {
      content: JSON.stringify({ id: r.id, status: r.status, ...(r.status === 'pending_confirm' ? { note: 'The user was asked to confirm on a ✓/✗ card; it is not saved yet.' } : {}) }),
      data: r,
    };
  },
};

// ── memory_search
const searchInput = z.object({
  query: z.string().max(200),
  kind: z.enum(FACT_KINDS).optional(),
  limit: z.number().int().min(1).max(20).default(8),
  about_me: z.boolean().optional(),
});
type SearchIn = z.infer<typeof searchInput>;

/** B5: the Mini App Memory screen, where the owner sees, corrects and erases everything. */
export function memoryScreenUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/app/?screen=memory`;
}

const memorySearch: ToolSpec<SearchIn> = {
  name: 'memory_search',
  description: 'Search memory; about_me: all you know of them.',
  input: searchInput,
  surfaces: SURFACES,
  parallelSafe: true,
  classify: () => READ_PRIVATE,
  statusLabel: (_i, lang) => (ru(lang) ? 'Вспоминаю…' : 'Recalling…'),
  async execute(i, ctx) {
    const scope = runScope(ctx);
    if (!scope) return err('NO_SCOPE', 'memory is not available here');
    if (scope.kind === 'user') {
      const u = ctx.services.repos.users.getById(scope.userId);
      if (!u || !memoryEnabled(u, ctx.services.clock.now())) return { content: JSON.stringify({ facts: [], note: 'memory is off' }) };
      // B5 "what do you know about me?": the profile card + the top facts + the Mini App link, for a short friendly summary
      if (i.about_me || (!i.query.trim() && i.kind === 'profile')) {
        const st = need(ctx);
        const view = ctx.services.userProfile?.get(scope.userId) ?? null;
        const now = ctx.services.clock.now();
        const lang = st.langOf(scope);
        const tz = st.tzOf(scope);
        const top = st
          .load(scope)
          .facts.filter((f) => f.row.status === 'active' && st.alive(f, now))
          .sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || b.row.importance - a.row.importance || b.row.updatedAt - a.row.updatedAt)
          .slice(0, i.limit);
        const card = view ? { summary: view.card.summary, people: view.card.people, goals: view.card.goals, preferences: view.card.preferences, open_threads: view.card.open_threads } : null;
        const texts = card ? st.filterFingerprinted(scope, [card.summary]) : [];
        const hits = top.map((f) => st.toHit(f, lang, tz));
        st.recordUses(ctx.runId, top);
        return {
          content: JSON.stringify({
            profile: card ? { ...card, summary: texts.length ? card.summary : '' } : null,
            facts: hits.map((h) => ({ id: h.id, kind: h.kind, text: h.text, source: h.sourceLabel })),
            total: st.load(scope).facts.filter((f) => f.row.status === 'active' && st.alive(f, now)).length,
            miniapp: memoryScreenUrl(ctx.services.config.publicUrl),
            note: 'Answer as a friend in a few lines (never a data dump), and mention they can see, fix or erase everything via the Mini App link or /memory.',
          }),
          data: hits,
        };
      }
    }
    const hits = await need(ctx).search(scope, i.query, i.limit, i.kind, ctx.runId);
    return { content: JSON.stringify({ facts: hits.map((h) => ({ id: h.id, kind: h.kind, text: h.text, source: h.sourceLabel })) }), data: hits };
  },
};

// ── memory_forget
const forgetInput = z.object({ ids: z.array(z.string().max(16)).max(20).optional(), query: z.string().max(200).optional() });
type ForgetIn = z.infer<typeof forgetInput>;

const selected = (i: ForgetIn, ctx: ToolCtx): { scope: Scope; facts: Fact[] } | null => {
  const scope = runScope(ctx);
  const st = storeOf(ctx.services);
  if (!scope || !st) return null;
  return { scope, facts: st.select(scope, { ...(i.ids ? { ids: i.ids } : {}), ...(i.query ? { query: i.query } : {}) }) };
};

async function mayForget(ctx: ToolCtx, scope: Scope, f: Fact): Promise<boolean> {
  if (scope.kind === 'user') return ctx.userId === scope.userId;
  // Group: only the fact's author or a chat admin (getChatMember).
  if (!ctx.tgUserId) return false;
  const author = f.row.userId ? ctx.services.repos.users.getById(f.row.userId) : undefined;
  if (author && author.tgUserId === ctx.tgUserId) return true;
  try {
    const m = await ctx.services.telegram.api.getChatMember(scope.chatId, ctx.tgUserId);
    return m.status === 'creator' || m.status === 'administrator';
  } catch (e) {
    ctx.log.warn({ err: errorMessage(e) }, 'getChatMember failed; forget refused');
    return false;
  }
}

const memoryForget: ToolSpec<ForgetIn> = {
  name: 'memory_forget',
  description: 'Forget remembered facts by id or query.',
  input: forgetInput,
  surfaces: SURFACES,
  parallelSafe: false,
  classify(i, ctx) {
    // DM: ≤3 facts in an untainted run go through immediately; more, or a tainted run, need the owner's confirm card.
    const sel = selected(i, ctx);
    const n = sel ? sel.facts.length : 0;
    if (ctx.taint.size > 0 || n > FORGET_WITHOUT_CARD) return { ...CONFIRM, bulkCount: n };
    return MEMORY;
  },
  async renderDiff(i, ctx): Promise<ApprovalDiff> {
    const sel = selected(i, ctx);
    const facts = sel?.facts ?? [];
    const r = ru(ctx.lang);
    return {
      title: r ? `Забыть ${facts.length} факт(а/ов)` : `Forget ${facts.length} memor${facts.length === 1 ? 'y' : 'ies'}`,
      summary: r ? 'Эти факты будут стёрты без возможности восстановления.' : 'These facts will be erased for good.',
      rows: facts.slice(0, 20).map((f): [string, string] => [f.row.id, f.text.length > 120 ? `${f.text.slice(0, 119)}…` : f.text]),
      warnings: facts.length ? [] : [r ? 'Ничего не найдено.' : 'Nothing matched.'],
      targets: [],
    };
  },
  statusLabel: (_i, lang) => (ru(lang) ? 'Забываю…' : 'Forgetting…'),
  async execute(i, ctx) {
    if (!i.ids?.length && !i.query?.trim()) return err('BAD_INPUT', 'give ids or a query');
    const sel = selected(i, ctx);
    if (!sel) return err('NO_SCOPE', 'memory is not available here');
    const allowed: Fact[] = [];
    let refused = 0;
    for (const f of sel.facts) {
      if (await mayForget(ctx, sel.scope, f)) allowed.push(f);
      else refused++;
    }
    const out = need(ctx).forgetFacts(sel.scope, allowed, ctx.userId);
    return {
      content: JSON.stringify({
        forgotten: out.map((o) => ({ id: o.id, preview: o.preview })),
        ...(refused ? { refused, note: 'only the author or a group admin can forget those' } : {}),
        ...(out.length ? {} : { note: 'nothing matched' }),
      }),
      data: out,
    };
  },
};

export const TOOLS: readonly ToolSpec[] = Object.freeze([memoryForget, memorySave, memorySearch] as ToolSpec[]);
