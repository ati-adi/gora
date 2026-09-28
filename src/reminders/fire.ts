// reminders/fire.ts (WP6a) — the reminder_fire and checkin_fire job handlers (01 §8.2 late jobs, §8.3).
// reminder_fire is deterministic (no LLM) and ignores quiet hours; checkin_fire starts an event run on the notify channel.
import type { InlineKeyboardButton } from 'grammy/types';
import type { Ms } from '../contracts/common.ts';
import { parseScopeKey } from '../contracts/common.ts';
import type { JobHandler, JobRow, JobResult } from '../contracts/scheduler.ts';
import { JOB_LLM_PRIORITY } from '../contracts/scheduler.ts';
import type { Services } from '../contracts/services.ts';
import type { UserRow } from '../contracts/storage.ts';
import { errorMessage } from '../kernel/errors.ts';
import { formatDisplay } from '../kernel/timeMath.ts';
import type { ReminderRow } from './repo.ts';
import type { ReminderServiceImpl } from './service.ts';

/** Later than this counts as "(late)"; the scheduler's own latency is far below it. */
export const LATE_AFTER_MS = 2 * 60_000;
/** Later than this counts as "(missed)" (01 §8.2). */
export const MISSED_AFTER_MS = 24 * 3_600_000;

export type Lateness = 'on_time' | 'late' | 'missed';
export function lateness(scheduledAt: Ms, now: Ms): Lateness {
  const d = now - scheduledAt;
  if (d > MISSED_AFTER_MS) return 'missed';
  if (d > LATE_AFTER_MS) return 'late';
  return 'on_time';
}

export function reminderButtons(s: Services, r: ReminderRow, ownerTgId: number, lang: string): InlineKeyboardButton[][] {
  const cb = (a: string) => s.telegram.codec.encode('rm', [r.id, a], ownerTgId);
  return [
    [
      { text: s.strings.t('done_button', lang), callback_data: cb('d') },
      { text: s.strings.t('snooze_10m_button', lang), callback_data: cb('10') },
      { text: s.strings.t('snooze_1h_button', lang), callback_data: cb('60') },
      { text: s.strings.t('tomorrow_button', lang), callback_data: cb('tm') },
    ],
  ];
}

export function createFireHandlers(s: Services, svc: ReminderServiceImpl): { reminderFire: JobHandler; checkinFire: JobHandler } {
  const log = () => s.log.child({ mod: 'reminders' });

  /** Loads the reminder and its owner; null when there is nothing to do (cancelled, paused, deleted user, …). */
  const load = (job: JobRow): { r: ReminderRow; owner: UserRow | undefined } | null => {
    if (!job.refId) return null;
    const r = svc.repo().getReminder(job.refId);
    if (!r) return null;
    if (r.status === 'cancelled' || r.status === 'done' || r.status === 'paused') return null;
    if (r.status === 'fired' && r.scheduleKind === 'once' && !job.payload['snooze']) return null;
    const owner = r.userId ? s.repos.users.getById(r.userId) : undefined;
    if (r.userId && (!owner || owner.status === 'deleting')) return null;
    if (r.scope.startsWith('user:') && owner?.botBlocked) return null;
    return { r, owner };
  };

  /** The deterministic "⏰ text" message with <tg-time> and the four buttons, via the outbox. */
  const send = (job: JobRow, r: ReminderRow, owner: UserRow | undefined, late: Lateness): void => {
    const lang = owner?.languageCode ?? 'en';
    const R = s.telegram.render;
    const when = job.runAt;
    const display = formatDisplay(when, r.tz, lang);
    const mark = late === 'missed' ? ` ${s.strings.t('missed', lang)}` : late === 'late' ? ` ${s.strings.t('late', lang)}` : '';
    const markdown = `⏰ ${R.escape(r.text || '…')}\n${R.tgTime(Math.floor(when / 1000), 'wDT', display)}${R.escape(mark)}`;
    const ownerTg = r.scope.startsWith('grp:') && !owner ? 0 : (owner?.tgUserId ?? 0);
    s.telegram.outbox.enqueue({
      idempotencyKey: `rem:${r.id}:${when}`,
      ...(r.userId ? { userId: r.userId } : {}),
      chatId: r.targetChatId,
      ...(r.targetThreadId ? { threadId: r.targetThreadId } : {}),
      method: 'sendRichMessage',
      payload: { reply_markup: { inline_keyboard: reminderButtons(s, r, ownerTg, lang) } },
      markdown,
      priority: 1,
      refKind: 'reminder',
      refId: r.id,
    });
  };

  /**
   * Spec 05 C4: a message in the owner's own chat counts in the behaviour signals — a check-in toward the shared 24 h cap
   * of Gora-first messages (and the unanswered streak), a reminder (asked for) only as a record. Group reminders do not.
   */
  const reportSent = (r: ReminderRow, owner: UserRow | undefined, source: 'reminder' | 'checkin', at: Ms): void => {
    if (!owner || !r.scope.startsWith('user:')) return;
    try {
      s.signals.goraSent(owner.id, { at, source, refId: r.id });
    } catch (e) {
      log().warn({ reminderId: r.id, err: errorMessage(e) }, 'signals: reminder send not recorded');
    }
  };

  /** A one-off becomes 'fired' (still actionable through its buttons); a recurrence (and its snooze firing) stays scheduled. */
  const afterFire = (r: ReminderRow): void => {
    if (r.scheduleKind === 'once') svc.repo().updateReminder(r.id, { status: 'fired' }, s.clock.now());
  };

  const reminderFire: JobHandler = async (job, ctx): Promise<JobResult> => {
    const l = load(job);
    if (!l) return { status: 'done' };
    try {
      send(job, l.r, l.owner, lateness(job.runAt, ctx.now));
      reportSent(l.r, l.owner, 'reminder', ctx.now);
    } catch (e) {
      log().warn({ reminderId: l.r.id, err: errorMessage(e) }, 'reminder send failed');
      return { status: 'retry', error: errorMessage(e) };
    }
    afterFire(l.r);
    return { status: 'done' };
  };

  const checkinFire: JobHandler = async (job, ctx): Promise<JobResult> => {
    const l = load(job);
    if (!l) return { status: 'done' };
    const { r, owner } = l;
    const late = lateness(job.runAt, ctx.now);
    // A check-in that is a day late is no longer a conversation starter: it falls back to the deterministic message.
    if (late === 'missed') {
      send(job, r, owner, late);
      reportSent(r, owner, 'checkin', ctx.now);
      afterFire(r);
      return { status: 'done' };
    }
    const sc = parseScopeKey(r.scope);
    if (!sc) return { status: 'dead', error: 'bad scope' };
    try {
      const conv =
        sc.kind === 'user'
          ? s.conversations.resolve(
              { kind: 'dm', tgUserId: owner!.tgUserId, ...(r.targetThreadId ? { threadId: r.targetThreadId } : {}) },
              { userId: owner!.id, tgChatId: r.targetChatId, ...(r.targetThreadId ? { threadId: r.targetThreadId } : {}) },
            )
          : s.conversations.resolve(
              { kind: 'group', chatId: sc.chatId, ...(r.targetThreadId ? { threadId: r.targetThreadId } : {}) },
              { userId: null, tgChatId: sc.chatId, ...(r.targetThreadId ? { threadId: r.targetThreadId } : {}) },
            );
      const lang = owner?.languageCode ?? 'en';
      const at = formatDisplay(job.runAt, r.tz, lang);
      const body =
        `Scheduled check-in ${r.id} (${r.scheduleKind === 'cron' ? `recurring, cron "${r.cron}"` : 'one-off'}) due ${at}${late === 'late' ? ' (late)' : ''}.\n` +
        `The owner asked to be checked in with about: ${r.text}\n` +
        'Ask one short, friendly question about it and follow up on the answer. Do not call tools unless the owner asks.';
      s.runner.startEventRun(
        conv.id,
        { type: 'checkin', ref: r.id, body },
        { channel: 'notify', replyRef: { chatId: r.targetChatId, ...(r.targetThreadId ? { threadId: r.targetThreadId } : {}) }, priority: JOB_LLM_PRIORITY.checkin_fire ?? 'reminder' },
      );
      reportSent(r, owner, 'checkin', ctx.now);
    } catch (e) {
      log().warn({ reminderId: r.id, err: errorMessage(e) }, 'check-in run could not start');
      return { status: 'retry', error: errorMessage(e) };
    }
    afterFire(r);
    return { status: 'done' };
  };

  return { reminderFire, checkinFire };
}
