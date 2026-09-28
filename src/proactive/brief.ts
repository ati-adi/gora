// proactive/brief.ts (WP6b) — the opt-in morning brief (01 §8.5). A per-user cron job `M H * * *` in the owner's zone
// (dedupe 'brief:<userId>'). The handler gathers data deterministically, then starts ONE event run `brief` (channel
// notify) whose body carries the data; third-party parts (calendar, business chats, mail/web-derived nudges) are passed
// as untrusted parts. It never counts against the nudge budget. A brief more than 2 h late is skipped.
import { Cron } from 'croner';
import type { BriefService, GoraEvent, JobResult, JobRow, Ms, Services, TaintSource, UserId, UserRow } from '../contracts/index.ts';
import { formatDisplay, localDay, wallTimeOf, zonedToInstant, addDaysToDate } from '../kernel/timeMath.ts';
import type { ProactiveRepo } from './repo.ts';
import type { SignalScanner } from './signals.ts';
import type { NudgeInternals } from './nudges.ts';
import { clipText, dmChatOf, HOUR, todayConversation, todayThread } from './util.ts';

export const BRIEF_LATE_SKIP_MS = 2 * HOUR;
const LEVELS = { none: 0, read: 1, draft: 2, act: 3 } as const;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function briefCron(hhmm: string): string {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`invalid brief time: ${hhmm}`);
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}
export function nextCronRun(cron: string, tz: string, after: Ms): Ms {
  const n = new Cron(cron, { timezone: tz }).nextRun(new Date(after));
  if (!n) throw new Error('cron has no next run');
  return n.getTime();
}
const round1 = (v: number) => Math.round(v * 10) / 10;

export interface BriefInternals { service: BriefService; job(job: JobRow, now: Ms): Promise<JobResult>; kvKey(userId: UserId): string }

export function createBrief(s: Services, repo: ProactiveRepo, signals: SignalScanner, nudges: NudgeInternals): BriefInternals {
  const kvKey = (userId: UserId) => `brief_day:${userId}`;
  const dedupe = (userId: UserId) => `brief:${userId}`;

  function schedule(u: UserRow, hhmm: string): void {
    const cron = briefCron(hhmm);
    s.scheduler.schedule({ kind: 'brief', runAt: nextCronRun(cron, u.tz, s.clock.now()), userId: u.id, cron, tz: u.tz, dedupeKey: dedupe(u.id) });
  }

  async function gather(u: UserRow): Promise<{ lines: string[]; untrusted: NonNullable<GoraEvent['untrusted']>; taint: TaintSource[] }> {
    const now = s.clock.now();
    const lines: string[] = [];
    const untrusted: NonNullable<GoraEvent['untrusted']> = [];
    const taint = new Set<TaintSource>();
    const st = s.repos.users.settings(u.id);
    const w0 = wallTimeOf(now, u.tz);
    const d1 = addDaysToDate(w0.year, w0.month, w0.day, 1);
    const endOfDay = zonedToInstant({ ...d1, hour: 0, minute: 0 }, u.tz).instant;
    const startOfDay = zonedToInstant({ year: w0.year, month: w0.month, day: w0.day, hour: 0, minute: 0 }, u.tz).instant;
    const part = async (name: string, f: () => Promise<void> | void) => {
      try {
        await f();
      } catch (e) {
        s.log.warn({ userId: u.id, part: name, err: e instanceof Error ? e.name : 'error' }, 'brief: part failed');
        lines.push(`${name}: unavailable`);
      }
    };
    lines.push(`today: ${formatDisplay(now, u.tz, u.languageCode ?? 'en')}`);

    await part('weather', async () => {
      const loc = s.location.get(u.id);
      const pt = loc ? { lat: loc.lat, lon: loc.lon, name: 'current location' } : st.homeCity ? { lat: st.homeCity.lat, lon: st.homeCity.lon, name: st.homeCity.name } : null;
      if (!pt) { lines.push('weather: no location or home city known'); return; }
      const f = await s.caps.weather.forecast({ lat: round1(pt.lat), lon: round1(pt.lon), days: 1 });
      const d = f.daily[0];
      lines.push(`weather (${clipText(pt.name, 60)}): now ${Math.round(f.current.tempC)}°C, code ${f.current.code}, wind ${Math.round(f.current.windKmh)} km/h` +
        (d ? `; today ${Math.round(d.minC)}…${Math.round(d.maxC)}°C, precipitation ${Math.round(d.precipProb)}%` : '') + ` [${f.source}]`);
    });

    await part('reminders', () => {
      const due = new Map<string, Ms>();
      for (const j of s.scheduler.list({ userId: u.id, kinds: ['reminder_fire', 'checkin_fire'], limit: 50 })) if (j.refId && j.runAt < endOfDay) due.set(j.refId, j.runAt);
      const items = s.reminders.list({ kind: 'user', userId: u.id }, false).filter((r) => due.has(r.id)).slice(0, 10);
      lines.push(items.length ? `reminders today:\n${items.map((r) => `- ${clipText(r.text, 120)} — ${r.display}`).join('\n')}` : 'reminders today: none');
    });

    await part('todos', () => {
      const open = s.todos.apply({ kind: 'user', userId: u.id }, u.id, { action: 'list' }).filter((t) => !t.done).slice(0, 10);
      lines.push(open.length ? `open to-dos:\n${open.map((t) => `- ${clipText(t.text, 120)}`).join('\n')}` : 'open to-dos: none');
    });

    await part('commitments', () => {
      // Due today, or overdue and not surfaced yet (an overdue one already nudged is not re-listed every morning).
      const cs = repo.openCommitments(u.id, { direction: 'i_owe', limit: 20 })
        .filter((c) => c.dueAt !== null && c.dueAt < endOfDay && (c.dueAt >= startOfDay || c.status === 'open')).slice(0, 5);
      const item = (c: (typeof cs)[number]) => `- ${clipText(c.text, 120)}${c.counterpart ? ` (to ${clipText(c.counterpart, 40)})` : ''} — ${formatDisplay(c.dueAt!, u.tz, u.languageCode ?? 'en')}`;
      // Business commitments carry peer-controlled text (chat title, triage output): untrusted part + taint (01 §11.3).
      const own = cs.filter((c) => c.source === 'dm');
      const biz = cs.filter((c) => c.source !== 'dm');
      lines.push(own.length ? `commitments due:\n${own.map(item).join('\n')}` : biz.length ? 'commitments due: see the untrusted business commitments part' : 'commitments due: none');
      if (own.length && biz.length) lines.push('more commitments due: see the untrusted business commitments part');
      if (biz.length) {
        untrusted.push({ source: 'business_peer', label: 'business commitments due', text: biz.map(item).join('\n') });
        taint.add('business_peer');
      }
    });

    const status = s.integrations.status(u.id);
    if (status.gcal.connected && LEVELS[status.gcal.level] >= LEVELS.read) {
      await part('calendar', async () => {
        const cal = s.integrations.calendar(u.id);
        if (!cal) return;
        const ev = await cal.list({ fromIso: new Date(Math.max(now, startOfDay)).toISOString(), toIso: new Date(endOfDay).toISOString(), max: 20 });
        s.ledger.append({ userId: u.id, actor: 'system', kind: 'data_read', summary: 'Calendar read for the morning brief', detail: { integration: 'gcal', count: ev.length } });
        lines.push(`calendar today: ${ev.length} event(s) (details in the untrusted calendar part)`);
        if (ev.length) {
          untrusted.push({ source: 'calendar', label: 'calendar today', text: ev.map((e) => `- ${e.start}–${e.end} ${clipText(e.title, 120)}${e.location ? ` @ ${clipText(e.location, 80)}` : ''}`).join('\n') });
          taint.add('calendar');
        }
      });
    }

    if (s.config.features.business) {
      await part('secretary', () => {
        const biz = (s as Partial<Services>).business;
        if (!biz || !biz.connection(u.id)) return;
        const chats = biz.listChats(u.id, 'unanswered', 10);
        lines.push(`unanswered secretary chats: ${chats.length}`);
        if (chats.length) {
          untrusted.push({ source: 'business_peer', label: 'unanswered chat names', text: chats.map((c) => `- ${clipText(c.title, 60)}`).join('\n') });
          taint.add('business_peer');
        }
      });
    }

    await part('suggestion', async () => {
      const top = (await signals.candidates(u, { slot: 'brief' })).find((c) => nudges.wouldPass(c));
      if (!top) return;
      const src = nudges.untrustedSourceOf(top);
      if (src) {
        untrusted.push({ source: src, label: 'top suggestion', text: `${top.body}\n${top.why}` });
        taint.add(src);
        lines.push('top suggestion: see the untrusted suggestion part');
      } else {
        lines.push(`top suggestion: ${top.body} — ${top.why}`);
      }
    });

    return { lines, untrusted, taint: [...taint] };
  }

  async function run(userId: UserId, o: { preview: boolean }): Promise<void> {
    const u = s.repos.users.getById(userId);
    if (!u || u.status === 'deleting') return;
    const data = await gather(u);
    const threadId = o.preview ? null : await todayThread(s, u);
    const conv = todayConversation(s, u, threadId);
    const body = [
      o.preview ? 'Morning brief PREVIEW requested by the owner.' : 'Scheduled morning brief.',
      'Write it up in the owner\'s language, in this order: one headline line, then one <details> section per topic that has data, then exactly one suggestion. Use only the data below; say plainly when something is unavailable.',
      '',
      ...data.lines,
    ].join('\n');
    s.runner.startEventRun(conv.id, { type: 'brief', ref: `brief:${localDay(s.clock.now(), u.tz)}`, body, ...(data.untrusted.length ? { untrusted: data.untrusted } : {}) }, {
      channel: 'notify', priority: o.preview ? 'interactive' : 'proactive',
      replyRef: { chatId: dmChatOf(u), ...(threadId !== null ? { threadId } : {}) },
      ...(data.taint.length ? { taint: data.taint } : {}),
    });
  }

  const service: BriefService = {
    run,
    setDaily(userId, hhmm) {
      const u = s.repos.users.getById(userId);
      if (!u) return;
      if (hhmm !== null && !HHMM.test(hhmm)) throw new Error(`invalid brief time: ${hhmm}`);
      if (s.repos.users.settings(userId).briefTime !== hhmm) s.repos.users.updateSettings(userId, { briefTime: hhmm });
      if (hhmm === null) s.scheduler.cancel(dedupe(userId));
      else schedule(u, hhmm);
    },
  };

  return {
    service,
    kvKey,
    async job(job, now) {
      const u = job.userId ? s.repos.users.getById(job.userId) : undefined;
      // Gone / being deleted: end quietly (the scheduler's dead notice skips 'deleting' and unknown users).
      if (!u || u.status === 'deleting') return { status: 'dead', error: 'user not active' };
      const hhmm = s.repos.users.settings(u.id).briefTime;
      // Not a failure: a paused / bot-blocked owner or a disabled brief is skipped silently (no "couldn't complete"
      // DM). The series keeps its cadence so the brief resumes by itself after /resume or an unblock.
      const skipNext = (): JobResult => ({ status: 'reschedule', runAt: nextCronRun(job.cron ?? briefCron(hhmm ?? '08:00'), job.tz ?? u.tz, now) });
      if (!hhmm) return skipNext();
      if (u.status !== 'active' || u.botBlocked) return skipNext();
      const cron = briefCron(hhmm);
      const next = nextCronRun(cron, u.tz, now);
      // Self-heal: the owner's zone or brief time changed since this job was written.
      // The job fired on the old schedule, which is the wrong local time: re-upsert it and wait for the right one.
      if (job.cron !== cron || job.tz !== u.tz) {
        schedule(u, hhmm);
        return { status: 'reschedule', runAt: next };
      }
      if (now - job.runAt > BRIEF_LATE_SKIP_MS) return { status: 'reschedule', runAt: next };
      const day = localDay(now, u.tz);
      if (s.repos.kv.get<string>(kvKey(u.id)) === day) return { status: 'reschedule', runAt: next };
      if (!s.llmBudget.allow('proactive')) return { status: 'reschedule', runAt: next };
      s.repos.kv.set(kvKey(u.id), day);
      await run(u.id, { preview: false });
      // spec 05 C4: the brief counts toward the shared "1 Gora-first message per 24 h" cap (it is asked for, so it is
      // not an unanswered ping)
      s.signals.goraSent(u.id, { at: now, source: 'brief', refId: `brief:${day}` });
      return { status: 'reschedule', runAt: next };
    },
  };
}
