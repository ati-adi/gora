// behaviour/policy.ts (friend set B, spec 05 C4) — the learned proactive policy. It replaces fixed re-engagement rules.
//
// Every 30 min the `proactive_tick` job looks at each active user:
//   eligibility (active, not blocked, proactive ≠ off, outside quiet hours, llmBudget.allow('proactive'))
//   → hard stop (4 unanswered Gora-first messages, until the owner writes) → shared 24 h cap
//   → rhythm: only in the owner's learned top-30% hours → ONE decision per local day, at a slot sampled from today's
//     eligible hours weighted by the rhythm (many 30-min draws a day would inflate the send rate)
//   → content types available now (follow_up / useful / checkin / first_hint)
//   → Thompson sampling: score = θ_gap · θ_type · (1 − 0.25 · unanswered), send iff score > τ · scale(level).
// A "send" schedules a one-off `proactive_tick` sub-job `pt:<userId>` at slot + 20 min ± 20 min (s.random). The sub-job
// re-checks everything, composes ONE ≤ 2-sentence message (role main), runs the friend check (role fast) and, if the
// check passes, sends it into the DM. The arms learn only from sent messages: reply ≤ 24 h → α += 1, silence → β += 1,
// "stop" → β += 5 and proactive 'off' (signals.ts). Rhythm, style and the bandit use zero LLM calls; a send costs 2.
import type {
  GapBucket, JobResult, JobRow, Ms, ProactiveContentType, ProactiveDecision, ProactivePolicy, ProfileThread, SentRef, Services, UserId, UserRow,
} from '../contracts/index.ts';
import { memoryEnabled, PROACTIVE_LOG_PREFIX, PROACTIVE_TAU_SCALE, uiLang } from '../contracts/index.ts';
import { LIMITS } from '../config.ts';
import { newId } from '../kernel/ids.ts';
import { jitterMs } from '../kernel/random.ts';
import { formatDisplay, inQuietHours, localDay, parseLocal, wallTimeOf, zonedToInstant } from '../kernel/timeMath.ts';
import { storeOf } from '../memory/impl.ts';
import type { ProactiveRepo } from '../proactive/repo.ts';
import { monthDayOf } from '../proactive/signals.ts';
import { armLabel, gapBucketOf, othersOf, thompson, type BanditChoice } from './bandit.ts';
import { ComposeSchema, composeUser, JUDGE_SYSTEM, COMPOSE_SYSTEM, JudgeSchema, judgeUser, looksSensitive, sanitizeDraft } from './compose.ts';
import type { BehaviourRepo } from './repo.ts';
import { binOf } from './rhythm.ts';
import type { SignalsInternals } from './signals.ts';
import { styleLine } from './style.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const TICK_CRON = '*/30 * * * *';
/** A slot's decision may still happen this long after the slot started (a late tick, a restart). */
export const SLOT_GRACE_MS = 60 * MIN;
/** An item already used in a Gora-first message is not used again for this long. */
export const ITEM_REUSE_MS = 30 * DAY;
/** A follow-up older than this is stale. */
export const FOLLOW_UP_STALE_MS = 14 * DAY;
/** useful: open threads happening within this window, date facts today or tomorrow. */
export const UPCOMING_MS = 36 * HOUR;
/** first_hint is a nudge for someone who never wrote; after two of them silence is the answer. */
export const FIRST_HINT_MAX = 2;
/**
 * A user who never wrote and whose zone is only the language guess (A6 tz_source 'default') gets first_hint only within
 * this many hours (UTC hour of day) of the moment they pressed /start: they were awake then, whatever their real zone.
 */
export const FIRST_HINT_START_WINDOW_H = 2;
const DATE_CACHE_MS = 30 * MIN;

export interface ContentItem { type: ProactiveContentType; text: string | null; fp: string | null }
interface Plan { day: string; at: Ms | null; done: boolean }
interface Eval extends ProactiveDecision { gapMs?: number | null; items?: Map<ProactiveContentType, ContentItem>; choice?: BanditChoice }

export function nextTickAt(now: Ms): Ms {
  const step = LIMITS.proactiveTickMin * MIN;
  return Math.floor(now / step) * step + step;
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (owner tz) → instant, or null. */
export function localToInstant(v: string | null | undefined, tz: string): Ms | null {
  if (!v) return null;
  const w = parseLocal(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00` : v);
  return w ? zonedToInstant(w, tz).instant : null;
}

export interface PolicyInternals {
  policy: ProactivePolicy;
  job(job: JobRow, ctx: { now: Ms; signal: AbortSignal }): Promise<JobResult>;
  onSent(refId: string, sent: SentRef[]): void;
  /** Evaluate without the daily slot (tests of eligibility and the bandit). Uses s.random. */
  evaluate(u: UserRow, now: Ms, o?: { slot?: boolean; consume?: boolean }): ProactiveDecision;
  forgetUser(userId: UserId): void;
}

export function createPolicy(s: Services, repo: BehaviourRepo, sig: SignalsInternals, pro: ProactiveRepo): PolicyInternals {
  const plans = new Map<UserId, Plan>();
  const dateItems = new Map<UserId, { at: Ms; items: ContentItem[] }>();
  const threshold = (u: UserRow) => s.config.proactive.tau * PROACTIVE_TAU_SCALE[u.proactiveLevel];
  const fpOf = (userId: UserId, text: string) => s.crypto.hmac('content', `beh-item:${userId}:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`).slice(0, 16);

  function lastInbound(userId: UserId): Ms | null {
    return s.signals.lastInboundAt(userId);
  }

  /** Earlier proactive texts minus anything the owner has since told Gora to forget (01 §9 fingerprints). */
  function forgetFiltered(userId: UserId, texts: string[]): string[] {
    const st = storeOf(s);
    return st ? st.filterFingerprinted({ kind: 'user', userId }, texts) : texts;
  }

  function eligibility(u: UserRow, now: Ms): string | null {
    if (u.status !== 'active') return `not_eligible:${u.status}`;
    if (u.botBlocked) return 'not_eligible:blocked';
    // someone known only from a group, a guest query or a business chat never opened the DM: Gora cannot write first
    if (u.dmChatId === null) return 'not_eligible:no_dm';
    if (u.proactiveLevel === 'off') return 'not_eligible:off';
    const st = s.repos.users.settings(u.id);
    if (inQuietHours(now, u.tz, st.quietStart, st.quietEnd)) return 'not_eligible:quiet';
    if (!s.llmBudget.allow('proactive')) return 'not_eligible:budget';
    return null;
  }

  /** Today's decision slot: one half-hour among the remaining eligible top hours, weighted by the rhythm rate. */
  function planFor(u: UserRow, now: Ms, lambda: Float64Array, top: Set<number>): Plan {
    const day = localDay(now, u.tz);
    const cur = plans.get(u.id);
    if (cur && cur.day === day) return cur;
    const st = s.repos.users.settings(u.id);
    const w = wallTimeOf(now, u.tz);
    const cands: Array<{ at: Ms; weight: number }> = [];
    for (let h = 0; h < 24; h++) {
      const bin = w.weekday * 24 + h;
      if (!top.has(bin)) continue;
      for (const minute of [0, 30]) {
        const at = zonedToInstant({ year: w.year, month: w.month, day: w.day, hour: h, minute }, u.tz).instant;
        if (at + 30 * MIN <= now) continue; // already over
        if (localDay(at, u.tz) !== day) continue; // DST edge
        if (inQuietHours(at, u.tz, st.quietStart, st.quietEnd)) continue;
        cands.push({ at, weight: lambda[bin] ?? 0 });
      }
    }
    let plan: Plan = { day, at: null, done: true };
    const total = cands.reduce((a, c) => a + c.weight, 0);
    if (cands.length && total > 0) {
      let x = s.random.next() * total;
      let pick = cands[cands.length - 1]!;
      for (const c of cands) {
        x -= c.weight;
        if (x < 0) {
          pick = c;
          break;
        }
      }
      plan = { day, at: pick.at, done: false };
    }
    plans.set(u.id, plan);
    return plan;
  }

  /** Content items available now (sync: date facts come from the tick's async prefetch). */
  function contentFor(u: UserRow, now: Ms, neverWrote: boolean): Map<ProactiveContentType, ContentItem> {
    const out = new Map<ProactiveContentType, ContentItem>();
    if (neverWrote) {
      if (repo.countSentOfType(u.id, 'first_hint') >= FIRST_HINT_MAX) return out;
      if (u.tzSource === 'default') {
        // quiet hours and the prior's day shape are in a GUESSED zone here (en → UTC): stay near their /start hour instead
        const d = Math.abs((Math.floor(now / HOUR) % 24) - (Math.floor(u.createdAt / HOUR) % 24));
        if (Math.min(d, 24 - d) > FIRST_HINT_START_WINDOW_H) return out;
      }
      out.set('first_hint', { type: 'first_hint', text: null, fp: null });
      return out;
    }
    if (memoryEnabled(u, now)) {
      const used = repo.sentFingerprints(u.id, now - ITEM_REUSE_MS);
      const ok = (text: string) => !looksSensitive(text) && !used.has(fpOf(u.id, text));
      const threadText = (t: ProfileThread) => `${t.what}${t.when_local ? ` (${t.when_local})` : ''}`;
      let due: Array<ProfileThread & { index: number }> = [];
      try {
        due = s.userProfile.dueThreads(u.id, now);
      } catch (e) {
        s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'proactive: dueThreads failed');
      }
      const follow = due.find((t) => {
        const after = localToInstant(t.follow_up_after_local, u.tz);
        return (after === null || now - after <= FOLLOW_UP_STALE_MS) && ok(threadText(t));
      });
      if (follow) out.set('follow_up', { type: 'follow_up', text: threadText(follow), fp: fpOf(u.id, threadText(follow)) });
      const useful: ContentItem[] = [];
      try {
        for (const t of s.userProfile.get(u.id)?.card.open_threads ?? []) {
          const when = localToInstant(t.when_local, u.tz);
          if (when === null || when < now - 2 * HOUR || when > now + UPCOMING_MS) continue;
          const text = `upcoming: ${threadText(t)}`;
          if (ok(text)) useful.push({ type: 'useful', text, fp: fpOf(u.id, text) });
        }
      } catch (e) {
        s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'proactive: profile read failed');
      }
      const dates = dateItems.get(u.id);
      if (dates && now - dates.at < DATE_CACHE_MS) useful.push(...dates.items.filter((i) => i.text && ok(i.text)));
      if (useful[0]) out.set('useful', useful[0]);
    }
    out.set('checkin', { type: 'checkin', text: null, fp: null });
    return out;
  }

  /** Async part of the content: date facts (today / tomorrow, non-sensitive), cached for the sync evaluation. */
  async function prefetch(u: UserRow, now: Ms): Promise<void> {
    if (!memoryEnabled(u, now)) {
      dateItems.delete(u.id);
      return;
    }
    const items: ContentItem[] = [];
    try {
      const facts = await s.memory.list({ kind: 'user', userId: u.id }, { kind: 'date', limit: 100 });
      const days = [0, 1].map((d) => wallTimeOf(now + d * DAY, u.tz));
      for (const f of facts.items) {
        if (f.status !== 'active' || f.sensitivity !== 'normal') continue;
        const md = monthDayOf(f.text);
        const hit = md ? days.findIndex((w) => w.month === md.month && w.day === md.day) : -1;
        if (hit < 0) continue;
        const w = days[hit]!;
        // the morning date nudge may already have said it
        if (pro.dedupeHit(u.id, `date:${f.id}:${w.year}`, now - 2 * DAY)) continue;
        const text = `${hit === 0 ? 'today' : 'tomorrow'}: ${f.text}`;
        items.push({ type: 'useful', text, fp: fpOf(u.id, f.text) });
      }
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'proactive: date facts unavailable');
    }
    dateItems.set(u.id, { at: now, items });
  }

  /**
   * The decision for one user at `now`. `slot` applies the one-decision-per-day slot; `consume` marks today's slot as
   * used once the decision reached the bandit (the tick does; decide() for tests / explain does not).
   */
  function evaluate(u: UserRow, now: Ms, o: { slot?: boolean; consume?: boolean; beforeContent?: boolean } = {}): Eval {
    const base = { userId: u.id };
    const why = eligibility(u, now);
    if (why) return { ...base, send: false, reason: why };
    if (sig.unanswered(u.id) >= LIMITS.proactiveHardStopUnanswered) return { ...base, send: false, reason: 'hard_stop' };
    if (sig.capHit(u.id, now)) return { ...base, send: false, reason: 'cap_24h' };
    const view = sig.rhythm(u, now);
    const { bin } = binOf(now, u.tz);
    if (!view.top.has(bin)) return { ...base, send: false, reason: 'off_peak' };
    let plan: Plan | null = null;
    if (o.slot) {
      plan = planFor(u, now, view.lambda, view.top);
      if (plan.done || plan.at === null || now < plan.at || now >= plan.at + SLOT_GRACE_MS) return { ...base, send: false, reason: 'not_slot' };
    }
    if (o.beforeContent) return { ...base, send: false, reason: 'ready' };
    if (plan && o.consume) plan.done = true;
    const last = lastInbound(u.id);
    const gapMs = last === null ? Math.max(0, now - u.createdAt) : Math.max(0, now - last);
    const gapBucket: GapBucket = gapBucketOf(gapMs);
    const items = contentFor(u, now, last === null);
    if (items.size === 0) return { ...base, send: false, reason: 'no_content', gapBucket, gapMs: last === null ? null : gapMs };
    const own = repo.arms(u.id);
    const choice = thompson(s.random, {
      available: [...items.keys()], gap: gapBucket, own, others: othersOf(repo.pooledArms(), own), unanswered: sig.unanswered(u.id),
      annoyancePerUnanswered: LIMITS.proactiveAnnoyancePerUnanswered, priorCap: LIMITS.proactivePriorCap, threshold: threshold(u),
    })!;
    return {
      ...base, send: choice.send, reason: choice.send ? 'above_tau' : 'below_tau', contentType: choice.contentType, gapBucket,
      score: choice.score, gapMs: last === null ? null : gapMs, items, choice,
    };
  }

  function sweepRewards(now: Ms): void {
    for (const row of repo.expiredOpen(now - LIMITS.proactiveReplyWindowMs, 500)) {
      s.db.tx(() => {
        if (repo.setReward(row.id, 0, null)) sig.bumpArms(row, 0, 1, now);
      });
    }
  }

  async function tick(now: Ms, o: { signal?: AbortSignal } = {}): Promise<{ considered: number; sent: number }> {
    sweepRewards(now);
    let considered = 0;
    let sent = 0;
    for (const u of s.repos.users.iterate({ status: 'active', batchSize: 200 })) {
      if (o.signal?.aborted) break;
      considered++;
      try {
        const pre = evaluate(u, now, { slot: true, beforeContent: true });
        if (pre.reason !== 'ready') continue;
        await prefetch(u, now);
        const d = evaluate(u, now, { slot: true, consume: true });
        s.log.debug({ userId: u.id, reason: d.reason, type: d.contentType, gap: d.gapBucket, score: d.score }, 'proactive decision');
        if (!d.send || !d.contentType || !d.gapBucket) continue;
        const plan = plans.get(u.id);
        // ±20 min around the middle of the slot's window; never into quiet hours (the send job would drop it)
        const st = s.repos.users.settings(u.id);
        let at = Math.max(now, (plan?.at ?? now) + LIMITS.proactiveJitterMs + jitterMs(s.random, LIMITS.proactiveJitterMs));
        if (inQuietHours(at, u.tz, st.quietStart, st.quietEnd)) at = now;
        s.scheduler.schedule({
          kind: 'proactive_tick', runAt: at, userId: u.id, dedupeKey: `pt:${u.id}`, maxAttempts: 2,
          payload: { phase: 'send', type: d.contentType, gap: d.gapBucket, score: Math.round((d.score ?? 0) * 1e6) / 1e6, decidedAt: now },
        });
        sent++;
      } catch (e) {
        s.log.warn({ userId: u.id, err: e instanceof Error ? e.name : 'error' }, 'proactive: decision failed');
      }
    }
    return { considered, sent };
  }

  function recentTurns(u: UserRow): Array<{ who: 'owner' | 'you'; text: string }> {
    try {
      const conv = s.repos.conversations.byScopeKey(s.conversations.scopeKeyOf({ kind: 'dm', tgUserId: u.tgUserId }));
      if (!conv || conv.status !== 'active') return [];
      const rows = s.repos.messages.load(conv.id, conv.epoch).slice(-12);
      // an epoch that read untrusted content (email, web, a business peer): the assistant's own turns may paraphrase it,
      // so only the owner's words reach the composer (the proactive text becomes a trusted <gora_event> afterwards)
      let tainted = true;
      try {
        tainted = s.repos.conversations.currentEpoch(conv.id).taint.length > 0;
      } catch {
        tainted = true;
      }
      const out: Array<{ who: 'owner' | 'you'; text: string }> = [];
      for (const r of rows) {
        const isOwner = r.role === 'user' && r.kind === 'user_input';
        const isYou = r.role === 'assistant' && r.kind === 'assistant';
        if (!isOwner && !isYou) continue;
        if (isYou && tainted) continue;
        const content = r.content.content;
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        const text = blocks
          .map((b) => (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
          .filter((t) => t && !t.trimStart().startsWith('<')) // context / untrusted wrappers are not the conversation
          .join(' ')
          .trim();
        // sensitive matters never reach a Gora-first message (05 B1), not even as context for the composer
        if (text && !looksSensitive(text)) out.push({ who: isOwner ? 'owner' : 'you', text });
      }
      return out.slice(-6);
    } catch {
      return [];
    }
  }

  async function sendJob(job: JobRow, now: Ms, signal: AbortSignal): Promise<JobResult> {
    const u = job.userId ? s.repos.users.getById(job.userId) : undefined;
    if (!u) return { status: 'done' };
    const p = job.payload;
    const type = String(p['type'] ?? '') as ProactiveContentType;
    const gap = String(p['gap'] ?? '') as GapBucket;
    const score = Number(p['score'] ?? 0);
    const decidedAt = Number(p['decidedAt'] ?? now);
    // everything is re-checked right before spending the two LLM calls
    if (eligibility(u, now)) return { status: 'done' };
    if (sig.capHit(u.id, now) || sig.unanswered(u.id) >= LIMITS.proactiveHardStopUnanswered) return { status: 'done' };
    const last = lastInbound(u.id);
    if (last !== null && last > decidedAt) return { status: 'done' }; // they wrote meanwhile: no need to write first
    await prefetch(u, now);
    const item = contentFor(u, now, last === null).get(type);
    if (!item) return { status: 'done' };
    const lang = s.signals.styleHints(u.id)?.languages[0] ?? uiLang(u.languageCode);
    const localTime = formatDisplay(now, u.tz, uiLang(u.languageCode));
    const memOn = memoryEnabled(u, now);
    const incognito = u.incognitoUntil !== null && u.incognitoUntil > now;
    let summary: string | null = null;
    if (memOn) {
      try {
        const sm = s.userProfile.get(u.id)?.card.summary ?? null;
        summary = sm && !looksSensitive(sm) ? sm : null;
      } catch {
        summary = null;
      }
    }
    const meta = { userId: u.id, priority: 'proactive' as const, signal };
    const gapMs = last === null ? null : now - last;
    const draft = await s.side.structured(
      {
        purpose: 'compose', role: 'main', system: COMPOSE_SYSTEM, schema: ComposeSchema, maxTokens: 300,
        user: composeUser({
          contentType: type, item: item.text, language: lang, localTime, gapMs, personaName: u.personaName, ownerName: u.firstName,
          style: styleLine(s.signals.styleHints(u.id), s.repos.users.settings(u.id).style), profileSummary: summary,
          turns: incognito || last === null ? [] : recentTurns(u),
        }),
      },
      meta,
    );
    const text = draft ? sanitizeDraft(draft.text) : null;
    if (!text) return { status: 'done' };
    const t0 = s.clock.now();
    const id = newId(PROACTIVE_LOG_PREFIX.replace(/_$/, ''), t0);
    const arm = armLabel(type, gap);
    if (looksSensitive(text)) {
      // deterministic veto before the friend check: a draft about health, money or intimacy is never sent (05 B1)
      repo.insertLog({ id, userId: u.id, arm, contentType: type, gapBucket: gap, score, sent: false, reason: 'sensitive_draft', text: '', now: t0 });
      return { status: 'done' };
    }
    if (!s.llmBudget.allow('proactive')) return { status: 'done' };
    const recent = forgetFiltered(u.id, repo.recentSent(u.id, 5).map((r) => r.text).filter(Boolean));
    const verdict = await s.side.structured(
      { purpose: 'judge', role: 'fast', system: JUDGE_SYSTEM, schema: JudgeSchema, maxTokens: 120, user: judgeUser({ draft: text, contentType: type, language: lang, localTime, gapMs, recent }) },
      meta,
    );
    const t = s.clock.now();
    if (!verdict || !verdict.send) {
      // the friend check said no: nothing is sent and the arms learn nothing
      repo.insertLog({ id, userId: u.id, arm, contentType: type, gapBucket: gap, score, sent: false, reason: verdict?.reason ?? 'judge_unavailable', text, now: t });
      return { status: 'done' };
    }
    // the two calls took a while: the owner may have written, blocked Gora or received another Gora-first message
    const u2 = s.repos.users.getById(u.id);
    const last2 = lastInbound(u.id);
    if (!u2 || u2.status !== 'active' || u2.botBlocked || u2.proactiveLevel === 'off' || sig.capHit(u.id, t) || (last2 !== null && last2 > decidedAt)) {
      return { status: 'done' };
    }
    const chatId = u.dmChatId!;
    s.db.tx(() => {
      repo.insertLog({ id, userId: u.id, arm, contentType: type, gapBucket: gap, score, sent: true, reason: verdict.reason, text, now: t });
      repo.addSignal(u.id, { kind: 'gora_sent', at: t, source: 'proactive', arm, refId: id, value: item.fp });
      s.telegram.outbox.enqueue({
        idempotencyKey: id, userId: u.id, chatId, method: 'sendMessage', payload: {}, markdown: s.telegram.render.escape(text),
        priority: 5, refKind: 'proactive', refId: id,
      });
    });
    s.ledger.append({
      userId: u.id, actor: 'system', kind: 'proactive_sent', summary: `Wrote first (${type}, ${gap})`,
      detail: { id, arm, contentType: type, gapBucket: gap, score, reason: verdict.reason },
    });
    return { status: 'done' };
  }

  const policy: ProactivePolicy = {
    tick,
    decide(userId, now) {
      const u = s.repos.users.getById(userId);
      if (!u) return { userId, send: false, reason: 'not_eligible:unknown' };
      const d = evaluate(u, now, { slot: true });
      return { userId: d.userId, send: d.send, reason: d.reason, ...(d.contentType ? { contentType: d.contentType } : {}), ...(d.gapBucket ? { gapBucket: d.gapBucket } : {}), ...(d.score !== undefined ? { score: d.score } : {}) };
    },
    canSendNow(userId, now) {
      const u = s.repos.users.getById(userId);
      if (!u) return true; // nothing known → the cap is not hit (the caller's own checks drop unknown users)
      if (u.status !== 'active' || u.botBlocked || u.proactiveLevel === 'off') return false;
      // the hard stop holds for every unrequested Gora-first message, not only the policy's own (C4)
      if (sig.unanswered(userId) >= LIMITS.proactiveHardStopUnanswered) return false;
      return !sig.capHit(userId, now);
    },
    explain(logId) {
      const r = repo.getLog(logId);
      return r ? { contentType: r.contentType, gapBucket: r.gapBucket, score: r.score, reason: r.reason, sentAt: r.sent ? r.sentAt : null } : undefined;
    },
  };

  return {
    policy,
    evaluate(u, now, o = {}) {
      const d = evaluate(u, now, o);
      return { userId: d.userId, send: d.send, reason: d.reason, ...(d.contentType ? { contentType: d.contentType } : {}), ...(d.gapBucket ? { gapBucket: d.gapBucket } : {}), ...(d.score !== undefined ? { score: d.score } : {}) };
    },
    async job(job, ctx) {
      if (job.payload['phase'] === 'send') return sendJob(job, ctx.now, ctx.signal);
      await tick(ctx.now, { signal: ctx.signal });
      return { status: 'reschedule', runAt: nextTickAt(ctx.now) };
    },
    onSent(refId, sent) {
      const first = sent[0];
      const row = repo.getLog(refId);
      if (!first || !row) return;
      const now = s.clock.now();
      repo.setLogMessage(refId, first.chatId, first.messageId, now);
      const u = s.repos.users.getById(row.userId);
      if (!u) return;
      // the model sees it as its own message on the next turn (an event row, not an assistant transcript row)
      const conv = s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: u.dmChatId ?? u.tgUserId });
      sent.forEach((m, part) => s.telegram.links.record({ chatId: m.chatId, messageId: m.messageId, kind: 'nudge', part, nudgeId: refId, userId: u.id, conversationId: conv.id }));
      s.repos.inputs.addEvent(conv.id, `You messaged the owner first (${row.contentType}): «${row.text}»`);
    },
    forgetUser(userId) {
      plans.delete(userId);
      dateItems.delete(userId);
    },
  };
}

