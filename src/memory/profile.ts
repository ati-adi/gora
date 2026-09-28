// memory/profile.ts (friend mode, spec 05 B4/B5) — createProfileService: the owner's profile card in `user_profile`.
//  - get(): the latest version, opened from its seal (memory DEK 'm:<userId>:<gen>'); null when none / shredded.
//  - consolidate(): ONE fast-role structured call (SideCalls.structured purpose 'consolidate') rewrites the card from the
//    owner's active, unexpired, non-sensitive facts (and the previous card, except after a forget). Skipped when memory
//    is off / incognito, the LLM budget says no ('background', 03 R6: paused at ≥ 85%), nothing changed since the last
//    card (nightly), or a card was already written in the last 20 h (≤ 1 per user per day, except forget / manual).
//    A forget already deleted every version (memory/store.ts forgetFacts); the rebuild never sees the old card, and a
//    result whose memory generation changed while the model ran (a forget in between) is discarded.
//    Every card item is filtered through the forget fingerprints and the owner's removals before it is sealed.
//  - edit(): Mini App delete / correct → a new version (reason 'edit'). A delete ERASES (05 "see, correct and erase"): the
//    facts that support the deleted item are forgotten (01 §9: fingerprints, rotation, rebuild) and the item is kept only
//    as a removal signature (HMACs of its word tokens, never its text), which drops a reworded copy from every later card
//    and is never sent to the model. Corrections are kept verbatim so the model keeps them as written.
//  - Removals and corrections survive a forget: forgetFacts() deletes every card version, then writes a "tombstone" row
//    (no card, just the signatures and the corrections that hold no forgotten text) under the new generation.
//  - An expired short-lived fact (B1 TTL) takes the card items it supports with it (scrubExpired, from the TTL sweep).
//  - dueThreads(): open threads whose follow_up_after_local passed (owner tz), for the proactive follow_up arm (C4).
// The profile_consolidate job (per user + the hourly nightly sweep) is registered by memory/index.ts and calls
// s.userProfile.consolidate at call time.
import type { Ms, UserId } from '../contracts/common.ts';
import type { ProfileCard, ProfileEdit, ProfileService, ProfileThread, ProfileView } from '../contracts/memory.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import type { Services } from '../contracts/services.ts';
import { scopeKey } from '../contracts/common.ts';
import { errorMessage } from '../kernel/errors.ts';
import { isoWithOffset, wallTimeOf } from '../kernel/timeMath.ts';
import {
  cardTexts, clampCard, CONSOLIDATE_SYSTEM, consolidateUserMessage, emptyCard, filterCard, instantOfLocal, ProfileCardSchema, similar, type ConsolidateFact,
} from './consolidate.ts';
import { storeOf } from './impl.ts';
import { createProfileRepo, profileAad, type ProfileReason, type ProfileRepo } from './profileRepo.ts';
import { tokens } from './text.ts';

const HOUR = 3_600_000;
/** ≤ 1 consolidation per user per day: a nightly / facts run within this window of the last one is skipped. */
export const CONSOLIDATE_MIN_GAP_MS = 20 * HOUR;
export const KEEP_VERSIONS = 3;
const MAX_REMOVED = 30;
const MAX_CORRECTED = 30;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Input limits of the consolidation call (Groq free tier: small; 02 §D). */
const LIMITS_GROQ = { maxFacts: 80, maxChars: 6_000, maxTokens: 900 };
const LIMITS_ANTHROPIC = { maxFacts: 300, maxChars: 24_000, maxTokens: 1_500 };

/**
 * The sealed payload. `removedSig`: per removed item, the HMACs of its word tokens (memory/text.ts tokens) — enough to
 * recognize a reworded copy (Jaccard ≥ REMOVED_SIMILARITY), useless to the model and never put in a prompt. `removed`:
 * the verbatim texts of versions written before signatures existed (read, converted, never written again).
 * `tombstone`: no card, only the carried removals / corrections (after a forget, until the rebuild).
 */
interface Sealed { v: 1; card: ProfileCard; removed?: string[]; removedSig?: string[][]; corrected: string[]; tombstone?: boolean }
interface Opened { view: ProfileView; removedSig: string[][]; corrected: string[]; tombstone: boolean }
/** What a forget carries from the old card to the tombstone. */
export interface ProfileCarry { removedSig: string[][]; corrected: string[] }

/** A reworded removed item still counts as removed at this token overlap (the same bar as consolidate.ts similar()). */
const REMOVED_SIMILARITY = 0.6;
/** A fact "supports" a card item (and goes with it) when this share of the smaller token set is in the other. */
const SUPPORT_CONTAINMENT = 0.75;

const dekOf = (userId: UserId, gen: number) => `m:${userId}:${gen}`;
const tokenSet = (text: string, lang: string) => new Set(tokens(text, lang));

function sigOf(s: Services, text: string, lang: string): string[] {
  return [...tokenSet(text, lang)].map((t) => s.crypto.hmac('fp', `profile-removed:${t}`).slice(0, 24)).sort();
}
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  let n = 0;
  for (const x of new Set(a)) if (B.has(x)) n++;
  return n / (new Set(a).size + B.size - n);
}
/** Whether `fact` supports `item`: the same thing reworded, or (≥ 2 tokens) one mostly contained in the other. */
export function supports(item: string, fact: string, lang: string): boolean {
  const A = tokenSet(item, lang);
  const B = tokenSet(fact, lang);
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  if (n / (A.size + B.size - n) >= REMOVED_SIMILARITY) return true;
  const small = Math.min(A.size, B.size);
  return small >= 2 && n / small >= SUPPORT_CONTAINMENT;
}

function genOf(s: Services, userId: UserId): number {
  const st = storeOf(s);
  return st ? st.currentGen({ kind: 'user', userId }) : (s.repos.users.getById(userId)?.memoryGen ?? 1);
}

function openLatest(s: Services, userId: UserId): Opened | null {
  const row = createProfileRepo(s.db).latest(userId);
  if (!row) return null;
  if (s.crypto.isDestroyed(dekOf(userId, row.dekGen))) return null;
  try {
    const sealed = s.crypto.openJson<Sealed>(row.profileEnc, profileAad(userId, row.version));
    const card: ProfileCard = { ...emptyCard(), ...sealed.card };
    const lang = s.repos.users.getById(userId)?.languageCode ?? 'en';
    const removedSig = [...(sealed.removedSig ?? []), ...(sealed.removed ?? []).map((t) => sigOf(s, t, lang))];
    return {
      view: { userId, version: row.version, card, factCount: row.factCount, createdAt: row.createdAt },
      removedSig, corrected: sealed.corrected ?? [], tombstone: sealed.tombstone === true,
    };
  } catch (e) {
    s.log.child({ mod: 'memory', sub: 'profile' }).warn({ userId, err: errorMessage(e) }, 'profile card could not be opened');
    return null;
  }
}

function writeVersion(s: Services, userId: UserId, sealed: Sealed, reason: ProfileReason, factCount: number, gen: number, o: { keep?: number; ledger?: boolean } = {}): ProfileView {
  const repo = createProfileRepo(s.db);
  const now = s.clock.now();
  const dek = dekOf(userId, gen);
  let version = 0;
  s.db.tx(() => {
    version = repo.maxVersion(userId) + 1;
    s.crypto.ensureDek(dek, userId, 'memory');
    repo.insert({ userId, version, profileEnc: s.crypto.sealJson(dek, sealed, profileAad(userId, version)), dekGen: gen, factCount, reason, createdAt: now });
    repo.prune(userId, o.keep ?? KEEP_VERSIONS);
  });
  if (o.ledger !== false) {
    try {
      s.ledger.append({ userId, actor: reason === 'edit' ? 'user' : 'agent', kind: 'profile_updated', summary: 'Profile card updated', detail: { version, reason } });
    } catch (e) {
      s.log.child({ mod: 'memory', sub: 'profile' }).warn({ err: errorMessage(e) }, 'ledger append failed');
    }
  }
  return { userId, version, card: sealed.card, factCount, createdAt: now };
}

/** forgetFacts, BEFORE it deletes the versions (the old generation's DEK still opens them): what the owner removed / corrected. */
export function captureProfileCarry(s: Services, userId: UserId): ProfileCarry | null {
  const cur = openLatest(s, userId);
  return cur && (cur.removedSig.length || cur.corrected.length) ? { removedSig: cur.removedSig, corrected: cur.corrected } : null;
}

/**
 * forgetFacts, AFTER the versions went and the generation rotated: a tombstone under the new generation that keeps the
 * removals (signatures only) and the corrections that hold none of the forgotten text (`keep` = the fingerprint filter).
 */
export function restoreProfileCarry(s: Services, userId: UserId, carry: ProfileCarry, keep: (texts: string[]) => string[]): void {
  const corrected = keep(carry.corrected);
  if (!carry.removedSig.length && !corrected.length) return;
  writeVersion(s, userId, { v: 1, card: emptyCard(), removedSig: carry.removedSig.slice(0, MAX_REMOVED), corrected, tombstone: true }, 'edit', 0, genOf(s, userId), { ledger: false });
}

/**
 * The B1 TTL sweep deleted short-lived facts (mood, context): every card item they support goes too, in a new version
 * that replaces all older ones (they still hold the expired text). No LLM call; the next nightly run starts from it.
 */
export function scrubExpired(s: Services, userId: UserId, texts: readonly string[]): boolean {
  if (!texts.length) return false;
  const cur = openLatest(s, userId);
  if (!cur || cur.tombstone) return false;
  const lang = s.repos.users.getById(userId)?.languageCode ?? 'en';
  const before = cardTexts(cur.view.card).length;
  const card = filterCard(cur.view.card, (t) => !texts.some((x) => supports(t, x, lang)));
  if (cardTexts(card).length === before && card.summary === cur.view.card.summary) return false;
  writeVersion(s, userId, { v: 1, card, removedSig: cur.removedSig, corrected: cur.corrected }, 'edit', cur.view.factCount, genOf(s, userId), { keep: 1, ledger: false });
  return true;
}

export function createProfileService(s: Services): ProfileService {
  let repoCache: ProfileRepo | null = null;
  const repo = (): ProfileRepo => (repoCache ??= createProfileRepo(s.db));
  const log = () => s.log.child({ mod: 'memory', sub: 'profile' });
  const groq = () => (s.profile ?? s.config.profile).id !== 'anthropic';
  const inflight = new Map<UserId, Promise<ProfileView | null>>();
  const open = (userId: UserId): Opened | null => openLatest(s, userId);
  /** The current card; a tombstone (after a forget, before the rebuild) is no card. */
  const openCard = (userId: UserId): Opened | null => {
    const o = open(userId);
    return o && !o.tombstone ? o : null;
  };

  /** Drops every card item the forget fingerprints or the owner's removals reject (an owner correction always stays). */
  const scrub = (userId: UserId, card: ProfileCard, removedSig: readonly string[][], corrected: readonly string[], lang: string): ProfileCard => {
    const st = storeOf(s);
    const scope = { kind: 'user' as const, userId };
    const texts = cardTexts(card);
    const ok = new Set(st ? st.filterFingerprinted(scope, texts) : texts);
    const removed = (t: string) => {
      const sig = sigOf(s, t, lang);
      return removedSig.some((r) => jaccard(r, sig) >= REMOVED_SIMILARITY);
    };
    return filterCard(card, (t) => ok.has(t) && (corrected.some((c) => similar(c, t, lang)) || !removed(t)));
  };

  const run = async (userId: UserId, reason: 'nightly' | 'facts' | 'forget' | 'manual', signal?: AbortSignal): Promise<ProfileView | null> => {
    const now = s.clock.now();
    const u = s.repos.users.getById(userId);
    const opened = open(userId);
    // a tombstone carries the owner's removals / corrections across a forget; it is not a card
    const current = opened && !opened.tombstone ? opened : null;
    if (!u || !memoryEnabled(u, now)) return current?.view ?? null;
    const st = storeOf(s);
    if (!st) return current?.view ?? null;
    const scope = { kind: 'user' as const, userId };
    const last = repo().lastConsolidated(userId);
    if ((reason === 'nightly' || reason === 'facts') && last && now - last.createdAt < CONSOLIDATE_MIN_GAP_MS) return current?.view ?? null;
    if (reason === 'nightly' && current) {
      const changed = st.repo().lastActiveChange(scopeKey(scope));
      if (changed === null || changed <= current.view.createdAt) return current.view;
    }
    const L = groq() ? LIMITS_GROQ : LIMITS_ANTHROPIC;
    const lang = u.languageCode ?? 'en';
    const live = st
      .load(scope)
      .facts.filter((f) => f.row.status === 'active' && st.alive(f, now))
      // sensitive facts (health, finances, intimate) never reach the card: B composes proactive messages from it (05 B1)
      .filter((f) => f.row.sensitivity !== 'sensitive');
    const allActive = live.length;
    live.sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || b.row.importance - a.row.importance || b.row.updatedAt - a.row.updatedAt);
    const facts: ConsolidateFact[] = [];
    let chars = 0;
    for (const f of live) {
      if (facts.length >= L.maxFacts || chars + f.text.length > L.maxChars) break;
      chars += f.text.length;
      const w = wallTimeOf(f.row.createdAt, u.tz);
      facts.push({ id: f.row.id, kind: f.row.kind, text: f.text, pinned: f.row.pinned, date: `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}` });
    }
    if (!facts.length) return current?.view ?? null;
    if (!s.llmBudget.allow('background')) return current?.view ?? null;
    const gen = genOf(s, userId);
    // after a forget the previous card (already deleted) is never an input; corrections are kept only when no forgotten
    // text is in them; removals are signatures and never reach the model
    const keptRemoved = opened?.removedSig ?? [];
    const keptCorrected = opened ? st.filterFingerprinted(scope, opened.corrected) : [];
    const w = wallTimeOf(now, u.tz);
    const user = consolidateUserMessage({
      lang, nowLocal: `${isoWithOffset(now, u.tz)} (${WEEKDAYS[w.weekday] ?? ''})`, previous: reason === 'forget' ? null : (current?.view.card ?? null),
      removed: [], corrected: keptCorrected, facts,
    });
    const parsed = await s.side.structured(
      { purpose: 'consolidate', role: 'fast', system: CONSOLIDATE_SYSTEM, user, schema: ProfileCardSchema, maxTokens: L.maxTokens },
      { userId, priority: 'background', ...(signal ? { signal } : {}) },
    );
    if (!parsed) return openCard(userId)?.view ?? null;
    // a forget (generation rotation) or memory switched off while the model ran: this card may hold forgotten text
    const after = s.repos.users.getById(userId);
    if (genOf(s, userId) !== gen || !after || !memoryEnabled(after, s.clock.now())) {
      log().info({ userId }, 'consolidation discarded: memory changed while it ran');
      return openCard(userId)?.view ?? null;
    }
    // removals made in the Mini App while the model ran count too
    const latest = open(userId);
    const removedSig = latest && latest.removedSig.length >= keptRemoved.length ? latest.removedSig : keptRemoved;
    const card = scrub(userId, clampCard(parsed), removedSig, keptCorrected, lang);
    return writeVersion(s, userId, { v: 1, card, removedSig, corrected: keptCorrected }, reason, allActive, gen);
  };

  const editCard = (c: ProfileCard, e: ProfileEdit): { card: ProfileCard; removed: string | null; corrected: string | null } | null => {
    const card: ProfileCard = structuredClone(c);
    if (e.field === 'summary') {
      if (e.op === 'delete') return card.summary ? { card: { ...card, summary: '' }, removed: card.summary, corrected: null } : null;
      const text = e.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      return text ? { card: { ...card, summary: text }, removed: null, corrected: text } : null;
    }
    const i = e.index;
    const list = card[e.field] as unknown[];
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return null;
    const textOf = (x: unknown): string => {
      if (typeof x === 'string') return x;
      const o = x as { name?: string; relation?: string; notes?: string; text?: string; what?: string };
      if (e.field === 'people') return `${o.name ?? ''} (${o.relation ?? ''}): ${o.notes ?? ''}`;
      return o.text ?? o.what ?? '';
    };
    const before = textOf(list[i]);
    if (e.op === 'delete') {
      list.splice(i, 1);
      return { card, removed: before, corrected: null };
    }
    const text = e.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return null;
    switch (e.field) {
      case 'goals':
      case 'preferences':
        (list as string[])[i] = text;
        break;
      case 'people': {
        const p = card.people[i]!;
        // "Name (relation): notes" rewrites the whole entry; anything else replaces the notes
        const m = /^(.{1,60}?)\s*\((.{1,60}?)\)\s*[:—–-]?\s*(.*)$/.exec(text);
        card.people[i] = m ? { name: m[1]!.trim(), relation: m[2]!.trim(), notes: m[3]!.trim() } : { ...p, notes: text };
        break;
      }
      case 'current_context':
        card.current_context[i] = { ...card.current_context[i]!, text };
        break;
      case 'open_threads':
        card.open_threads[i] = { ...card.open_threads[i]!, what: text };
        break;
    }
    return { card, removed: before, corrected: text };
  };

  return {
    get(userId) {
      return openCard(userId)?.view ?? null;
    },

    consolidate(userId, o) {
      // one consolidation per user at a time (the nightly sweep and a facts / forget trigger may meet)
      const prev = inflight.get(userId);
      const next = (prev ?? Promise.resolve(null))
        .catch(() => null)
        .then(() => run(userId, o.reason, o.signal))
        .finally(() => {
          if (inflight.get(userId) === next) inflight.delete(userId);
        });
      inflight.set(userId, next);
      return next;
    },

    edit(userId, e) {
      const cur = openCard(userId);
      if (!cur) return null;
      const r = editCard(cur.view.card, e);
      if (!r) return cur.view;
      const u = s.repos.users.getById(userId);
      const lang = u?.languageCode ?? 'en';
      const scope = { kind: 'user' as const, userId };
      let card = r.card;
      const st = storeOf(s);
      if (e.op === 'delete' && e.field !== 'summary' && r.removed && st) {
        // a delete erases: the facts behind the item are forgotten (fingerprints, rotation, source inputs, rebuild).
        // forgetFacts replaces every version with a tombstone that carries the earlier removals; the edited card below
        // becomes the latest version again, under the new generation.
        const now = s.clock.now();
        const removedText = r.removed;
        const behind = st.load(scope).facts.filter((f) => f.row.status === 'active' && st.alive(f, now) && supports(removedText, f.text, lang));
        if (behind.length) {
          st.forgetFacts(scope, behind, userId);
          const texts = cardTexts(card);
          const ok = new Set(st.filterFingerprinted(scope, texts));
          card = filterCard(card, (t) => ok.has(t));
        }
      }
      // a correction replaces the old wording, which must not come back: the old text joins the removals (as a signature)
      const latest = open(userId);
      const prevSig = latest ? latest.removedSig : cur.removedSig;
      const removedSig = r.removed ? [sigOf(s, r.removed, lang), ...prevSig].slice(0, MAX_REMOVED) : prevSig;
      let corrected = (latest ? latest.corrected : cur.corrected).filter((x) => !r.removed || x !== r.removed);
      if (r.corrected) corrected = [r.corrected, ...corrected].slice(0, MAX_CORRECTED);
      return writeVersion(s, userId, { v: 1, card, removedSig, corrected }, 'edit', cur.view.factCount, genOf(s, userId));
    },

    dueThreads(userId, now): Array<ProfileThread & { index: number }> {
      const u = s.repos.users.getById(userId);
      if (!u || !memoryEnabled(u, now)) return [];
      const cur = openCard(userId);
      if (!cur) return [];
      const due: Array<ProfileThread & { index: number; at: Ms }> = [];
      cur.view.card.open_threads.forEach((t, index) => {
        if (!t.follow_up_after_local) return;
        const at = instantOfLocal(t.follow_up_after_local, u.tz, 'start');
        if (at !== null && at <= now) due.push({ ...t, index, at });
      });
      return due.sort((a, b) => a.at - b.at || a.index - b.index).map(({ at: _at, ...t }) => t);
    },
  };
}
