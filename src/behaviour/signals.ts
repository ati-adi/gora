// behaviour/signals.ts (friend set B, spec 05 C1–C3) — SignalsService over user_signals / user_rhythm, plus the reward
// bookkeeping of proactive messages (a reply within 24 h → reward 1; a "stop" → strong negative and proactive 'off').
// Every public method is synchronous, cheap and never throws to its caller. Features only: the text is read once for
// its length / emoji / script / question / register and dropped.
import type { Ms, ProactiveContentType, GapBucket, Services, SignalsService, StyleHints, UserId, UserRow } from '../contracts/index.ts';
import { memoryEnabled } from '../contracts/index.ts';
import { LIMITS } from '../config.ts';
import { gapArm, typeArm } from './bandit.ts';
import { langOf, textFeatures } from './features.ts';
import type { BehaviourRepo, ProactiveLogRow } from './repo.ts';
import { addMessage, binOf, decayedTo, localShift, pActiveOf, populationPrior, rates, shiftHist, topBins, type PopulationPrior } from './rhythm.ts';
import { emptyStyle, hintsOf, updateStyle } from './style.ts';

const DAY = 86_400_000;
export const RHYTHM_HALF_LIFE_MS = LIMITS.rhythmHalfLifeDays * DAY;
const PRIOR_TTL_MS = 3_600_000;
const PRIOR_MAX_USERS = 5_000;
/** Gora-first messages that count toward the shared 24 h cap (C4 "Integration"); 'reminder' is user-requested. */
export const CAP_SOURCES = ['proactive', 'nudge', 'brief', 'checkin'] as const;
/** Gora-first messages whose silence counts as "unanswered" (annoyance / hard stop). A brief is asked for, not a ping. */
export const UNANSWERED_SOURCES = ['proactive', 'nudge', 'checkin'] as const;
const POSITIVE_REACTIONS = new Set(['👍', '❤', '❤️', '🔥', '🥰', '😁', '🤗', '👏', '😍', '🙏', '💯', '🤩', '😘', '👌', '🤝', '😊']);
const NEGATIVE_REACTIONS = new Set(['👎', '💩', '🤮', '😡', '🤬']);

export interface RhythmView { lambda: Float64Array; top: Set<number> }

/** A user who has been seen again this long after the account was created (users.last_seen_at) has written before. */
const SEEN_AGAIN_MS = 60_000;

/**
 * A stored histogram in UTC hour-of-week bins. The histogram is kept in UTC and mapped to the owner's CURRENT zone on
 * read, so an A6 zone change (default guess → confirmed city) does not shift the learned hours. Rows written before
 * that fix were binned in the zone of the time; they are taken as binned in `tz`.
 */
function utcHist(row: { hist: Float64Array; style?: { utc?: boolean } | null; utc?: boolean }, tz: string, at: Ms): Float64Array {
  return row.utc || row.style?.utc ? row.hist : shiftHist(row.hist, -localShift(tz, at));
}

export interface SignalsInternals {
  service: SignalsService;
  /** λ per hour-of-week bin and the eligible top bins, at `now` (population prior cached for an hour). */
  rhythm(u: Pick<UserRow, 'id'>, now: Ms): RhythmView;
  /** Counted Gora-first messages since the owner last wrote or replied. */
  unanswered(userId: UserId): number;
  /** Any cap-counting Gora-first message in the last 24 h. */
  capHit(userId: UserId, now: Ms): boolean;
  /** Arm updates for one proactive_log row (both its type and gap arm). */
  bumpArms(row: Pick<ProactiveLogRow, 'contentType' | 'gapBucket'> & { userId: UserId }, dAlpha: number, dBeta: number, now: Ms): void;
  /** Invalidates the population prior cache (tests, deletions). */
  resetCaches(): void;
}

export function createSignals(s: Services, repo: BehaviourRepo): SignalsInternals {
  let prior: { at: Ms; p: PopulationPrior } | null = null;

  const safe = (op: string, f: () => void): void => {
    try {
      f();
    } catch (e) {
      s.log.warn({ op, err: e instanceof Error ? e.name : 'error' }, 'behaviour signals: failed');
    }
  };

  function populationNow(now: Ms): PopulationPrior {
    if (prior && now - prior.at < PRIOR_TTL_MS && now >= prior.at) return prior.p;
    // the prior is a LOCAL-time day shape: each user's histogram is read in their own current zone
    const rows = repo.allRhythms(PRIOR_MAX_USERS);
    const local = rows.map((r) => {
      const tz = s.repos.users.getById(r.userId)?.tz ?? 'UTC';
      return { hist: shiftHist(utcHist(r, tz, now), localShift(tz, now)), updatedAt: r.updatedAt, since: r.since };
    });
    const p = populationPrior(local, now, RHYTHM_HALF_LIFE_MS);
    prior = { at: now, p };
    return p;
  }

  /** λ per LOCAL hour-of-week bin in the owner's current zone. */
  function rhythm(u: Pick<UserRow, 'id' | 'tz'>, now: Ms): RhythmView {
    const row = repo.getRhythm(u.id);
    const hist = row ? shiftHist(decayedTo(utcHist(row, u.tz, now), row.updatedAt, now, RHYTHM_HALF_LIFE_MS), localShift(u.tz, now)) : null;
    const lambda = rates(hist, row?.style?.since ?? row?.updatedAt ?? null, now, populationNow(now), LIMITS.rhythmPriorWeight, RHYTHM_HALF_LIFE_MS);
    return { lambda, top: topBins(lambda, LIMITS.proactiveTopHoursFraction) };
  }

  function bumpArms(row: { userId: UserId; contentType: ProactiveContentType; gapBucket: GapBucket }, dAlpha: number, dBeta: number, now: Ms): void {
    repo.bumpArm(row.userId, typeArm(row.contentType), dAlpha, dBeta, now);
    repo.bumpArm(row.userId, gapArm(row.gapBucket), dAlpha, dBeta, now);
  }

  /** Reward 1 for the open proactive message (if any) and a 'reply' signal; returns whether one was resolved. */
  function resolveReply(userId: UserId, at: Ms): boolean {
    const open = repo.openLog(userId, at, LIMITS.proactiveReplyWindowMs);
    if (!open) return false;
    let done = false;
    s.db.tx(() => {
      if (!repo.setReward(open.id, 1, at)) return;
      bumpArms(open, 1, 0, at);
      repo.addSignal(userId, { kind: 'reply', at, arm: open.arm, refId: open.id, latencyMs: Math.max(0, at - (open.sentAt ?? at)) });
      done = true;
    });
    return done;
  }

  function user(userId: UserId): UserRow | undefined {
    return s.repos.users.getById(userId);
  }

  const service: SignalsService = {
    inbound(userId, m) {
      safe('inbound', () => {
        const u = user(userId);
        if (!u || u.status === 'deleting') return;
        const f = textFeatures(m.text ?? '');
        const { hour, weekday } = binOf(m.at, u.tz);
        // incognito / memory off: timing only (needed so Gora never pings at the wrong hour), no style features
        const learnStyle = memoryEnabled(u, m.at);
        s.db.tx(() => {
          repo.addSignal(userId, {
            kind: 'inbound', at: m.at, localHour: hour, localWeekday: weekday,
            ...(learnStyle ? { length: f.length, emoji: f.emoji, lang: langOf(f.script, u.languageCode), question: f.question, register: f.register } : {}),
          });
          const row = repo.getRhythm(userId);
          // binned by UTC hour-of-week; read in the owner's current zone (a later zone change must not shift the hours)
          const next = addMessage(row ? utcHist(row, u.tz, m.at) : null, row?.updatedAt ?? null, m.at, 'UTC', RHYTHM_HALF_LIFE_MS);
          const st0 = row?.style ?? emptyStyle(m.at);
          const style = learnStyle ? updateStyle(st0, f) : st0;
          repo.putRhythm(userId, { hist: next.hist, style: { ...style, since: Math.min(style.since, m.at), utc: true }, updatedAt: next.updatedAt });
        });
        resolveReply(userId, m.at);
        if (u.status === 'blocked' || u.botBlocked) {
          // they wrote again: the block is over (C1)
          s.repos.users.update(userId, { ...(u.status === 'blocked' ? { status: 'active' as const } : {}), botBlocked: false });
          repo.addSignal(userId, { kind: 'unblocked', at: m.at });
        }
      });
    },
    goraSent(userId, m) {
      safe('goraSent', () => {
        repo.addSignal(userId, { kind: 'gora_sent', at: m.at, source: m.source, arm: m.arm ?? null, refId: m.refId ?? null });
      });
    },
    reaction(userId, m) {
      safe('reaction', () => {
        repo.addSignal(userId, { kind: 'reaction', at: m.at, value: Array.from(m.emoji).slice(0, 4).join('') });
        // a reaction on the open proactive message is an answer too: 👍/❤ → reward 1, 👎 → reward 0 right away
        const open = repo.openLog(userId, m.at, LIMITS.proactiveReplyWindowMs);
        if (!open || open.tgMessageId !== m.tgMessageId) return;
        if (POSITIVE_REACTIONS.has(m.emoji)) resolveReply(userId, m.at);
        else if (NEGATIVE_REACTIONS.has(m.emoji)) {
          s.db.tx(() => {
            if (repo.setReward(open.id, 0, null)) bumpArms(open, 0, 1, m.at);
          });
        }
      });
    },
    feedback(userId, m) {
      safe('feedback', () => {
        repo.addSignal(userId, { kind: 'feedback', at: m.at, value: m.kind });
        if (m.kind !== 'stop') return;
        const u = user(userId);
        if (u && u.proactiveLevel !== 'off') s.repos.users.update(userId, { proactiveLevel: 'off' });
        // strong negative on the arms of the last proactive message; a reply that was really "stop" is no reward
        const last = repo.lastSentLog(userId, m.at - 2 * LIMITS.proactiveReplyWindowMs);
        if (!last) return;
        s.db.tx(() => {
          if (last.reward === 1) {
            repo.overrideReward(last.id, 0);
            bumpArms(last, -1, 0, m.at);
          } else if (last.reward === null) repo.setReward(last.id, 0, null);
          bumpArms(last, 0, LIMITS.proactiveStopPenalty, m.at);
        });
      });
    },
    blocked(userId, at) {
      safe('blocked', () => {
        const u = user(userId);
        if (!u || u.status === 'deleting') return;
        s.repos.users.update(userId, { status: 'blocked', botBlocked: true });
        repo.addSignal(userId, { kind: 'blocked', at });
      });
    },
    lastInboundAt(userId) {
      try {
        const r = repo.getRhythm(userId);
        const sig = repo.lastSignalAt(userId, ['inbound']);
        const v = Math.max(r?.updatedAt ?? -Infinity, sig ?? -Infinity);
        if (Number.isFinite(v)) return v;
        // accounts from before migration 003 have no behaviour rows yet: users.last_seen_at past the first update means
        // they did write (a /start-only account is seen once, at creation, and stays "never wrote")
        const u = user(userId);
        if (u && typeof u.lastSeenAt === 'number' && u.lastSeenAt > u.createdAt + SEEN_AGAIN_MS) return u.lastSeenAt;
        return null;
      } catch {
        return null;
      }
    },
    pActive(userId, at) {
      try {
        const u = user(userId);
        if (!u) return 0;
        const v = rhythm(u, at);
        return pActiveOf(v.lambda, binOf(at, u.tz).bin);
      } catch {
        return 0;
      }
    },
    styleHints(userId): StyleHints | null {
      try {
        const u = user(userId);
        return hintsOf(repo.getRhythm(userId)?.style ?? null, u?.languageCode ?? null);
      } catch {
        return null;
      }
    },
  };

  return {
    service,
    rhythm,
    unanswered(userId) {
      const since = repo.lastSignalAt(userId, ['inbound', 'reply']);
      return repo.countGoraSent(userId, UNANSWERED_SOURCES, since === null ? 0 : since + 1);
    },
    capHit(userId, now) {
      return repo.countGoraSent(userId, CAP_SOURCES, now - 24 * 3_600_000 + 1) > 0;
    },
    bumpArms,
    resetCaches() {
      prior = null;
    },
  };
}
