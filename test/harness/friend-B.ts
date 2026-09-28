// test/harness/friend-B.ts (friend set B) — helpers for the behaviour / proactive-policy tests: a full-stack TestApp
// with a settable τ and budget, users with a known zone, seeded rhythm history, scripted compose / judge parses and a
// view of the proactive messages that actually reached Telegram.
import type { UserRow } from '../../src/contracts/index.ts';
import { wallTimeOf, zonedToInstant, addDaysToDate } from '../../src/kernel/timeMath.ts';
import { createFakeGovernance, type FakeLlmBudget } from './fakes.ts';
import { createTestApp, type TestApp } from './testApp.ts';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const HALF_HOUR = 30 * 60_000;

export interface FriendApp extends TestApp { budget: FakeLlmBudget }

/** A full-stack app (real behaviour, proactive, memory, scheduler) on a FakeClock; the LLM budget is a settable fake. */
export async function createFriendApp(o: { now?: number; tau?: number } = {}): Promise<FriendApp> {
  const gov = createFakeGovernance();
  const t = await createTestApp({
    now: o.now ?? Date.UTC(2026, 9, 5, 0, 0), // Mon 5 Oct 2026, 00:00 UTC
    ...(o.tau !== undefined ? { config: { proactive: { tau: o.tau } } } : {}),
    factories: { createLlmGovernance: () => gov },
  });
  // The background loops (dispatcher 1 s, scheduler, outbox) would fire thousands of FakeClock timers per simulated day;
  // t.advance() already runs scheduler.tick() and settle() (dispatcher.drain + outbox.flush), so stop the loops.
  await t.app.tg.dispatcher.stop();
  await t.s.scheduler.stop();
  await t.s.telegram.outbox.stop();
  return Object.assign(t, { budget: gov.budget });
}

let nextTg = 77_000;
export function addUser(t: TestApp, o: { tgUserId?: number; tz?: string; lang?: string } = {}): UserRow {
  const id = o.tgUserId ?? ++nextTg;
  const u = t.s.repos.users.upsertFromTelegram({ id, first_name: 'Aigerim', language_code: o.lang ?? 'en' }, { dmChatId: id });
  t.s.repos.users.update(u.id, { tz: o.tz ?? 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done' });
  return t.s.repos.users.getById(u.id)!;
}

/** Instant of a local wall time `daysFromNow` days from the clock's local date. */
export function localAt(t: TestApp, tz: string, daysFromNow: number, hour: number, minute = 0): number {
  const w = wallTimeOf(t.clock.now(), tz);
  const d = addDaysToDate(w.year, w.month, w.day, daysFromNow);
  return zonedToInstant({ ...d, hour, minute }, tz).instant;
}

/** The owner wrote at `hour:minute` local on each of the `days` days before today (features from `text`). */
export function seedHistory(t: TestApp, u: UserRow, o: { days: number; hour: number; minute?: number; text?: string }): void {
  for (let d = o.days; d >= 1; d--) t.s.signals.inbound(u.id, { at: localAt(t, u.tz, -d, o.hour, o.minute ?? 15), text: o.text ?? 'привет, как дела? что посоветуешь?' });
}

export function scriptSends(t: TestApp, n: number, o: { text?: string; send?: boolean; reason?: string } = {}): void {
  for (let i = 0; i < n; i++) {
    t.llm.pushParse('compose', { text: o.text ?? `Hey! How did your week go? ${i}` });
    t.llm.pushParse('judge', { send: o.send ?? true, reason: o.reason ?? 'natural and light' });
  }
}

/** Proactive messages delivered to the owner's chat (sendMessage with a proactive_log link). */
export function proactiveSends(t: TestApp, u: UserRow): Array<{ at: number; text: string; messageId: number }> {
  return t.tg.calls
    .filter((c) => c.method === 'sendMessage' && c.payload.chat_id === (u.dmChatId ?? u.tgUserId) && !c.error)
    .map((c) => ({ at: c.at, text: String(c.payload.text ?? ''), messageId: Number((c.result as { message_id?: number } | undefined)?.message_id ?? 0) }))
    .filter((m) => {
      const link = t.s.telegram.links.lookup(u.dmChatId ?? u.tgUserId, m.messageId);
      return !!link?.nudgeId?.startsWith('pl_');
    });
}

export const STEP = 10 * 60_000;
/** Advances the clock in 10-minute steps (every 30-min proactive tick and every jittered send job runs), `ms` in total. */
export async function advanceTicks(t: TestApp, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= STEP) await t.advance(Math.min(STEP, left));
}

export function localHour(at: number, tz: string): number {
  return wallTimeOf(at, tz).hour;
}
