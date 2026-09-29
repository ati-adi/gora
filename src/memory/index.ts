// memory/index.ts (WP6a; friend mode, spec 05 B1–B5) — createMemoryService (01 §9): the MemoryService over
// memory/store.ts, the jobs memory_extract, incognito_end, memory_embed (local embeddings backfill, no LLM) and
// profile_consolidate (per user after 15 new facts / a forget, plus the hourly `sys:profile_consolidate` sweep that
// queues the owners whose local time is 04:xx), the RunHooks, the mm: callbacks, the `<user_model>` context and the
// privacy hook (export with the profile card, caches dropped on delete, TTL expiry in the retention sweep).
import type { JobHandler, JobResult, MemoryService, Scope, Services, UserId } from '../contracts/index.ts';
import { parseScopeKey, scopeKey } from '../contracts/common.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import { AbortedError, errorMessage, TransientLlmError } from '../kernel/errors.ts';
import { wallTimeOf } from '../kernel/timeMath.ts';
import { registerNamed } from '../kernel/registries.ts';
import { registerMemoryCallbacks } from './callbacks.ts';
import { createMemoryContext } from './context.ts';
import { createExtraction } from './extract.ts';
import { bindStore } from './impl.ts';
import { createImporter } from './importer.ts';
import { createIncognito } from './incognito.ts';
import { consolidateForgetKey, consolidateKey, createMemoryStore } from './store.ts';
import { embedderOf, embedKey } from './vectors.ts';

/** B4 nightly: the hourly sweep queues each owner whose local hour is this one. */
export const NIGHTLY_LOCAL_HOUR = 4;
export const CONSOLIDATE_SWEEP_CRON = '17 * * * *';
const SWEEP_SPREAD_MS = 30 * 60_000;
const HOUR = 3_600_000;

export function nextSweepAt(now: number): number {
  const base = Math.floor(now / HOUR) * HOUR + 17 * 60_000;
  return base > now ? base : base + HOUR;
}

export function createMemoryService(s: Services): MemoryService {
  const store = createMemoryStore(s);
  bindStore(s, store);
  const extraction = createExtraction(s, store);
  const importer = createImporter(s, store);
  const incognito = createIncognito(s, store);

  s.scheduler.register('memory_extract', extraction.handler);
  s.scheduler.register('incognito_end', incognito.handler);

  // B2: embedding backfill of one scope (refId = scope key); the first run also loads the local model in the background
  const embedHandler: JobHandler = async (job, ctx): Promise<JobResult> => {
    const scope = job.refId ? parseScopeKey(job.refId) : null;
    if (!scope) return { status: 'done' };
    try {
      await store.embedMissing(scope, ctx.signal);
    } catch (e) {
      s.log.warn({ mod: 'memory', err: errorMessage(e) }, 'embedding backfill failed');
    }
    return { status: 'done' };
  };
  s.scheduler.register('memory_embed', embedHandler);

  // B4: per-user consolidation (refId = userId) or the hourly nightly sweep (no refId)
  const consolidateHandler: JobHandler = async (job, ctx): Promise<JobResult> => {
    if (!job.refId) {
      let queued = 0;
      for (const u of s.repos.users.iterate({ status: 'active' })) {
        try {
          if (!memoryEnabled(u, ctx.now) || wallTimeOf(ctx.now, u.tz).hour !== NIGHTLY_LOCAL_HOUR) continue;
          if (store.repo().countActive(scopeKey({ kind: 'user', userId: u.id })) === 0) continue;
          s.scheduler.schedule({
            kind: 'profile_consolidate', runAt: ctx.now + s.random.int(SWEEP_SPREAD_MS), userId: u.id, refId: u.id, dedupeKey: consolidateKey(u.id),
            payload: { reason: 'nightly' }, priority: 8, maxAttempts: 3,
          });
          queued++;
        } catch (e) {
          s.log.warn({ mod: 'memory', err: errorMessage(e) }, 'nightly consolidation queue failed');
        }
      }
      if (queued) s.log.info({ mod: 'memory', queued }, 'nightly profile consolidation queued');
      return { status: 'done' };
    }
    const r = job.payload['reason'];
    const reason = r === 'facts' || r === 'forget' || r === 'manual' ? r : 'nightly';
    try {
      await s.userProfile.consolidate(job.refId, { reason, signal: ctx.signal });
      return { status: 'done' };
    } catch (e) {
      if (e instanceof TransientLlmError || e instanceof AbortedError) return { status: 'retry', error: errorMessage(e) };
      s.log.warn({ mod: 'memory', err: e instanceof Error ? e.name : 'error' }, 'profile consolidation failed');
      return { status: 'retry', error: errorMessage(e) };
    }
  };
  s.scheduler.register('profile_consolidate', consolidateHandler);
  s.scheduler.schedule({
    kind: 'profile_consolidate', runAt: nextSweepAt(s.clock.now()), cron: CONSOLIDATE_SWEEP_CRON, tz: 'UTC', dedupeKey: 'sys:profile_consolidate', maxAttempts: 3,
  });
  s.runHooks.push(extraction.runHook, incognito.runHook);
  registerMemoryCallbacks(s, store, importer);
  registerNamed(s.contextProviders, createMemoryContext(s, store));

  const authorize = async (scope: Scope, by: { tgUserId: number }, authorId: UserId | null): Promise<boolean> => {
    if (scope.kind === 'user') return s.repos.users.getById(scope.userId)?.tgUserId === by.tgUserId;
    const author = authorId ? s.repos.users.getById(authorId) : undefined;
    if (author && author.tgUserId === by.tgUserId) return true;
    try {
      const m = await s.telegram.api.getChatMember(scope.chatId, by.tgUserId);
      return m.status === 'creator' || m.status === 'administrator';
    } catch (e) {
      s.log.warn({ mod: 'memory', err: errorMessage(e) }, 'getChatMember failed; forget refused');
      return false;
    }
  };

  s.privacyHooks.push({
    name: 'memory',
    async onDeleteUser(userId) {
      // WP1 deletes the rows (USER_DATA_TABLES) and destroys the owner's DEKs; drop the decrypted cache and pending jobs.
      store.invalidate({ kind: 'user', userId });
      for (const k of [`incog:${userId}`, consolidateKey(userId), consolidateForgetKey(userId), embedKey({ kind: 'user', userId })]) s.scheduler.cancel(k);
    },
    async exportUser(userId) {
      const scope: Scope = { kind: 'user', userId };
      // every fact that still holds text (active, pending and superseded), with no page clamp
      const lang = store.langOf(scope);
      const tz = store.tzOf(scope);
      const items = store.exportFacts(scope).map((f) => ({ ...store.toHit(f, lang, tz), status: f.row.status, sensitivity: f.row.sensitivity, quote: f.quote }));
      const own = store.repo().allOfUser(scopeKey(scope), userId).filter((r) => r.scope !== scopeKey(scope) && r.status !== 'forgotten');
      const group = own.flatMap((r) => {
        const chatId = Number(r.scope.slice(4));
        const f = store.getMany({ kind: 'group', chatId }, [r.id])[0];
        return f ? [{ id: f.id, kind: f.kind, text: f.text, group: chatId, createdAt: new Date(f.createdAt).toISOString() }] : [];
      });
      const rows = new Map(store.repo().byScope(scopeKey(scope), ['active', 'pending_confirm', 'superseded']).map((r) => [r.id, r]));
      return {
        facts: items.map((f) => {
          const r = rows.get(f.id);
          return {
            id: f.id, kind: f.kind, text: f.text, status: f.status, pinned: f.pinned, sensitivity: f.sensitivity, quote: f.quote, source: f.sourceLabel,
            provenance: r ? { sourceKind: r.sourceKind, conversationId: r.sourceConversationId, tgMessageId: r.sourceTgMessageId, createdBy: r.createdBy } : null,
            createdAt: new Date(f.createdAt).toISOString(),
          };
        }),
        groupFactsAuthored: group,
        // B4/B2: the profile card as stored; embeddings are derived vectors, so only their count is exported
        profile: (() => {
          const v = s.userProfile?.get(userId) ?? null;
          return v ? { version: v.version, card: v.card, createdAt: new Date(v.createdAt).toISOString() } : null;
        })(),
        embeddings: { model: embedderOf(s)?.model ?? null, count: store.vectors.repo().countOfUser(userId) },
      };
    },
    async retentionSweep(now) {
      // B1: short-lived mood / context facts whose TTL passed are deleted (with their vectors)
      const expired = store.sweepExpired(now ?? s.clock.now());
      if (expired) s.log.info({ mod: 'memory', expired }, 'expired memory facts deleted');
      // Group memory whose DEK was destroyed (the surfaces retention shreds every 'grp:<chatId>' DEK 7 days after the bot
      // left) is unreadable forever: the orphaned rows go, and a later re-add starts from a fresh generation.
      for (const { scope, gen } of store.repo().groupGensWithText()) {
        const chatId = Number(scope.slice(4));
        if (!Number.isFinite(chatId) || !s.crypto.isDestroyed(`mg:${chatId}:${gen}`)) continue;
        store.repo().deleteWithTextInGens(scope, [gen]);
        store.invalidate({ kind: 'group', chatId });
      }
    },
  });

  const svc: MemoryService = {
    async retrieve(scope, query, runId) {
      return store.retrieve(scope, query, runId);
    },
    async search(scope, query, limit) {
      return store.search(scope, query, limit);
    },
    async save(scope, f) {
      return store.save(scope, f);
    },
    async forget(scope, sel, by) {
      const facts = store.select(scope, sel);
      const allowed = [];
      for (const f of facts) {
        // s07 lead fix (red team): a group fact Gora extracted by itself from the chat (spec 07 C3) belongs to the
        // chat, not to an author — any member may forget it, exactly like the stored messages it came from
        if (scope.kind === 'group' && f.row.createdBy === 'extractor') allowed.push(f);
        else if (await authorize(scope, by, f.row.userId)) allowed.push(f);
      }
      const actor = s.repos.users.getByTg(by.tgUserId)?.id ?? null;
      return { forgotten: store.forgetFacts(scope, allowed, actor) };
    },
    async confirm(userId, ids, accept) {
      store.confirm(userId, ids, accept);
    },
    async list(scope, q) {
      return store.list(scope, q);
    },
    async edit(userId, id, patch) {
      store.edit(userId, id, patch);
    },
    async extractFromConversation(conversationId) {
      await extraction.extract(conversationId, null);
    },
    importText(userId, text) {
      return importer.importText(userId, text);
    },
    async forgetConversation(userId, conversationId) {
      const scope: Scope = { kind: 'user', userId };
      const conv = s.repos.conversations.get(conversationId);
      if (!conv || conv.userId !== userId) return;
      const facts = store.repo().bySourceConversation(scopeKey(scope), conversationId).map((r) => r.id);
      store.forgetFacts(scope, store.select(scope, { ids: facts }), userId);
      await s.privacy.shredConversation(conversationId, 'forget');
    },
    getMany(scope, ids) {
      return store.getMany(scope, ids);
    },
    filterFingerprinted(scope, sentences) {
      return store.filterFingerprinted(scope, sentences);
    },
  };
  return svc;
}
