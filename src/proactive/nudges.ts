// proactive/nudges.ts (WP6b) — NudgeService (01 §8.4, F11): NudgeGate → send / defer / drop, outcomes, the `ng:` callback,
// the nudge_deferred and nudge_ignore jobs and the outbox sent hook. Content (why/body) is sealed in the repo, never logged.
import type {
  CallbackAnswer, CallbackCtx, JobResult, JobRow, Ms, NudgeCandidate, NudgeKind, NudgeService, SentRef, Services, TaintSource, UserId, UserRow,
} from '../contracts/index.ts';
import { NUDGE_KINDS } from '../contracts/index.ts';
import { newId } from '../kernel/ids.ts';
import { inQuietHours, localDay, nextOutsideQuiet } from '../kernel/timeMath.ts';
import { clampWeight, DEDUPE_MS, effectiveBudget, gate, jitterFor, type GateResult } from './nudgeGate.ts';
import type { NudgeRow, ProactiveRepo } from './repo.ts';
import { cbButton, dmChatOf, HOUR, langOf, planOf, todayConversation, todayThread } from './util.ts';

export const IGNORE_AFTER_MS = 12 * HOUR;
export const SNOOZE_MS = 3 * HOUR;
const DO_STEP = 0.1;
const IGNORE_STEP = 0.1;
const REACTION_STEP = 0.2;

/** Kinds whose body/why carry third-party text: handed to the model as untrusted parts (01 §11.3). */
const UNTRUSTED_KIND: Partial<Record<NudgeKind, TaintSource>> = {
  inbox_important: 'email', unanswered_business: 'business_peer', calendar_conflict: 'calendar', watcher_hit: 'web',
};

/** Kinds the owner explicitly asked for (01 F10 "because I asked for it"): no score/backoff step, no ignore penalty. */
const OWNER_REQUESTED: ReadonlySet<NudgeKind> = new Set<NudgeKind>(['watcher_hit']);
/**
 * Spec 05 C4 "Integration": kinds nobody asked for. They go out only when the learned proactive policy's shared cap
 * allows (ProactivePolicy.canSendNow: nothing Gora-first in the last 24 h, not blocked, proactive not 'off').
 */
export const UNREQUESTED_KINDS: ReadonlySet<NudgeKind> = new Set<NudgeKind>(['date_from_memory', 'checkin']);
/** Marks the dedupe key of a snoozed copy (owner-requested re-delivery). */
const SNOOZE_MARK = '#sz:';

/** Commitment kinds: their text may come from a business peer (source 'business'), decided per row via refId. */
export const COMMITMENT_KINDS: ReadonlySet<NudgeKind> = new Set<NudgeKind>(['commitment_due', 'they_owe_stale']);

const TXT = {
  en: { done: 'On it ✓', snoozed: 'Snoozed ✓', never: 'Got it — no more of these. /nudges to undo.', gone: 'This nudge is no longer active.', handled: 'Already handled.' },
  ru: { done: 'Делаю ✓', snoozed: 'Отложено ✓', never: 'Понял — больше таких не будет. /nudges, чтобы вернуть.', gone: 'Это напоминание уже неактуально.', handled: 'Уже обработано.' },
} as const;

export interface NudgeInternals {
  service: NudgeService;
  onCallback(c: CallbackCtx): Promise<CallbackAnswer>;
  onSent(refId: string, sent: SentRef[]): void;
  jobDeferred(job: JobRow): Promise<JobResult>;
  jobIgnore(job: JobRow): Promise<JobResult>;
  /** Pure-ish preview for the brief: would this candidate pass the gate now (ignoring quiet hours and budget)? */
  wouldPass(c: NudgeCandidate): boolean;
  /** Taint source of a nudge/candidate's text (undefined = the owner's own data). */
  untrustedSourceOf(c: { kind: NudgeKind; refId?: string | null }): TaintSource | undefined;
}

export function createNudges(s: Services, repo: ProactiveRepo): NudgeInternals {
  const now = (): Ms => s.clock.now();

  /**
   * `snoozeCopy`: the owner tapped Snooze — the copy is owner-requested: no score, dedupe or budget step (quiet hours
   * still defer it, even a low-priority one). Owner-requested kinds (watcher_hit) skip the score/backoff step.
   */
  function evaluate(c: NudgeCandidate, u: UserRow | undefined, t: Ms, excludeId?: string, o: { snoozeCopy?: boolean; preview?: boolean } = {}): { res: GateResult; day: string; tz: string } {
    const tz = u?.tz ?? 'UTC';
    const day = localDay(t, tz);
    if (!u) return { res: { action: 'drop', reason: 'inactive' }, day, tz };
    const st = s.repos.users.settings(u.id);
    if (!o.snoozeCopy && !o.preview && UNREQUESTED_KINDS.has(c.kind) && !s.proactivePolicy.canSendNow(u.id, t)) return { res: { action: 'drop', reason: 'proactive_cap' }, day, tz };
    const exemptScore = o.snoozeCopy || OWNER_REQUESTED.has(c.kind);
    const pref = repo.pref(u.id, c.kind);
    const res = gate({
      now: t,
      userActive: u.status === 'active' && !u.botBlocked,
      pref: exemptScore ? { ...pref, weight: Math.max(1, pref.weight), ignoredStreak: 0 } : pref,
      dedupeHit: o.snoozeCopy ? false : repo.dedupeHit(u.id, c.dedupeKey, t - DEDUPE_MS, excludeId),
      candidate: o.snoozeCopy ? { ...c, score: 1, countsAgainstBudget: false, priority: c.priority === 'low' ? 'normal' : c.priority } : c,
      sentToday: repo.sentToday(u.id, day, excludeId),
      budget: effectiveBudget(st.nudgeBudget, planOf(s, u).nudgeBudgetMax),
      inQuiet: inQuietHours(t, tz, st.quietStart, st.quietEnd),
    });
    return { res, day, tz };
  }

  function deferTarget(u: UserRow, id: string, t: Ms): Ms {
    const st = s.repos.users.settings(u.id);
    return nextOutsideQuiet(t, u.tz, st.quietStart, st.quietEnd) + jitterFor(id);
  }

  async function deliver(row: Pick<NudgeRow, 'id' | 'userId' | 'kind' | 'why' | 'body' | 'priority' | 'score'>, u: UserRow): Promise<void> {
    const lang = langOf(u);
    const r = s.telegram.render;
    // spec 05 C4: every Gora-first message counts toward the shared 24 h cap and the "unanswered" streak. Recorded
    // BEFORE the first await (todayThread may create a forum topic over the network), so a proactive send job whose
    // last cap check runs meanwhile already sees it.
    s.signals.goraSent(u.id, { at: now(), source: 'nudge', refId: row.id });
    const threadId = await todayThread(s, u);
    const chatId = dmChatOf(u);
    // spec 05 A5: no "Why now:" framing. The details (who, what, when) stay as a plain second line because for most
    // kinds they are the substance (a watcher hit, an email's sender and subject); the reason also stays in /why.
    const markdown = `💡 ${r.escape(row.body)}${row.why ? `\n_${r.escape(row.why)}_` : ''}`;
    const buttons = [[
      cbButton(s, s.strings.t('nudge_do_button', lang), 'ng', [row.id, 'do'], u.tgUserId),
      cbButton(s, s.strings.t('nudge_snooze_button', lang), 'ng', [row.id, 'sz'], u.tgUserId),
      cbButton(s, s.strings.t('nudge_never_button', lang), 'ng', [row.id, 'nv'], u.tgUserId),
    ]];
    s.telegram.outbox.enqueue({
      idempotencyKey: `nudge:${row.id}`, userId: u.id, chatId, ...(threadId !== null ? { threadId } : {}),
      method: 'sendRichMessage', payload: { reply_markup: { inline_keyboard: buttons } }, markdown,
      priority: 5, ...(row.priority === 'low' ? { disableNotification: true } : {}), refKind: 'nudge', refId: row.id,
    });
    s.ledger.append({ userId: u.id, actor: 'system', kind: 'nudge_sent', summary: `Nudge sent (${row.kind})`, detail: { nudgeId: row.id, kind: row.kind, score: row.score, priority: row.priority } });
    s.scheduler.schedule({ kind: 'nudge_ignore', runAt: now() + IGNORE_AFTER_MS, userId: u.id, refId: row.id, dedupeKey: `ni:${row.id}` });
  }

  async function propose(c: NudgeCandidate): Promise<'sent' | 'deferred' | 'dropped'> {
    const u = s.repos.users.getById(c.userId);
    const t = now();
    const id = newId('n', t);
    if (!u) return 'dropped';
    // Gate + insert in one synchronous transaction: two concurrent proposals cannot both take the last budget slot.
    const outcome = s.db.tx(() => {
      const { res, day } = evaluate(c, u, t);
      if (res.action === 'send') {
        repo.insertNudge(id, c, { status: 'sent', localDay: day, sentAt: t, now: t });
        return 'sent' as const;
      }
      if (res.action === 'defer') {
        const at = deferTarget(u, id, t);
        repo.insertNudge(id, c, { status: 'deferred', deferUntil: at, now: t });
        s.scheduler.schedule({ kind: 'nudge_deferred', runAt: at, userId: u.id, refId: id, dedupeKey: `nd:${id}` });
        return 'deferred' as const;
      }
      repo.insertNudge(id, c, { status: 'dropped', now: t });
      s.log.debug({ userId: u.id, kind: c.kind, reason: res.reason }, 'nudge dropped');
      return 'dropped' as const;
    });
    if (outcome === 'sent') await deliver({ id, userId: c.userId, kind: c.kind, why: c.why, body: c.body, priority: c.priority, score: c.score }, u);
    return outcome;
  }

  function adjust(userId: UserId, kind: NudgeKind, f: (w: number, streak: number) => { weight: number; ignoredStreak: number }): void {
    const p = repo.pref(userId, kind);
    const n = f(p.weight, p.ignoredStreak);
    repo.upsertPref(userId, kind, { weight: clampWeight(n.weight), ignoredStreak: Math.max(0, n.ignoredStreak) });
  }

  function clearButtons(row: NudgeRow, u: UserRow): void {
    if (row.tgChatId === null || row.tgMessageId === null) return;
    s.telegram.outbox.enqueue({
      idempotencyKey: `nudge:${row.id}:clear`, userId: u.id, chatId: row.tgChatId, method: 'editMessageReplyMarkup',
      payload: { message_id: row.tgMessageId, reply_markup: { inline_keyboard: [] } }, priority: 1,
    });
  }

  /** The taint source of a nudge's text: fixed per kind, or per row for commitments (business ones carry peer text). */
  function untrustedSourceOf(row: { kind: NudgeKind; refId?: string | null }): TaintSource | undefined {
    const fixed = UNTRUSTED_KIND[row.kind];
    if (fixed) return fixed;
    if (COMMITMENT_KINDS.has(row.kind)) {
      // A missing commitment (deleted source) is treated as untrusted: its origin can no longer be proven.
      const c = row.refId ? repo.getCommitment(row.refId) : undefined;
      return c && c.source === 'dm' ? undefined : 'business_peer';
    }
    return undefined;
  }

  /** "Do it" on a commitment nudge closes the commitment: it is not re-nudged by later scans nor listed in the brief. */
  function closeCommitment(row: NudgeRow): void {
    if (!COMMITMENT_KINDS.has(row.kind) || !row.refId) return;
    const c = repo.getCommitment(row.refId);
    if (!c || c.userId !== row.userId || (c.status !== 'open' && c.status !== 'nudged')) return;
    repo.setCommitmentStatus(c.id, 'done');
    s.scheduler.cancel(`fu:${c.id}`);
  }

  async function startDo(row: NudgeRow, u: UserRow): Promise<void> {
    const threadId = await todayThread(s, u);
    const conv = todayConversation(s, u, threadId);
    const src = untrustedSourceOf(row);
    const intro = `The owner tapped "Do it" on nudge ${row.id} (kind ${row.kind}). Help them do it now, briefly.` +
      (row.kind === 'they_owe_stale' ? ' Offer a short chase message; sending it needs the owner\'s approval.' : '');
    const body = src ? intro : `${intro}\nNudge: ${row.body}\nWhy now: ${row.why}`;
    s.runner.startEventRun(conv.id, {
      type: 'nudge_do', ref: row.id, body,
      ...(src ? { untrusted: [{ source: src, label: `nudge ${row.kind}`, text: `${row.body}\nWhy now: ${row.why}` }] } : {}),
    }, {
      channel: 'dm_stream', priority: 'interactive',
      replyRef: { chatId: dmChatOf(u), ...(threadId !== null ? { threadId } : {}) },
      ...(src ? { taint: [src] } : {}),
    });
  }

  async function outcome(nudgeId: string, o: 'do' | 'snooze' | 'never' | 'ignored' | 'reaction_up' | 'reaction_down'): Promise<void> {
    const row = repo.getNudge(nudgeId);
    if (!row || row.status !== 'sent') return;
    const u = s.repos.users.getById(row.userId);
    if (!u) return;
    const t = now();
    if (o === 'reaction_up' || o === 'reaction_down') {
      if (!repo.setReactionOutcome(row.id, o, t)) return;
      // A reaction that replaces "ignored" also undoes the ignore penalty.
      const undoIgnore = row.outcome === 'ignored' && !OWNER_REQUESTED.has(row.kind); // owner-requested kinds were never penalized
      adjust(u.id, row.kind, (w, k) => ({
        weight: w + (o === 'reaction_up' ? REACTION_STEP : -REACTION_STEP) + (undoIgnore ? IGNORE_STEP : 0) - (row.outcome === 'reaction_up' ? REACTION_STEP : row.outcome === 'reaction_down' ? -REACTION_STEP : 0),
        ignoredStreak: undoIgnore ? k - 1 : k,
      }));
      return;
    }
    if (!repo.setOutcomeOnce(row.id, o, t)) return;
    switch (o) {
      case 'ignored':
        // An informational hit the owner asked for is read, not tapped: no penalty.
        if (!OWNER_REQUESTED.has(row.kind)) adjust(u.id, row.kind, (w, k) => ({ weight: w - IGNORE_STEP, ignoredStreak: k + 1 }));
        return;
      case 'do':
        adjust(u.id, row.kind, (w) => ({ weight: w + DO_STEP, ignoredStreak: 0 }));
        clearButtons(row, u);
        s.scheduler.cancel(`ni:${row.id}`);
        closeCommitment(row);
        await startDo(row, u);
        return;
      case 'snooze': {
        adjust(u.id, row.kind, (w) => ({ weight: w, ignoredStreak: 0 }));
        clearButtons(row, u);
        s.scheduler.cancel(`ni:${row.id}`);
        const st = s.repos.users.settings(u.id);
        let at = t + SNOOZE_MS;
        if (inQuietHours(at, u.tz, st.quietStart, st.quietEnd)) at = nextOutsideQuiet(at, u.tz, st.quietStart, st.quietEnd);
        const nid = newId('n', t);
        s.db.tx(() => {
          repo.insertNudge(nid, {
            // Owner-requested re-delivery (§8.4 "Snooze sets +3 h"): the original already used its budget slot.
            userId: u.id, kind: row.kind, dedupeKey: `${row.dedupeKey}${SNOOZE_MARK}${row.id}`, ...(row.refId ? { refId: row.refId } : {}), why: row.why, body: row.body,
            score: row.score, priority: row.priority, countsAgainstBudget: false,
          }, { status: 'deferred', deferUntil: at, now: t });
          s.scheduler.schedule({ kind: 'nudge_deferred', runAt: at, userId: u.id, refId: nid, dedupeKey: `nd:${nid}` });
        });
        return;
      }
      case 'never':
        repo.upsertPref(u.id, row.kind, { muted: true, ignoredStreak: 0 });
        clearButtons(row, u);
        s.scheduler.cancel(`ni:${row.id}`);
        s.ledger.append({ userId: u.id, actor: 'user', kind: 'settings', summary: `Muted nudges of kind ${row.kind}`, detail: { kind: row.kind } });
        return;
    }
  }

  const service: NudgeService = {
    propose,
    outcome,
    remainingToday(userId) {
      const u = s.repos.users.getById(userId);
      if (!u) return 0;
      const budget = effectiveBudget(s.repos.users.settings(userId).nudgeBudget, planOf(s, u).nudgeBudgetMax);
      return Math.max(0, budget - repo.sentToday(userId, localDay(now(), u.tz)));
    },
    get(nudgeId) {
      const r = repo.getNudge(nudgeId);
      return r ? { id: r.id, userId: r.userId, kind: r.kind, why: r.why, score: r.score, sentAt: r.sentAt } : undefined;
    },
    prefs(userId) {
      const m = repo.allPrefs(userId);
      return NUDGE_KINDS.map((kind) => {
        const p = m.get(kind);
        return { kind, muted: p?.muted ?? false, snoozeUntil: p?.snoozeUntil ?? null };
      });
    },
    setPref(userId, kind, p) {
      if (!NUDGE_KINDS.includes(kind)) throw new Error(`unknown nudge kind: ${kind}`);
      repo.upsertPref(userId, kind, { ...(p.muted !== undefined ? { muted: p.muted } : {}), ...(p.snoozeUntil !== undefined ? { snoozeUntil: p.snoozeUntil } : {}) });
    },
  };

  return {
    service,
    async onCallback(c) {
      const [id, action] = c.parts;
      const lang = langOf(c.user);
      const row = id ? repo.getNudge(id) : undefined;
      if (!row || !c.user || row.userId !== c.user.id || row.status !== 'sent') return { text: TXT[lang].gone };
      if (row.outcome !== null && row.outcome !== 'ignored' && row.outcome !== 'reaction_up' && row.outcome !== 'reaction_down') return { text: TXT[lang].handled };
      // A tap after the 12 h ignore window still counts: clear the ignore first, then undo its penalty.
      if (row.outcome !== null) {
        repo.clearOutcome(row.id);
        if (row.outcome === 'ignored' && !OWNER_REQUESTED.has(row.kind)) adjust(row.userId, row.kind, (w, k) => ({ weight: w + IGNORE_STEP, ignoredStreak: k - 1 }));
      }
      if (action === 'do') { await outcome(row.id, 'do'); return { text: TXT[lang].done }; }
      if (action === 'sz') { await outcome(row.id, 'snooze'); return { text: TXT[lang].snoozed }; }
      if (action === 'nv') { await outcome(row.id, 'never'); return { text: TXT[lang].never }; }
      return { text: TXT[lang].gone };
    },
    onSent(refId, sent) {
      const first = sent[0];
      if (!first) return;
      const row = repo.getNudge(refId);
      repo.setNudgeMessage(refId, first.chatId, first.messageId);
      sent.forEach((m, part) => {
        s.telegram.links.record({ chatId: m.chatId, messageId: m.messageId, kind: 'nudge', part, nudgeId: refId, userId: row?.userId ?? null });
      });
    },
    async jobDeferred(job) {
      const id = job.refId ?? '';
      const row = repo.getNudge(id);
      if (!row || row.status !== 'deferred') return { status: 'done' };
      const u = s.repos.users.getById(row.userId);
      const t = now();
      const c: NudgeCandidate = { userId: row.userId, kind: row.kind, dedupeKey: row.dedupeKey, why: row.why, body: row.body, score: row.score, priority: row.priority, countsAgainstBudget: row.countsAgainstBudget };
      const decided = s.db.tx(() => {
        const { res, day } = evaluate(c, u, t, row.id, { snoozeCopy: row.dedupeKey.includes(SNOOZE_MARK) });
        if (res.action === 'send') { repo.setNudgeStatus(row.id, { status: 'sent', localDay: day, sentAt: t }); return 'sent' as const; }
        if (res.action === 'defer' && u) {
          const at = deferTarget(u, row.id, t);
          repo.setNudgeStatus(row.id, { status: 'deferred', deferUntil: at });
          return at;
        }
        repo.setNudgeStatus(row.id, { status: 'dropped' });
        return 'dropped' as const;
      });
      if (decided === 'sent' && u) await deliver(row, u);
      if (typeof decided === 'number') return { status: 'reschedule', runAt: decided };
      return { status: 'done' };
    },
    async jobIgnore(job) {
      const row = job.refId ? repo.getNudge(job.refId) : undefined;
      if (row && row.status === 'sent' && row.outcome === null) await outcome(row.id, 'ignored');
      return { status: 'done' };
    },
    untrustedSourceOf,
    wouldPass(c) {
      const u = s.repos.users.getById(c.userId);
      if (!u) return false;
      const { res } = evaluate({ ...c, countsAgainstBudget: false }, u, now(), undefined, { preview: true }); // the brief was asked for: no shared cap
      return res.action !== 'drop' || res.reason === 'quiet_low';
    },
  };
}
