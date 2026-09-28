// memory/store.ts (WP6a; friend mode, spec 05 B1–B3) — the memory core (01 §9): encrypted facts under the scope's memory
// DEK generation, the memory gate (memoryEnabled: on unless turned off or incognito), fingerprints, hybrid retrieval
// (BM25-lite + local embeddings fused by RRF, × importance × recency, memory/retrieval.ts) over a per-(scope, gen)
// decrypted LRU, listing, editing, confirmation, TTL expiry, and the forget pipeline with generation rotation (which
// also drops the fact's vector, re-seals the other vectors and rebuilds the profile card without the fact).
import type { Ms, Scope, UserId } from '../contracts/common.ts';
import { parseScopeKey, scopeKey } from '../contracts/common.ts';
import type { FactKind, MemoryFactView, MemoryHit, MemoryService } from '../contracts/memory.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import type { Services } from '../contracts/services.ts';
import { uiLang } from '../contracts/i18n.ts';
import { LIMITS } from '../config.ts';
import { cosine } from '../capabilities/embedder.ts';
import { errorMessage } from '../kernel/errors.ts';
import { factId } from '../kernel/ids.ts';
import { estimateTokens } from '../kernel/tokens.ts';
import { wallTimeOf } from '../kernel/timeMath.ts';
import { captureProfileCarry, restoreProfileCarry, scrubExpired } from './profile.ts';
import { createProfileRepo, type ProfileRepo } from './profileRepo.ts';
import { createMemoryRepo, type CreatedBy, type FactRow, type MemoryRepo, type SourceKind } from './repo.ts';
import { hybridRank } from './retrieval.ts';
import { fingerprintGrams, normalize, probeGrams, sentences, tokens } from './text.ts';
import { createVectors, embedderOf, embedKey, EMBED_BATCH } from './vectors.ts';

export const MAX_FACT_TEXT = 500;
export const MAX_ACTIVE_FACTS = 2000;
export const MAX_PROFILE_FACTS = 12;
export const MAX_OTHER_FACTS = 8;
export const MAX_HITS = 20;
/** 02 §D / 03: on the Groq free tier the memory digest is pinned/profile ≤ 250 tokens + retrieved ≤ 300 tokens. */
export const GROQ_PINNED_TOKENS = 250;
export const GROQ_RETRIEVED_TOKENS = 300;
const CACHE_SCOPES = 200;
/** B4: per-user consolidation job keys (a forget rebuild has its own key so a 'facts' trigger never overwrites it). */
export const consolidateKey = (userId: string) => `pc:${userId}`;
export const consolidateForgetKey = (userId: string) => `pc:${userId}:forget`;

export type SaveInput = Parameters<MemoryService['save']>[1];
export type SaveResult = Awaited<ReturnType<MemoryService['save']>>;
export interface SaveOptions { createdBy?: CreatedBy; confidence?: number; forcePending?: boolean; supersedesId?: string | null; noCard?: boolean; now?: Ms }
/** A scored active fact: `bm` = BM25 normalized to the best match (lexical selection: forget / list), `score` = hybrid. */
export interface ScoredFact { f: Fact; bm: number; score: number }

export interface Fact { row: FactRow; text: string; subject: string | null; quote: string | null; toks: string[] }
interface Loaded { gen: number; version: number; facts: Fact[]; df: Map<string, number>; avgLen: number }

const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** BM25-lite (k1 = 1.2, b = 0.75) of each fact for the query tokens. */
export function bm25(q: readonly string[], facts: ReadonlyArray<{ toks: readonly string[] }>, df: ReadonlyMap<string, number>, avgLen: number): number[] {
  const N = facts.length;
  const qs = [...new Set(q)];
  return facts.map((f) => {
    if (!qs.length || !f.toks.length) return 0;
    const tf = new Map<string, number>();
    for (const t of f.toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of qs) {
      const n = tf.get(t);
      if (!n) continue;
      const d = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      s += (idf * n * 2.2) / (n + 1.2 * (0.25 + (0.75 * f.toks.length) / (avgLen || 1)));
    }
    return s;
  });
}

export class MemoryDenied extends Error {
  readonly reason: 'consent' | 'incognito' | 'fingerprint' | 'limit';
  constructor(reason: MemoryDenied['reason']) {
    super(`memory write denied: ${reason}`);
    this.reason = reason;
  }
}

export function createMemoryStore(s: Services) {
  let repoCache: MemoryRepo | null = null;
  const repo = (): MemoryRepo => (repoCache ??= createMemoryRepo(s.db));
  let profileCache: ProfileRepo | null = null;
  const profiles = (): ProfileRepo => (profileCache ??= createProfileRepo(s.db));
  const log = () => s.log.child({ mod: 'memory' });
  const versions = new Map<string, number>();
  const cache = new Map<string, Loaded>();
  const fpCache = new Map<string, Set<string>>();
  const touch = (sk: string) => {
    versions.set(sk, (versions.get(sk) ?? 0) + 1);
    cache.delete(sk);
  };

  // ── scope helpers
  const ownerOf = (scope: Scope): string => (scope.kind === 'user' ? scope.userId : `grp:${scope.chatId}`);
  const dekFor = (scope: Scope, gen: number) => (scope.kind === 'user' ? `m:${scope.userId}:${gen}` : `mg:${scope.chatId}:${gen}`);
  const aad = (col: 'text_enc' | 'subject_enc' | 'quote_enc', id: string) => `memory_facts|${col}|${id}`;
  const vectors = createVectors(s, { dekFor, ownerOf });
  const alive = (f: Fact, now: Ms): boolean => f.row.expiresAt === null || f.row.expiresAt > now;
  const heldGen = (scope: Scope): number => {
    if (scope.kind === 'user') return s.repos.users.getById(scope.userId)?.memoryGen ?? 1;
    try {
      return s.groups.memoryGen(scope.chatId);
    } catch {
      return 1;
    }
  };
  /**
   * Rows that still hold ciphertext under a destroyed memory DEK are orphans of a shred (e.g. the surfaces retention
   * sweep destroys every 'grp:<chatId>' DEK after the bot left a group): unreadable forever, so they are deleted.
   */
  const purgeOrphans = (scope: Scope): number => {
    const sk = scopeKey(scope);
    const dead = repo().gensWithText(sk).filter((g) => s.crypto.isDestroyed(dekFor(scope, g)));
    if (!dead.length) return 0;
    vectors.repo().deleteInGens(sk, dead);
    const n = repo().deleteWithTextInGens(sk, dead);
    if (n) log().warn({ scope: scope.kind, rows: n }, 'memory rows under a destroyed DEK purged');
    cache.delete(sk);
    vectors.invalidate(scope);
    return n;
  };
  /**
   * The generation new writes use: never below a generation already present in the table (crash-safe), and never a
   * generation whose DEK was destroyed (a re-added group after the retention shred starts a fresh generation).
   */
  const currentGen = (scope: Scope): number => {
    let g = Math.max(1, heldGen(scope), repo().maxGen(scopeKey(scope)));
    if (!s.crypto.isDestroyed(dekFor(scope, g))) return g;
    purgeOrphans(scope);
    for (let i = 0; i < 10_000 && s.crypto.isDestroyed(dekFor(scope, g)); i++) g++;
    return g;
  };
  const langOf = (scope: Scope): string => (scope.kind === 'user' ? (s.repos.users.getById(scope.userId)?.languageCode ?? 'en') : 'en');
  const tzOf = (scope: Scope): string => (scope.kind === 'user' ? (s.repos.users.getById(scope.userId)?.tz ?? 'UTC') : 'UTC');

  const seal = (scope: Scope, gen: number, col: 'text_enc' | 'subject_enc' | 'quote_enc', id: string, v: string): Uint8Array => {
    const dek = dekFor(scope, gen);
    s.crypto.ensureDek(dek, ownerOf(scope), 'memory');
    return s.crypto.seal(dek, v, aad(col, id));
  };
  const open = (ct: Uint8Array | null, col: 'text_enc' | 'subject_enc' | 'quote_enc', id: string): string | null => (ct ? s.crypto.openText(ct, aad(col, id)) : null);

  const decrypt = (row: FactRow, lang: string): Fact | null => {
    try {
      const text = open(row.textEnc, 'text_enc', row.id);
      if (text === null) return null;
      const subject = open(row.subjectEnc, 'subject_enc', row.id);
      return { row, text, subject, quote: open(row.quoteEnc, 'quote_enc', row.id), toks: tokens(`${text} ${subject ?? ''}`, lang) };
    } catch (e) {
      log().warn({ factId: row.id, err: errorMessage(e) }, 'fact could not be decrypted');
      return null;
    }
  };

  /** Decrypted active + pending facts of a scope, cached per (scope, generation, write version). */
  const load = (scope: Scope): Loaded => {
    const sk = scopeKey(scope);
    const gen = currentGen(scope);
    const version = versions.get(sk) ?? 0;
    const hit = cache.get(sk);
    if (hit && hit.gen === gen && hit.version === version) {
      cache.delete(sk);
      cache.set(sk, hit);
      return hit;
    }
    const lang = langOf(scope);
    const facts = repo()
      .byScope(sk)
      .map((r) => decrypt(r, lang))
      .filter((f): f is Fact => f !== null);
    const df = new Map<string, number>();
    let total = 0;
    for (const f of facts) {
      if (f.row.status !== 'active') continue;
      total += f.toks.length;
      for (const t of new Set(f.toks)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const active = facts.filter((f) => f.row.status === 'active').length;
    const l: Loaded = { gen, version, facts, df, avgLen: active ? total / active : 1 };
    cache.set(sk, l);
    while (cache.size > CACHE_SCOPES) cache.delete(cache.keys().next().value as string);
    return l;
  };

  const fps = (scope: Scope): Set<string> => {
    const sk = scopeKey(scope);
    let f = fpCache.get(sk);
    if (!f) {
      f = repo().fingerprints(sk);
      fpCache.set(sk, f);
    }
    return f;
  };
  const isFingerprinted = (scope: Scope, text: string): boolean => {
    const set = fps(scope);
    if (!set.size) return false;
    return probeGrams(text).some((g) => set.has(s.crypto.hmac('fp', g)));
  };

  const sourceLabel = (row: FactRow, lang: string, tz: string): string => {
    const w = wallTimeOf(row.createdAt, tz);
    const ru = uiLang(lang) === 'ru';
    const date = `${w.day} ${(ru ? MON_RU : MON_EN)[w.month - 1]}`;
    const what: Record<SourceKind, [string, string]> = {
      user_message: row.createdBy === 'extractor' ? ['from your message', 'из вашего сообщения'] : ['from our chat', 'из нашего чата'],
      tool_explicit: ['you asked me to remember', 'вы просили запомнить'],
      group_explicit: ['saved in the group', 'сохранено в группе'],
      import: ['imported', 'импорт'],
      miniapp: ['added in the Mini App', 'добавлено в Mini App'],
    };
    return `${what[row.sourceKind][ru ? 1 : 0]}, ${date}`;
  };
  const toHit = (f: Fact, lang: string, tz: string): MemoryHit => ({
    id: f.row.id, text: f.text, kind: f.row.kind, sourceLabel: sourceLabel(f.row, lang, tz), createdAt: f.row.createdAt, pinned: f.row.pinned,
  });
  const toView = (f: Fact, lang: string, tz: string): MemoryFactView => ({
    ...toHit(f, lang, tz), status: f.row.status === 'pending_confirm' ? 'pending_confirm' : 'active', sensitivity: f.row.sensitivity, quote: f.quote, useCount: f.row.useCount,
  });

  /**
   * Lexical scoring of the live (active, unexpired) facts of a scope; `bm` is BM25 normalized to the best match (0 when
   * nothing matched) and `raw` the BM25 score itself. Used by forget / list selection, and as leg A of ranked().
   */
  const scored = (scope: Scope, query: string): Array<{ f: Fact; bm: number; raw: number }> => {
    const l = load(scope);
    const now = s.clock.now();
    const active = l.facts.filter((f) => f.row.status === 'active' && alive(f, now));
    const raw = bm25(tokens(query, langOf(scope)), active, l.df, l.avgLen);
    const max = Math.max(0, ...raw);
    return active.map((f, i) => ({ f, bm: max > 0 ? raw[i]! / max : 0, raw: raw[i]! }));
  };

  /**
   * Schedules the embedding backfill of a scope (no LLM; loads the local model in the background on first use). An
   * unavailable model is still asked: the embedder itself retries a failed load at most once an hour and otherwise
   * resolves null at once.
   */
  const scheduleEmbed = (scope: Scope): void => {
    const e = embedderOf(s);
    if (!e || e.dim <= 0) return;
    try {
      s.scheduler.schedule({
        kind: 'memory_embed', runAt: s.clock.now(), refId: scopeKey(scope), dedupeKey: embedKey(scope), priority: 8, maxAttempts: 3,
        ...(scope.kind === 'user' ? { userId: scope.userId } : {}),
      });
    } catch (e2) {
      log().warn({ err: errorMessage(e2) }, 'memory_embed schedule failed');
    }
  };

  /**
   * B3 hybrid ranking of the live facts for a query: leg A BM25, leg B cosine against the e5 'query:' vector (only when
   * the embedder is already loaded: an interactive turn never waits for the first model load, which is warmed by the
   * memory_embed job instead). Facts without a vector yet are ranked lexically and queued for backfill.
   */
  const ranked = async (scope: Scope, query: string): Promise<ScoredFact[]> => {
    const lex = scored(scope, query);
    if (!lex.length) return [];
    const now = s.clock.now();
    let cos: Array<number | null> = lex.map(() => null);
    const e = embedderOf(s);
    if (e && e.dim > 0 && query.trim()) {
      const st = e.status();
      if (st === 'ready') {
        let vecs: Map<string, Float32Array> | null = null;
        try {
          vecs = vectors.load(scope, currentGen(scope), e.model, e.dim);
          const q = vecs.size ? await e.embed([query.slice(0, 2_000)], 'query') : null;
          const qv = q?.[0];
          if (qv && qv.length === e.dim) cos = lex.map((x) => (vecs!.has(x.f.row.id) ? cosine(qv, vecs!.get(x.f.row.id)!) : null));
        } catch (err) {
          log().warn({ err: errorMessage(err) }, 'semantic leg failed; lexical only');
        }
        if (vecs && lex.some((x) => !vecs!.has(x.f.row.id))) scheduleEmbed(scope);
      } else if (st !== 'loading') scheduleEmbed(scope);
    }
    const r = hybridRank(
      lex.map((x, i) => ({ id: x.f.row.id, kind: x.f.row.kind, pinned: x.f.row.pinned, importance: x.f.row.importance, updatedAt: x.f.row.updatedAt, bm: x.raw, cos: cos[i] ?? null })),
      { now, halfLifeDays: LIMITS.memoryHalfLifeDays },
    );
    return lex.map((x, i) => ({ f: x.f, bm: x.bm, score: r[i]!.score }));
  };

  // ── gates
  const gate = (scope: Scope, src: SaveInput['source'], explicit: boolean): void => {
    const now = s.clock.now();
    if (scope.kind === 'user') {
      // spec 05 B1: on unless the owner turned memory off (memoryConsent false) or incognito is active; null = on
      const u = s.repos.users.getById(scope.userId);
      if (!u) throw new MemoryDenied('consent');
      if (u.incognitoUntil !== null && u.incognitoUntil > now && u.status !== 'deleting') throw new MemoryDenied('incognito');
      if (!memoryEnabled(u, now)) throw new MemoryDenied('consent');
    } else if (src.kind !== 'group_explicit' || !explicit) {
      // §9: group memory is written only through an explicit /remember or memory_save in the group.
      throw new MemoryDenied('consent');
    }
  };

  /** Only for proposals from a run that read third-party content (§11.2 taint rule); spec 05 removed the sensitive card. */
  const sendConfirmCard = (scope: Scope, id: string, text: string): void => {
    if (scope.kind !== 'user') return;
    const u = s.repos.users.getById(scope.userId);
    if (!u?.dmChatId) return;
    const ru = uiLang(u.languageCode) === 'ru';
    const R = s.telegram.render;
    const cb = (a: 'y' | 'n') => s.telegram.codec.encode('mm', ['cf', id, a], u.tgUserId);
    s.telegram.outbox.enqueue({
      idempotencyKey: `mmcf:${id}`, userId: u.id, chatId: u.dmChatId, method: 'sendRichMessage', priority: 1,
      markdown: `🧠 ${ru ? 'Запомнить это?' : 'Remember this?'}\n“${R.escape(text)}”`,
      payload: { reply_markup: { inline_keyboard: [[{ text: ru ? '✓ Запомнить' : '✓ Remember', callback_data: cb('y') }, { text: ru ? '✗ Не нужно' : '✗ Don’t', callback_data: cb('n') }]] } },
    });
  };

  const ledgerUser = (scope: Scope, author: UserId | null): UserId | null => (scope.kind === 'user' ? scope.userId : author);
  const ledger = (userId: UserId | null, kind: 'memory_saved' | 'memory_forgotten', summary: string, detail: Record<string, unknown>): void => {
    if (!userId) return;
    try {
      s.ledger.append({ userId, actor: kind === 'memory_forgotten' ? 'user' : 'agent', kind, summary, detail });
    } catch (e) {
      log().warn({ err: errorMessage(e) }, 'ledger append failed');
    }
  };

  const newId = (): string => {
    for (let i = 0; i < 50; i++) {
      const id = factId();
      if (!repo().exists(id)) return id;
    }
    throw new Error('could not allocate a fact id');
  };

  /** A quote with every fingerprinted (forgotten) sentence removed; null when nothing is left. */
  const cleanQuote = (scope: Scope, quote: string): string | null => {
    const set = fps(scope);
    const parts = sentences(quote);
    const kept = (set.size ? parts.filter((x) => !probeGrams(x).some((g) => set.has(s.crypto.hmac('fp', g)))) : parts).join(' ').trim();
    return kept ? kept : null;
  };

  /**
   * Rotates the scope's memory generation (§9 forget step 3): re-encrypts every remaining row under gen+1, then destroys
   * the old DEKs. Quotes are re-filtered against the fingerprints on the way, and the quotes of rows whose source input
   * is in `dropQuotesOf` (the inputs a forget deletes) are dropped: a sibling fact must not keep the forgotten sentence.
   */
  const rotate = (scope: Scope, dropQuotesOf: ReadonlySet<string> = new Set()): number => {
    const sk = scopeKey(scope);
    const oldGen = currentGen(scope);
    const newGen = oldGen + 1;
    const oldGens = new Set<number>([...repo().distinctGens(sk), oldGen]);
    const now = s.clock.now();
    s.db.tx(() => {
      for (const row of repo().withText(sk)) {
        let text: string | null;
        let subject: string | null;
        let quote: string | null;
        try {
          text = open(row.textEnc, 'text_enc', row.id);
          subject = open(row.subjectEnc, 'subject_enc', row.id);
          quote = open(row.quoteEnc, 'quote_enc', row.id);
        } catch (e) {
          // unreadable already (its DEK is gone): drop the ciphertext rather than keep an orphan
          log().warn({ factId: row.id, err: errorMessage(e) }, 'rotation: unreadable fact dropped');
          repo().markForgotten(row.id, now);
          continue;
        }
        if (text === null) continue;
        if (quote !== null) quote = row.sourceInputId && dropQuotesOf.has(row.sourceInputId) ? null : cleanQuote(scope, quote);
        repo().setText(
          row.id,
          seal(scope, newGen, 'text_enc', row.id, text),
          subject === null ? null : seal(scope, newGen, 'subject_enc', row.id, subject),
          quote === null ? null : seal(scope, newGen, 'quote_enc', row.id, quote),
          newGen,
          null,
        );
      }
      vectors.reseal(scope, newGen);
      if (scope.kind === 'user') s.repos.users.update(scope.userId, { memoryGen: newGen });
      else {
        try {
          for (let g = s.groups.memoryGen(scope.chatId); g < newGen; ) g = s.groups.bumpMemoryGen(scope.chatId);
        } catch (e) {
          log().warn({ err: errorMessage(e) }, 'group memory_gen bump failed; the table generation is authoritative');
        }
      }
    });
    for (const g of oldGens) if (g < newGen) s.crypto.destroyDek(dekFor(scope, g));
    touch(sk);
    return newGen;
  };

  /** Records the facts a run saw (run_memory_uses: forget rotates every conversation that saw a fact) and bumps their use counts once per run. */
  const recordUses = (runId: string | null | undefined, chosen: readonly Fact[]): void => {
    if (!runId || !chosen.length) return;
    const ids = chosen.map((f) => f.row.id);
    const now = s.clock.now();
    // A run builds several context rows and may search too; a fact counts as used once per run.
    let already = new Set<string>();
    try {
      already = new Set(s.repos.runs.memoryUses(runId).map((m) => m.factId));
      s.repos.runs.recordMemoryUses(runId, ids);
    } catch (e) {
      log().warn({ err: errorMessage(e) }, 'recordMemoryUses failed');
    }
    const fresh = chosen.filter((f) => !already.has(f.row.id));
    repo().bumpUses(fresh.map((f) => f.row.id), now);
    for (const f of fresh) {
      f.row.useCount += 1;
      f.row.lastUsedAt = now;
    }
  };

  /** Superseded facts matching a forget query (they keep their text, so "forget X" must be able to reach them). */
  const supersededMatches = (scope: Scope, query: string): Fact[] => {
    const lang = langOf(scope);
    const facts = repo()
      .byScope(scopeKey(scope), ['superseded'])
      .map((r) => decrypt(r, lang))
      .filter((f): f is Fact => f !== null);
    if (!facts.length) return [];
    const df = new Map<string, number>();
    let total = 0;
    for (const f of facts) {
      total += f.toks.length;
      for (const t of new Set(f.toks)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const raw = bm25(tokens(query, lang), facts, df, total / facts.length || 1);
    const max = Math.max(0, ...raw);
    const needle = normalize(query);
    return facts.filter((f, i) => (max > 0 && raw[i]! / max >= 0.5) || (!!needle && normalize(f.text).includes(needle)));
  };

  const store = {
    repo,
    load,
    scored,
    langOf,
    tzOf,
    toHit,
    isFingerprinted,
    currentGen,

    /** MemoryService.save with the internal options the extractor / importer / tools need. */
    save(scope: Scope, f: SaveInput, o: SaveOptions = {}): SaveResult {
      try {
        const text = f.text.replace(/\s+/g, ' ').trim();
        if (!text) throw new RangeError('fact text is empty');
        if (text.length > MAX_FACT_TEXT) throw new RangeError(`fact text is longer than ${MAX_FACT_TEXT} characters`);
        gate(scope, f.source, f.explicit);
        if (isFingerprinted(scope, text)) throw new MemoryDenied('fingerprint');
        const sk = scopeKey(scope);
        const l = load(scope);
        const norm = normalize(text);
        const now = o.now ?? s.clock.now();
        const dupe = l.facts.find((x) => normalize(x.text) === norm && alive(x, now));
        if (dupe) return { id: dupe.row.id, status: dupe.row.status === 'pending_confirm' ? 'pending_confirm' : 'active' };
        // spec 05 B1: no ✓/✗ card for sensitive facts (callers decide: the extractor keeps only plainly stated ones); a
        // proposal from a tainted run or an import still waits for the owner's tap
        const status: 'active' | 'pending_confirm' = o.forcePending ? 'pending_confirm' : 'active';
        const importance = f.importance ?? 0.5;
        const expiresAt = f.expiresAt !== undefined && f.expiresAt !== null && Number.isFinite(f.expiresAt) && f.expiresAt > now ? f.expiresAt : null;
        const supersedes = o.supersedesId ? l.facts.find((x) => x.row.id === o.supersedesId && x.row.status === 'active')?.row.id ?? null : null;
        let victim: string | undefined;
        if (status === 'active' && !supersedes && repo().countActive(sk) >= MAX_ACTIVE_FACTS) {
          victim = repo().overflowVictim(sk);
          if (!victim) throw new MemoryDenied('limit');
        }
        const id = newId();
        const gen = currentGen(scope);
        const subject = f.subject?.trim() ? f.subject.trim().slice(0, 100) : null;
        const quote = f.source.quote?.trim() ? f.source.quote.trim().slice(0, 300) : null;
        s.db.tx(() => {
          repo().insert({
            id, userId: scope.kind === 'user' ? scope.userId : f.authorUserId, scope: sk, kind: f.kind, textEnc: seal(scope, gen, 'text_enc', id, text),
            subjectEnc: subject ? seal(scope, gen, 'subject_enc', id, subject) : null, quoteEnc: quote ? seal(scope, gen, 'quote_enc', id, quote) : null, dekGen: gen,
            sensitivity: f.sensitivity, confidence: o.confidence ?? 1, pinned: false, status, sourceKind: f.source.kind,
            sourceConversationId: f.source.conversationId ?? null, sourceInputId: f.source.inputId ?? null, sourceTgMessageId: f.source.tgMessageId ?? null,
            createdBy: o.createdBy ?? (f.source.kind === 'import' ? 'import' : f.source.kind === 'miniapp' ? 'user' : 'model_tool'), supersedesId: supersedes, now,
            importance, expiresAt,
          });
          if (supersedes) repo().casStatus(supersedes, 'active', 'superseded', now);
          if (victim) repo().casStatus(victim, 'active', 'superseded', now);
        });
        touch(sk);
        const gone = [supersedes, victim].filter((x): x is string => !!x);
        if (gone.length) vectors.drop(scope, gone);
        ledger(ledgerUser(scope, f.authorUserId), 'memory_saved', status === 'active' ? 'Memory saved' : 'Memory awaiting confirmation', { id, kind: f.kind, status });
        if (status === 'pending_confirm' && !o.noCard) sendConfirmCard(scope, id, text);
        if (status === 'active') {
          scheduleEmbed(scope);
          if (scope.kind === 'user') maybeConsolidate(scope.userId);
        }
        return { id, status };
      } catch (e) {
        if (e instanceof MemoryDenied) return { denied: e.reason };
        throw e;
      }
    },

    /**
     * Context retrieval (01 §9 + 05 B3): every pinned fact, then the profile-kind facts (≤ 12; skipped when a profile
     * card heads <user_model> — o.hasCard — since the card replaces them), then the best hybrid matches (≤ 8, matched by at
     * least one leg). On Groq the head fits ≤ 250 tokens and the matches ≤ 300 (02 §D / LIMITS.userModelMaxTokens).
     */
    async retrieve(scope: Scope, query: string, runId: string | null, o: { limit?: number; hasCard?: boolean } = {}): Promise<MemoryHit[]> {
      const all = await ranked(scope, query);
      if (!all.length) return [];
      const groq = s.profile ? s.profile.id !== 'anthropic' : s.config.profile.id !== 'anthropic';
      const lang = langOf(scope);
      const tz = tzOf(scope);
      const line = (f: Fact) => estimateTokens(`- [${f.row.id}] (${f.row.kind}) ${f.text} — ${sourceLabel(f.row, lang, tz)}`) + 2;
      const byScore = [...all].sort((a, b) => b.score - a.score || b.f.row.importance - a.f.row.importance || b.f.row.createdAt - a.f.row.createdAt);
      const pinned = byScore.filter((x) => x.f.row.pinned);
      const profile = o.hasCard ? [] : byScore.filter((x) => !x.f.row.pinned && x.f.row.kind === 'profile').slice(0, MAX_PROFILE_FACTS);
      const firstIds = new Set([...pinned, ...profile].map((x) => x.f.row.id));
      const others = byScore.filter((x) => !firstIds.has(x.f.row.id) && x.score > 0).slice(0, MAX_OTHER_FACTS);
      const cap = Math.min(MAX_HITS, o.limit ?? MAX_HITS);
      const chosen: Fact[] = [];
      // with a card, the card is the head (≤ 250, rendered by memory/context.ts) and pinned facts share the facts budget
      const head = o.hasCard ? [] : [...pinned, ...profile];
      const rest = o.hasCard ? [...pinned, ...others] : others;
      let budgetA = GROQ_PINNED_TOKENS;
      for (const x of head) {
        if (chosen.length >= cap) break;
        if (groq) {
          const t = line(x.f);
          if (t > budgetA) continue;
          budgetA -= t;
        }
        chosen.push(x.f);
      }
      let budgetB = Math.min(GROQ_RETRIEVED_TOKENS, LIMITS.userModelMaxTokens);
      for (const x of rest) {
        if (chosen.length >= cap) break;
        if (groq) {
          const t = line(x.f);
          if (t > budgetB) continue;
          budgetB -= t;
        }
        chosen.push(x.f);
      }
      recordUses(runId, chosen);
      return chosen.map((f) => toHit(f, lang, tz));
    },

    /** memory_search: the hits land in the run's transcript, so they are recorded in run_memory_uses like retrieve()'s. */
    async search(scope: Scope, query: string, limit: number, kind?: FactKind, runId?: string | null): Promise<MemoryHit[]> {
      const lang = langOf(scope);
      const tz = tzOf(scope);
      const n = Math.max(1, Math.min(MAX_HITS, Math.floor(limit) || 8));
      let rows: ScoredFact[] = query.trim() ? await ranked(scope, query) : scored(scope, '').map((x) => ({ f: x.f, bm: 0, score: 0 }));
      rows = rows.filter((x) => !kind || x.f.row.kind === kind);
      if (query.trim()) rows = rows.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
      else rows = rows.sort((a, b) => b.f.row.createdAt - a.f.row.createdAt);
      const chosen = rows.slice(0, n).map((x) => x.f);
      recordUses(runId, chosen);
      return chosen.map((f) => toHit(f, lang, tz));
    },

    list(scope: Scope, q: { kind?: FactKind; query?: string; cursor?: string; limit: number }): { items: MemoryFactView[]; next?: string } {
      const lang = langOf(scope);
      const tz = tzOf(scope);
      const now = s.clock.now();
      let facts = load(scope).facts.filter((f) => (!q.kind || f.row.kind === q.kind) && alive(f, now));
      if (q.query?.trim()) {
        const hit = new Set(scored(scope, q.query).filter((x) => x.bm > 0).map((x) => x.f.row.id));
        const needle = normalize(q.query);
        // a query of only punctuation / emoji normalizes to '' (which every text "includes"): it matches nothing
        facts = facts.filter((f) => hit.has(f.row.id) || (!!needle && normalize(f.text).includes(needle)));
      }
      facts = [...facts].sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || b.row.createdAt - a.row.createdAt || (a.row.id < b.row.id ? 1 : -1));
      const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
      const limit = Math.max(1, Math.min(100, q.limit));
      const page = facts.slice(offset, offset + limit).map((f) => toView(f, lang, tz));
      return offset + limit < facts.length ? { items: page, next: String(offset + limit) } : { items: page };
    },

    getMany(scope: Scope, ids: string[]): MemoryHit[] {
      const want = new Set(ids);
      const lang = langOf(scope);
      const tz = tzOf(scope);
      const now = s.clock.now();
      return load(scope)
        .facts.filter((f) => f.row.status === 'active' && want.has(f.row.id) && alive(f, now))
        .map((f) => toHit(f, lang, tz));
    },

    /** A fact the user may edit / confirm / forget: their own scope, or a group fact they authored. */
    ownFact(userId: UserId, id: string): { scope: Scope; row: FactRow } | undefined {
      const row = repo().get(id.trim());
      if (!row || row.status === 'forgotten') return undefined;
      if (row.scope === scopeKey({ kind: 'user', userId })) return { scope: { kind: 'user', userId }, row };
      if (row.scope.startsWith('grp:') && row.userId === userId) return { scope: { kind: 'group', chatId: Number(row.scope.slice(4)) }, row };
      return undefined;
    },

    edit(userId: UserId, id: string, patch: { text?: string; pinned?: boolean }): void {
      const own = store.ownFact(userId, id);
      if (!own) throw new RangeError(`no fact ${id}`);
      const { scope, row } = own;
      const now = s.clock.now();
      if (patch.text !== undefined) {
        const text = patch.text.replace(/\s+/g, ' ').trim();
        if (!text || text.length > MAX_FACT_TEXT) throw new RangeError(`fact text must be 1..${MAX_FACT_TEXT} characters`);
        const gen = currentGen(scope);
        const f = decrypt(row, langOf(scope));
        s.db.tx(() =>
          repo().setText(
            row.id,
            seal(scope, gen, 'text_enc', row.id, text),
            f?.subject ? seal(scope, gen, 'subject_enc', row.id, f.subject) : null,
            f?.quote ? seal(scope, gen, 'quote_enc', row.id, f.quote) : null,
            gen,
            now,
          ),
        );
        vectors.drop(scope, [row.id]);
        if (row.status === 'active') scheduleEmbed(scope);
      }
      if (patch.pinned !== undefined) repo().setPinned(row.id, patch.pinned, now);
      touch(scopeKey(scope));
      ledger(userId, 'memory_saved', patch.text !== undefined ? 'Memory edited' : patch.pinned ? 'Memory pinned' : 'Memory unpinned', { id: row.id });
    },

    confirm(userId: UserId, ids: string[], accept: boolean): Array<{ id: string; status: 'active' | 'rejected' | 'denied' | 'skipped' }> {
      const out: Array<{ id: string; status: 'active' | 'rejected' | 'denied' | 'skipped' }> = [];
      for (const id of ids) {
        const own = store.ownFact(userId, id);
        if (!own || own.row.status !== 'pending_confirm') {
          out.push({ id, status: 'skipped' });
          continue;
        }
        const { scope, row } = own;
        const now = s.clock.now();
        if (accept) {
          try {
            gate(scope, { kind: row.sourceKind }, true);
          } catch {
            out.push({ id, status: 'denied' });
            continue;
          }
          const sk = scopeKey(scope);
          if (repo().countActive(sk) >= MAX_ACTIVE_FACTS) {
            const v = repo().overflowVictim(sk);
            if (!v) {
              out.push({ id, status: 'denied' });
              continue;
            }
            repo().casStatus(v, 'active', 'superseded', now);
          }
          repo().casStatus(row.id, 'pending_confirm', 'active', now);
          ledger(userId, 'memory_saved', 'Memory confirmed', { id: row.id });
          scheduleEmbed(scope);
          out.push({ id, status: 'active' });
        } else {
          // A rejected candidate is dropped for good: its text is nulled and fingerprinted so it is not proposed again.
          const f = decrypt(row, langOf(scope));
          s.db.tx(() => {
            repo().markForgotten(row.id, now);
            if (f) repo().addFingerprints(scopeKey(scope), fingerprintGrams(f.text).map((g) => s.crypto.hmac('fp', g)), now);
          });
          fpCache.delete(scopeKey(scope));
          out.push({ id, status: 'rejected' });
        }
        touch(scopeKey(scope));
      }
      return out;
    },

    /** Every fact of the scope that still holds text (active, pending and superseded), newest first: the data export. */
    exportFacts(scope: Scope): Fact[] {
      const lang = langOf(scope);
      return repo()
        .byScope(scopeKey(scope), ['active', 'pending_confirm', 'superseded'])
        .map((r) => decrypt(r, lang))
        .filter((f): f is Fact => f !== null)
        .sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || b.row.createdAt - a.row.createdAt || (a.row.id < b.row.id ? 1 : -1));
    },

    /** Facts selected by ids (any status but forgotten) or by query (active, plus matching pending and superseded) within the scope, with their texts. */
    select(scope: Scope, sel: { ids?: string[]; query?: string }): Fact[] {
      if (sel.ids?.length) {
        // by id: any fact of the scope that still has text (active, pending or superseded)
        const sk = scopeKey(scope);
        const lang = langOf(scope);
        return [...new Set(sel.ids.map((x) => x.trim()))]
          .map((id) => repo().get(id))
          .filter((r): r is FactRow => !!r && r.scope === sk && r.status !== 'forgotten')
          .map((r) => decrypt(r, lang))
          .filter((f): f is Fact => f !== null);
      }
      if (sel.query?.trim()) {
        // a query of only punctuation / emoji normalizes to '' (which every text "includes"): no substring matching then
        const needle = normalize(sel.query);
        const pend = needle ? load(scope).facts.filter((f) => f.row.status === 'pending_confirm' && normalize(f.text).includes(needle)) : [];
        const act = scored(scope, sel.query)
          .filter((x) => x.bm >= 0.5)
          .sort((a, b) => b.bm - a.bm)
          .map((x) => x.f);
        return [...act, ...pend, ...supersededMatches(scope, sel.query)].slice(0, 20);
      }
      return [];
    },

    /** §9 forget steps 1–6 for already-authorized facts of one scope. */
    forgetFacts(scope: Scope, facts: Fact[], actor: UserId | null): Array<{ id: string; preview: string }> {
      if (!facts.length) return [];
      const sk = scopeKey(scope);
      const now = s.clock.now();
      const texts = facts.map((f) => f.text);
      // B4: the owner's card removals / corrections outlive the card versions this forget deletes (read them while the
      // old generation's DEK still exists)
      let carry: ReturnType<typeof captureProfileCarry> = null;
      if (scope.kind === 'user') {
        try {
          carry = captureProfileCarry(s, scope.userId);
        } catch (e) {
          log().warn({ err: errorMessage(e) }, 'forget: profile removals unreadable');
        }
      }
      // 1 + 2: null the ciphertexts and record fingerprints, atomically
      const done: Fact[] = [];
      s.db.tx(() => {
        for (const f of facts) {
          if (!repo().markForgotten(f.row.id, now)) continue;
          repo().addFingerprints(sk, fingerprintGrams(f.text).map((g) => s.crypto.hmac('fp', g)), now);
          if (f.subject) repo().addFingerprints(sk, fingerprintGrams(`${f.subject} ${f.text}`).map((g) => s.crypto.hmac('fp', g)), now);
          done.push(f);
        }
        if (done.length) {
          vectors.repo().delete(done.map((f) => f.row.id));
          // B4 forget: every profile-card version may hold the fact → all go now; the card is rebuilt without it
          if (scope.kind === 'user') profiles().deleteAll(scope.userId);
        }
      });
      fpCache.delete(sk);
      touch(sk);
      vectors.invalidate(scope);
      if (!done.length) return [];
      // 3: rotate the generation (old DEK destroyed); sibling facts of the same source input lose their verbatim quote
      rotate(scope, new Set(done.flatMap((f) => (f.row.sourceInputId ? [f.row.sourceInputId] : []))));
      if (scope.kind === 'user') {
        const keep = (xs: string[]) => store.filterFingerprinted(scope, xs);
        if (carry) {
          try {
            restoreProfileCarry(s, scope.userId, carry, keep);
          } catch (e) {
            log().warn({ err: errorMessage(e) }, 'forget: profile removals not carried');
          }
        }
        // other modules' derived copies of the text (the proactive log): scrubbed through the new fingerprints
        for (const h of s.privacyHooks) {
          try {
            h.onForget?.(scope.userId, { texts, keep });
          } catch (e) {
            log().warn({ hook: h.name, err: errorMessage(e) }, 'forget: privacy hook failed');
          }
        }
      }
      // 4: the source inputs go
      for (const f of done) {
        if (!f.row.sourceInputId) continue;
        try {
          s.repos.inputs.delete(f.row.sourceInputId);
        } catch (e) {
          log().warn({ err: errorMessage(e) }, 'forget: source input delete failed');
        }
      }
      // 5: every conversation that used a fact, and the source conversation, rotates to a new epoch (old one shredded)
      const convs = new Set<string>();
      for (const f of done) {
        if (f.row.sourceConversationId) convs.add(f.row.sourceConversationId);
        try {
          for (const c of s.repos.runs.conversationsUsingFact(f.row.id)) convs.add(c.conversationId);
        } catch (e) {
          log().warn({ err: errorMessage(e) }, 'forget: conversationsUsingFact failed');
        }
      }
      for (const c of convs) {
        try {
          s.runner.requestRotation(c, 'forget', { excludeTexts: texts });
        } catch (e) {
          log().warn({ conversationId: c, err: errorMessage(e) }, 'forget: rotation request failed');
        }
      }
      // B4: rebuild the profile card from the remaining facts (never from the old card)
      if (scope.kind === 'user') scheduleConsolidate(scope.userId, 'forget');
      // 6: ledger, id only
      const who = scope.kind === 'user' ? scope.userId : actor;
      for (const f of done) ledger(who, 'memory_forgotten', 'Memory forgotten', { id: f.row.id });
      return done.map((f) => ({ id: f.row.id, preview: f.text.length > 60 ? `${f.text.slice(0, 59)}…` : f.text }));
    },

    filterFingerprinted(scope: Scope, sentences: string[]): string[] {
      const set = fps(scope);
      if (!set.size) return [...sentences];
      return sentences.filter((x) => !probeGrams(x).some((g) => set.has(s.crypto.hmac('fp', g))));
    },

    invalidate(scope: Scope): void {
      touch(scopeKey(scope));
      fpCache.delete(scopeKey(scope));
      vectors.invalidate(scope);
    },

    ranked,
    recordUses,
    vectors,
    profiles,
    scheduleEmbed,
    alive,

    /**
     * The memory_embed job body: embeds (e5 'passage') every live fact of the scope that has no vector for the current
     * model, in batches of EMBED_BATCH, and drops vectors of facts that lost their text. Returns the number embedded;
     * null when the embedder is unavailable (retried lazily by the next save / retrieval).
     */
    async embedMissing(scope: Scope, signal?: AbortSignal): Promise<number | null> {
      const e = embedderOf(s);
      if (!e || e.dim <= 0) return null;
      vectors.dropStale(scope);
      let done = 0;
      for (let round = 0; round < 100; round++) {
        if (signal?.aborted) return done;
        const now = s.clock.now();
        const have = vectors.load(scope, currentGen(scope), e.model, e.dim);
        const missing = load(scope).facts.filter((f) => f.row.status === 'active' && alive(f, now) && !have.has(f.row.id)).slice(0, EMBED_BATCH);
        if (!missing.length) return done;
        const vs = await e.embed(missing.map((f) => f.text), 'passage', signal ? { signal } : {});
        if (!vs || vs.length !== missing.length) return done || null;
        const gen = currentGen(scope);
        for (let i = 0; i < missing.length; i++) {
          const f = missing[i]!;
          // the fact may have been forgotten, edited or superseded while the model ran: never store a vector for it then
          const cur = repo().get(f.row.id);
          if (!cur || cur.status !== 'active' || !cur.textEnc || cur.updatedAt !== f.row.updatedAt || cur.dekGen !== gen) continue;
          try {
            vectors.put(scope, scope.kind === 'user' ? scope.userId : f.row.userId, f.row.id, gen, e.model, vs[i]!);
            done++;
          } catch (err) {
            log().warn({ factId: f.row.id, err: errorMessage(err) }, 'embedding not stored');
            return done;
          }
        }
      }
      return done;
    },

    /** Retention: deletes facts whose TTL passed (B1 mood/context signals), with their vectors. */
    sweepExpired(now: Ms): number {
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const rows = repo().expired(now);
        if (!rows.length) break;
        // the owner's card may have copied a mood / context fact: its items go with the fact (scrubExpired below)
        const byUser = new Map<UserId, string[]>();
        for (const r of rows) {
          const sc = parseScopeKey(r.scope);
          if (sc?.kind !== 'user') continue;
          try {
            const text = load(sc).facts.find((f) => f.row.id === r.id)?.text;
            if (text) byUser.set(sc.userId, [...(byUser.get(sc.userId) ?? []), text]);
          } catch (e) {
            log().warn({ err: errorMessage(e) }, 'expired fact unreadable');
          }
        }
        s.db.tx(() => {
          n += repo().deleteFacts(rows.map((r) => r.id));
        });
        for (const [userId, texts] of byUser) {
          try {
            scrubExpired(s, userId, texts);
          } catch (e) {
            log().warn({ err: errorMessage(e) }, 'profile card not scrubbed of expired facts');
          }
        }
        for (const sk of new Set(rows.map((r) => r.scope))) {
          versions.set(sk, (versions.get(sk) ?? 0) + 1);
          cache.delete(sk);
        }
      }
      return n;
    },
  };

  /** B4 trigger: ≥ LIMITS.profileConsolidateAfterFacts active facts created since the last card version. */
  function maybeConsolidate(userId: UserId): void {
    try {
      const last = profiles().latest(userId);
      if (repo().countActiveSince(scopeKey({ kind: 'user', userId }), last?.createdAt ?? 0) >= LIMITS.profileConsolidateAfterFacts) scheduleConsolidate(userId, 'facts');
    } catch (e) {
      log().warn({ err: errorMessage(e) }, 'consolidation trigger failed');
    }
  }
  function scheduleConsolidate(userId: UserId, reason: 'facts' | 'forget'): void {
    try {
      s.scheduler.schedule({
        kind: 'profile_consolidate', runAt: s.clock.now(), userId, refId: userId, dedupeKey: reason === 'forget' ? consolidateForgetKey(userId) : consolidateKey(userId),
        payload: { reason }, priority: 7, maxAttempts: 4,
      });
    } catch (e) {
      log().warn({ err: errorMessage(e) }, 'profile_consolidate schedule failed');
    }
  }
  return store;
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
