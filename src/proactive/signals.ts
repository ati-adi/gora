// proactive/signals.ts (WP6b) — the deterministic signal scan of 01 §8.4 (no LLM). The system job `proactive_scan`
// runs every 30 min (UTC); each user is scanned in the half-hour that starts at 09:30, 13:30 and 18:30 local. The
// evening slot adds tomorrow's calendar conflicts; the morning slot adds dates from memory. Every candidate goes
// through NudgeGate (dedupe keys make a repeated scan harmless).
import { Cron } from 'croner';
import type { CalEvent, JobResult, Ms, NudgeCandidate, Services, UserRow } from '../contracts/index.ts';
import { memoryEnabled } from '../contracts/index.ts';
import { looksSensitive } from '../kernel/sensitive.ts';
import { addDaysToDate, formatDisplay, wallTimeOf, zonedToInstant } from '../kernel/timeMath.ts';
import { commitmentCandidate } from './commitments.ts';
import type { ProactiveRepo } from './repo.ts';
import { clipText, DAY, HOUR, langOf } from './util.ts';

export const SCAN_CRON = '*/30 * * * *';
export const SCAN_SLOTS: readonly string[] = ['09:30', '13:30', '18:30'];
const SLOT_WINDOW_MIN = 30;
const LEVELS = { none: 0, read: 1, draft: 2, act: 3 } as const;

export type Slot = 'morning' | 'midday' | 'evening';

/** Which scan slot (if any) the owner's local time falls into. */
export function slotAt(now: Ms, tz: string): Slot | null {
  const w = wallTimeOf(now, tz);
  const min = w.hour * 60 + w.minute;
  const names: Slot[] = ['morning', 'midday', 'evening'];
  for (let i = 0; i < SCAN_SLOTS.length; i++) {
    const [h, m] = SCAN_SLOTS[i]!.split(':').map(Number) as [number, number];
    const start = h * 60 + m;
    if (min >= start && min < start + SLOT_WINDOW_MIN) return names[i]!;
  }
  return null;
}

export function nextScanAt(now: Ms): Ms {
  const n = new Cron(SCAN_CRON, { timezone: 'UTC' }).nextRun(new Date(now));
  return n ? n.getTime() : now + 30 * 60_000;
}

/** 'Anna <anna@x.com>' → 'anna@x.com'. */
export function emailOf(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"']+@[^\s<>"']+)/.exec(from);
  return m ? m[1]!.toLowerCase() : null;
}
function nameOf(from: string): string {
  const n = from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  return n || emailOf(from) || from;
}

/** Pairs of overlapping timed events (all-day events, which have no 'T', are ignored). */
export function overlaps(events: CalEvent[]): Array<[CalEvent, CalEvent]> {
  const timed = events
    .filter((e) => e.start.includes('T') && e.end.includes('T'))
    .map((e) => ({ e, a: Date.parse(e.start), b: Date.parse(e.end) }))
    .filter((x) => Number.isFinite(x.a) && Number.isFinite(x.b) && x.b > x.a)
    .sort((x, y) => x.a - y.a);
  const out: Array<[CalEvent, CalEvent]> = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j]!.a < timed[i]!.b; j++) out.push([timed[i]!.e, timed[j]!.e]);
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};
/** Month/day mentioned in a date fact ("birthday is 14 October", "Oct 14", "1990-10-14", "14.10"), or null. */
export function monthDayOf(text: string): { month: number; day: number } | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return { month: Number(iso[2]), day: Number(iso[3]) };
  const t = text.toLowerCase();
  const a = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-zа-яё]{3,})/u.exec(t);
  if (a && MONTHS[a[2]!.slice(0, 3)]) return { month: MONTHS[a[2]!.slice(0, 3)]!, day: Number(a[1]) };
  const b = /\b([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (b && MONTHS[b[1]!.slice(0, 3)]) return { month: MONTHS[b[1]!.slice(0, 3)]!, day: Number(b[2]) };
  const d = /\b(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?\b/.exec(t);
  if (d) {
    const day = Number(d[1]);
    const month = Number(d[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day };
  }
  return null;
}

const TX = {
  en: {
    biz: (peer: string, h: number, closes: string) => `${peer} has waited ${h} h; the reply window closes ${closes}.`,
    bizBody: (peer: string) => `Reply to ${peer}`,
    cal: (t1: string, t2: string) => `Tomorrow ${t1} overlaps ${t2}.`,
    calBody: 'Two events overlap tomorrow',
    mail: (sender: string, h: number, subject: string) => `${sender} wrote ${h} h ago: “${subject}”.`,
    mailBody: (sender: string) => `Unanswered email from ${sender}`,
    date: (fact: string) => `Tomorrow: ${fact}`,
    dateBody: 'A date to remember is tomorrow',
  },
  ru: {
    biz: (peer: string, h: number, closes: string) => `${peer} ждёт ${h} ч; окно ответа закроется ${closes}.`,
    bizBody: (peer: string) => `Ответить: ${peer}`,
    cal: (t1: string, t2: string) => `Завтра ${t1} пересекается с ${t2}.`,
    calBody: 'Завтра две встречи пересекаются',
    mail: (sender: string, h: number, subject: string) => `${sender} написал(а) ${h} ч назад: «${subject}».`,
    mailBody: (sender: string) => `Письмо без ответа от ${sender}`,
    date: (fact: string) => `Завтра: ${fact}`,
    dateBody: 'Завтра важная дата',
  },
} as const;

export interface SignalScanner {
  candidates(u: UserRow, o: { slot: Slot | 'brief' }): Promise<NudgeCandidate[]>;
  job(now: Ms): Promise<JobResult>;
}

export function createSignals(s: Services, repo: ProactiveRepo): SignalScanner {
  const safe = async <T>(name: string, userId: string, f: () => Promise<T[]> | T[]): Promise<T[]> => {
    try {
      return await f();
    } catch (e) {
      s.log.warn({ userId, signal: name, err: e instanceof Error ? e.name : 'error' }, 'proactive signal failed');
      return [];
    }
  };

  function dayBounds(now: Ms, tz: string, offsetDays: number): { from: Ms; to: Ms } {
    const w = wallTimeOf(now, tz);
    const d0 = addDaysToDate(w.year, w.month, w.day, offsetDays);
    const d1 = addDaysToDate(w.year, w.month, w.day, offsetDays + 1);
    return { from: zonedToInstant({ ...d0, hour: 0, minute: 0 }, tz).instant, to: zonedToInstant({ ...d1, hour: 0, minute: 0 }, tz).instant };
  }

  async function candidates(u: UserRow, o: { slot: Slot | 'brief' }): Promise<NudgeCandidate[]> {
    const now = s.clock.now();
    const lang = langOf(u);
    const L = TX[lang];
    const out: NudgeCandidate[] = [];
    const today = dayBounds(now, u.tz, 0);

    // commitments
    out.push(...(await safe('commitments', u.id, () =>
      repo.openCommitments(u.id, { limit: 50, onlyUnnudged: true }) // one nudge per commitment; 'Do it' closes it
        .filter((c) => (c.direction === 'i_owe' ? c.dueAt !== null && c.dueAt < today.to : now - c.createdAt > 3 * DAY && (c.dueAt === null || c.dueAt < now)))
        .map((c) => commitmentCandidate(c, u, now)))));

    // unanswered consented business chats (priority from triage, window still open)
    if (s.config.features.business) {
      out.push(...(await safe('business', u.id, () => {
        const biz = (s as Partial<typeof s>).business;
        if (!biz) return [];
        return biz.listChats(u.id, 'unanswered', 20)
          .filter((c) => c.unansweredSince !== null && now - c.unansweredSince > DAY && c.priority >= 1 && c.windowExpiresAt !== null && c.windowExpiresAt > now)
          .map((c): NudgeCandidate => {
            const peer = clipText(c.title, 60);
            return {
              userId: u.id, kind: 'unanswered_business', dedupeKey: `biz:${c.ref}:${c.unansweredSince}`, refId: c.ref,
              why: L.biz(peer, Math.floor((now - c.unansweredSince!) / HOUR), formatDisplay(c.windowExpiresAt!, u.tz, lang)),
              body: L.bizBody(peer), score: Math.min(1, 0.45 + 0.15 * c.priority), priority: c.priority >= 3 ? 'high' : 'normal', countsAgainstBudget: true,
            };
          });
      })));
    }

    const status = s.integrations.status(u.id);
    // tomorrow's calendar conflicts (evening scan and the brief looks at today)
    if ((o.slot === 'evening' || o.slot === 'brief') && status.gcal.connected && LEVELS[status.gcal.level] >= LEVELS.read) {
      out.push(...(await safe('calendar', u.id, async () => {
        const cal = s.integrations.calendar(u.id);
        if (!cal) return [];
        const b = dayBounds(now, u.tz, o.slot === 'brief' ? 0 : 1);
        const events = await cal.list({ fromIso: new Date(b.from).toISOString(), toIso: new Date(b.to).toISOString(), max: 50 });
        return overlaps(events).slice(0, 3).map(([a, c]): NudgeCandidate => ({
          userId: u.id, kind: 'calendar_conflict', dedupeKey: `cal:${a.id}:${c.id}`,
          why: L.cal(`${clipText(a.title, 60)} (${formatDisplay(Date.parse(a.start), u.tz, lang)})`, clipText(c.title, 60)),
          body: L.calBody, score: 0.7, priority: 'normal', countsAgainstBudget: true,
        }));
      })));
    }

    // important unanswered mail from trusted senders
    if (status.gmail.connected && LEVELS[status.gmail.level] >= LEVELS.read && s.repos.users.settings(u.id).inboxCheckins) {
      out.push(...(await safe('inbox', u.id, async () => {
        const mail = s.integrations.mail(u.id);
        if (!mail) return [];
        const threads = await mail.search({ query: 'in:inbox is:unread', maxResults: 15, newerThanDays: 7 });
        s.ledger.append({ userId: u.id, actor: 'system', kind: 'data_read', summary: 'Inbox check for nudges', detail: { integration: 'gmail', count: threads.length } });
        return threads
          .filter((t) => now - t.date > DAY)
          .filter((t) => {
            const e = emailOf(t.from);
            return e !== null && s.trustedTargets.isTrusted(u.id, 'email', e);
          })
          .slice(0, 3)
          .map((t): NudgeCandidate => {
            const sender = clipText(nameOf(t.from), 60);
            return {
              userId: u.id, kind: 'inbox_important', dedupeKey: `mail:${t.threadId}`, refId: t.threadId,
              why: L.mail(sender, Math.floor((now - t.date) / HOUR), clipText(t.subject, 80)), body: L.mailBody(sender),
              score: 0.6, priority: 'normal', countsAgainstBudget: true,
            };
          });
      })));
    }

    // dates from memory (morning scan and the brief)
    // spec 05 B1: memory is on unless incognito or the owner turned it off (null consent = on)
    if ((o.slot === 'morning' || o.slot === 'brief') && memoryEnabled(u, now)) {
      out.push(...(await safe('dates', u.id, async () => {
        const tw = wallTimeOf(now + DAY, u.tz);
        const facts = await s.memory.list({ kind: 'user', userId: u.id }, { kind: 'date', limit: 100 });
        return facts.items
          // spec 05 B1: sensitive facts (flagged, or tripping the deterministic check) are never written first
          .filter((f) => f.status === 'active' && f.sensitivity === 'normal' && !looksSensitive(f.text))
          .filter((f) => {
            const md = monthDayOf(f.text);
            return md !== null && md.month === tw.month && md.day === tw.day;
          })
          .slice(0, 2)
          .map((f): NudgeCandidate => ({
            userId: u.id, kind: 'date_from_memory', dedupeKey: `date:${f.id}:${tw.year}`, refId: f.id,
            why: L.date(clipText(f.text, 160)), body: L.dateBody, score: 0.75, priority: 'normal', countsAgainstBudget: true,
          }));
      })));
    }

    return out.sort((a, b) => b.score - a.score);
  }

  return {
    candidates,
    async job(now) {
      for (const u of s.repos.users.iterate({ status: 'active', batchSize: 200 })) {
        if (u.botBlocked) continue;
        const slot = slotAt(now, u.tz);
        if (!slot) continue;
        const list = await candidates(u, { slot });
        for (const c of list) {
          const r = await s.nudges.propose(c);
          if (r !== 'dropped' && c.refId && (c.kind === 'commitment_due' || c.kind === 'they_owe_stale')) repo.markCommitmentNudged(c.refId);
        }
      }
      return { status: 'reschedule', runAt: nextScanAt(now) };
    },
  };
}
