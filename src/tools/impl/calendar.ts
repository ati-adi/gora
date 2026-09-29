// tools/impl/calendar.ts (WP5, s07 CAL) — calendar_* (01 §6, F9). Own events without attendees: write_self + Undo;
// anything that notifies other people (attendees, invite responses) asks; deletions ask with scope once and are never
// grantable. Not connected (spec 07 B2): the tool sends the one-line Connect card itself (with this run's conversation
// as the resume target) and tells the model to say one short line — the question resumes after "Готово ✓".
import { z } from 'zod';
import type { ApprovalDiff, CalendarApi, CalEvent, CalEventInput, Classification, IntegrationService, Ms, Target, ToolCtx, ToolOutput, ToolSpec, UserId } from '../../contracts/index.ts';
import { AbortedError, errorMessage } from '../../kernel/errors.ts';
import { formatDisplay, isoWithOffset, parseLocal, wallTimeOf, zonedToInstant } from '../../kernel/timeMath.ts';
import { zEmail, zLocal, zTz } from '../schema.ts';
import { forgetEvent, knownEvent, memoEntry, rememberEvents } from './calMemo.ts';
import { FULL_SURFACES, isAmbiguousProviderError, L, OutcomeUnknownError, ownerOf, toolError, truncate } from './common.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const WORK_START = 9;
const WORK_END = 18;

// ── helpers
function calOf(ctx: ToolCtx): { userId: UserId; api: CalendarApi } | null {
  const userId = ownerOf(ctx);
  if (!userId) return null;
  const api = ctx.services.integrations.calendar(userId);
  return api ? { userId, api } : null;
}
/** B2: the owner in a DM/topic gets the Connect card right here (the service dedupes it per chat), no extra model round. */
async function notConnected(ctx: ToolCtx): Promise<ToolOutput<never>> {
  const userId = ownerOf(ctx);
  if (userId && ctx.scope?.kind === 'user' && (ctx.surface === 'dm' || ctx.surface === 'topic')) {
    const chat: Parameters<IntegrationService['sendConnectCard']>[2] = { chatId: ctx.chat.chatId, ...(ctx.chat.threadId !== undefined ? { threadId: ctx.chat.threadId } : {}), resumeConversationId: ctx.conversationId };
    try {
      await ctx.services.integrations.sendConnectCard(userId, 'gcal', chat);
      return toolError('NOT_CONNECTED', 'Google Calendar is not connected. A Connect button was just sent: say ONE short line and stop. The question resumes automatically after the owner connects.');
    } catch (e) {
      ctx.log.warn({ tool: 'calendar', err: errorMessage(e) }, 'connect card failed');
    }
  }
  return toolError('NOT_CONNECTED', 'Google Calendar is not connected; call integration_connect');
}

function localToMs(local: string, tz: string): Ms | null {
  const w = parseLocal(local);
  return w ? zonedToInstant(w, tz).instant : null;
}
function show(iso: string, tz: string, lang: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? formatDisplay(t, tz, lang) : iso;
}
function attendeeTargets(emails: readonly string[]): Target[] {
  return emails.map((value) => ({ kind: 'gcal_attendee', value: value.toLowerCase(), hmac: '', provenance: 'unknown' }));
}
function eventView(e: CalEvent, lang: string) {
  return {
    id: e.id, title: e.title, start: show(e.start, e.tz, lang), end: show(e.end, e.tz, lang), tz: e.tz,
    attendees: e.attendees, ...(e.location ? { location: e.location } : {}), ...(e.description ? { description: truncate(e.description, 500) } : {}),
    organizer: e.organizerSelf ? 'you' : 'someone else',
  };
}
async function withApi<T>(ctx: ToolCtx, tool: string, f: (c: { userId: UserId; api: CalendarApi }) => Promise<ToolOutput<T>>): Promise<ToolOutput<T>> {
  const c = calOf(ctx);
  if (!c) return notConnected(ctx);
  try {
    return await f(c);
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    const msg = errorMessage(e);
    ctx.log.warn({ tool, err: msg }, 'calendar call failed');
    if (e instanceof OutcomeUnknownError) throw e; // the executor reconciles; never a definite "failed"
    if (/not supported by provider/i.test(msg)) return toolError('NOT_SUPPORTED', 'not supported by provider');
    if (/integrations misconfigured/i.test(msg)) return toolError('INTEGRATIONS_MISCONFIGURED', 'the calendar is unavailable right now (server configuration); tell the user briefly');
    if (/not found/i.test(msg)) return toolError('NOT_FOUND', 'event not found');
    return toolError('CALENDAR_FAILED', 'the calendar call failed; tell the user');
  }
}
/**
 * The CURRENT version of an event by id, always fetched from the provider (renderDiff/targets/execute must not trust the
 * memo: guests may have been added since it was listed). CalendarApi has no get-by-id, so the memo's start (if any) only
 * narrows the first scan (±31 days); otherwise, or when the event moved, ±400 days are scanned.
 */
async function findEvent(api: CalendarApi, userId: UserId, id: string, now: Ms): Promise<CalEvent | null> {
  const hint = memoEntry(userId, id);
  const hintStart = hint ? Date.parse(hint.start) : NaN;
  if (Number.isFinite(hintStart)) {
    const near = await api.list({ fromIso: new Date(hintStart - 31 * DAY).toISOString(), toIso: new Date(hintStart + 31 * DAY).toISOString(), max: 250 });
    rememberEvents(userId, near, now);
    const hit = near.find((e) => e.id === id);
    if (hit) return hit;
  }
  const list = await api.list({ fromIso: new Date(now - 400 * DAY).toISOString(), toIso: new Date(now + 400 * DAY).toISOString(), max: 250 });
  rememberEvents(userId, list, now);
  const hit = list.find((e) => e.id === id) ?? null;
  if (!hit) forgetEvent(userId, id);
  return hit;
}
/** Only the owner is involved: organizer is self and nobody else is invited. */
const selfOnly = (e: CalEvent): boolean => e.organizerSelf && e.attendees.length === 0;

// ── calendar_list_events
const listInput = z.object({ from_local: zLocal, to_local: zLocal, query: z.string().max(200).optional() });
type ListIn = z.infer<typeof listInput>;
const listTool: ToolSpec<ListIn> = {
  name: 'calendar_list_events',
  description: "List the owner's calendar events in a time range. Call for schedule questions (\"what's on tomorrow\").",
  input: listInput,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  classify: () => ({ actionClass: 'read_private', risk: 0, integration: 'gcal', requiredLevel: 'read' }),
  statusLabel: (_i, lang) => L(lang, '📅 Checking the calendar…', '📅 Смотрю календарь…'),
  execute: (i, ctx) =>
    withApi(ctx, 'calendar_list_events', async ({ userId, api }) => {
      const from = localToMs(i.from_local, ctx.tz);
      const to = localToMs(i.to_local, ctx.tz);
      if (from === null || to === null || to <= from) return toolError('INVALID_RANGE', 'from_local must be before to_local');
      const events = await api.list({ fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), ...(i.query ? { query: i.query } : {}), max: 50 });
      rememberEvents(userId, events, ctx.now);
      const foreign = events.some((e) => !e.organizerSelf);
      const out: ToolOutput = { content: JSON.stringify({ events: events.map((e) => eventView(e, ctx.lang)) }), data: { count: events.length } };
      if (foreign) out.untrusted = { source: 'calendar', label: 'calendar events' };
      return out;
    }),
};

// ── calendar_find_free_slots
const freeInput = z.object({ from_local: zLocal, to_local: zLocal, duration_min: z.number().int().min(5).max(1440), working_hours_only: z.boolean().optional() });
type FreeIn = z.infer<typeof freeInput>;

/** Free slots (pure; exported for tests): gaps ≥ duration between busy intervals, optionally within 09:00–18:00 local. */
export function freeSlots(from: Ms, to: Ms, busy: Array<{ start: Ms; end: Ms }>, durationMs: number, tz: string, workingOnly: boolean, max = 10): Array<{ start: Ms; end: Ms }> {
  const windows: Array<{ start: Ms; end: Ms }> = [];
  if (!workingOnly) windows.push({ start: from, end: to });
  else {
    let w = wallTimeOf(from, tz);
    for (let d = 0; d < 62; d++) {
      const day = { year: w.year, month: w.month, day: w.day };
      const s = zonedToInstant({ ...day, hour: WORK_START, minute: 0 }, tz).instant;
      const e = zonedToInstant({ ...day, hour: WORK_END, minute: 0 }, tz).instant;
      const wd = wallTimeOf(s, tz).weekday;
      if (wd !== 0 && wd !== 6) windows.push({ start: Math.max(s, from), end: Math.min(e, to) });
      if (e >= to) break;
      w = wallTimeOf(e + 12 * 3_600_000, tz);
    }
  }
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const out: Array<{ start: Ms; end: Ms }> = [];
  for (const win of windows) {
    let cur = win.start;
    for (const b of sorted) {
      if (b.end <= cur || b.start >= win.end) continue;
      if (b.start - cur >= durationMs) out.push({ start: cur, end: b.start });
      cur = Math.max(cur, b.end);
    }
    if (win.end - cur >= durationMs) out.push({ start: cur, end: win.end });
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

const freeTool: ToolSpec<FreeIn> = {
  name: 'calendar_find_free_slots',
  description: 'Find free time slots of a given length in the owner calendar. Call before proposing meeting times.',
  input: freeInput,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  classify: () => ({ actionClass: 'read_private', risk: 0, integration: 'gcal', requiredLevel: 'read' }),
  statusLabel: (_i, lang) => L(lang, '📅 Looking for free time…', '📅 Ищу свободное время…'),
  execute: (i, ctx) =>
    withApi(ctx, 'calendar_find_free_slots', async ({ api }) => {
      const from = localToMs(i.from_local, ctx.tz);
      const to = localToMs(i.to_local, ctx.tz);
      if (from === null || to === null || to <= from) return toolError('INVALID_RANGE', 'from_local must be before to_local');
      if (to - from > 62 * DAY) return toolError('INVALID_RANGE', 'the range may span at most 62 days');
      const busy = (await api.freeBusy({ fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() }))
        .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
        .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
      const slots = freeSlots(Math.max(from, ctx.now), to, busy, i.duration_min * MIN, ctx.tz, i.working_hours_only ?? false);
      const view = slots.map((s) => ({ start_local: isoWithOffset(s.start, ctx.tz).slice(0, 16), display: `${formatDisplay(s.start, ctx.tz, ctx.lang)} – ${formatDisplay(s.end, ctx.tz, ctx.lang).split(', ')[1] ?? ''}` }));
      return { content: JSON.stringify({ slots: view }), data: { count: view.length } };
    }),
};

// ── calendar_create_event
const createInput = z.object({
  title: z.string().min(1).max(200),
  start_local: zLocal,
  end_local: zLocal.optional(),
  duration_min: z.number().int().min(1).max(1440).optional(),
  tz: zTz.optional(),
  attendees: z.array(zEmail).max(20).optional(),
  location: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
});
type CreateIn = z.infer<typeof createInput>;

function toEventInput(i: CreateIn, ctx: ToolCtx): CalEventInput | string {
  const tz = i.tz ?? ctx.tz;
  const start = localToMs(i.start_local, tz);
  if (start === null) return 'invalid start_local';
  let end = i.end_local ? localToMs(i.end_local, tz) : start + (i.duration_min ?? 60) * MIN;
  if (end === null || end <= start) return 'end must be after start';
  if (end - start > 14 * DAY) end = start + 14 * DAY;
  return {
    title: i.title, start: isoWithOffset(start, tz), end: isoWithOffset(end, tz), tz, attendees: [...new Set((i.attendees ?? []).map((a) => a.toLowerCase()))],
    ...(i.location ? { location: i.location } : {}), ...(i.description ? { description: i.description } : {}),
  };
}

const createTool: ToolSpec<CreateIn> = {
  name: 'calendar_create_event',
  description: 'Create an event on the owner calendar; with attendees it sends invites after approval. Call when asked to book or schedule.',
  input: createInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: (i): Classification => {
    const n = i.attendees?.length ?? 0;
    return n === 0
      ? { actionClass: 'write_self', risk: 1, integration: 'gcal', requiredLevel: 'draft' }
      : { actionClass: 'send_external', risk: 2, integration: 'gcal', requiredLevel: 'act', bulkCount: n };
  },
  targets: async (i) => attendeeTargets(i.attendees ?? []),
  async renderDiff(i, ctx): Promise<ApprovalDiff> {
    const e = toEventInput(i, ctx);
    if (typeof e === 'string') return { title: '📅 New event', summary: e, rows: [], warnings: [e], targets: [] };
    return {
      title: '📅 New event with invites',
      summary: `${e.title} — ${show(e.start, e.tz, ctx.lang)}`,
      rows: [['When', `${show(e.start, e.tz, ctx.lang)} → ${show(e.end, e.tz, ctx.lang)}`], ['Zone', e.tz], ['Invites', e.attendees.join(', ')], ...(e.location ? ([['Where', e.location]] as Array<[string, string]>) : [])],
      ...(e.description ? { body: { label: 'Description', text: e.description } } : {}),
      warnings: ['Invitations will be emailed to every attendee.'],
      targets: attendeeTargets(e.attendees),
    };
  },
  statusLabel: (_i, lang) => L(lang, '📅 Creating the event…', '📅 Создаю событие…'),
  execute: (i, ctx) =>
    withApi(ctx, 'calendar_create_event', async ({ userId, api }) => {
      const e = toEventInput(i, ctx);
      if (typeof e === 'string') return toolError('INVALID_INPUT', e);
      if (Date.parse(e.start) < ctx.now - 5 * MIN) return toolError('IN_PAST', 'the start time is in the past; confirm the date with the user');
      const existing = await api.findByIdem(ctx.idemKey);
      let ev: CalEvent;
      try {
        ev = existing ?? (await api.create(e, ctx.idemKey));
      } catch (err) {
        if (!isAmbiguousProviderError(err)) throw err;
        // The response was lost: Google may already have created the event and emailed the invites. Look it up by the
        // idempotency key; if it is not (yet) visible the outcome is unknown and the executor reconciles.
        const found = await api.findByIdem(ctx.idemKey).catch(() => null);
        if (!found) throw new OutcomeUnknownError('calendar_create_event', err);
        ev = found;
      }
      rememberEvents(userId, [ev], ctx.now);
      const when = show(ev.start, ev.tz, ctx.lang);
      const out: ToolOutput = {
        content: JSON.stringify({ created: eventView(ev, ctx.lang) }),
        data: { eventId: ev.id },
        ledger: [{ kind: 'calendar_changed', summary: `event created${ev.attendees.length ? ` with ${ev.attendees.length} invitee(s)` : ''}`, runId: ctx.runId, toolUseId: ctx.toolUseId }],
      };
      if (ev.attendees.length === 0) out.undo = { payload: { userId, eventId: ev.id }, line: `📅 ${truncate(ev.title, 60)} — ${when}` };
      return out;
    }),
  async reconcile(_i, ctx) {
    const c = calOf(ctx);
    if (!c) return 'unknown';
    try {
      return (await c.api.findByIdem(ctx.idemKey)) ? 'done' : 'not_done';
    } catch {
      return 'unknown';
    }
  },
  async undo(payload, ctx) {
    const p = payload as { userId: UserId; eventId: string };
    const api = ctx.services.integrations.calendar(p.userId);
    if (!api) throw new Error('calendar is no longer connected');
    await api.remove(p.eventId);
    forgetEvent(p.userId, p.eventId);
  },
};

// ── calendar_update_event
const updateInput = z.object({
  event_id: z.string().min(1).max(256),
  patch: z.object({ title: z.string().min(1).max(200).optional(), start_local: zLocal.optional(), end_local: zLocal.optional(), location: z.string().max(300).optional(), description: z.string().max(2000).optional() }),
});
type UpdateIn = z.infer<typeof updateInput>;

function toPatch(i: UpdateIn, prev: CalEvent | null, tz: string): Partial<CalEventInput> | string {
  const p: Partial<CalEventInput> = {};
  const zone = prev?.tz ?? tz;
  if (i.patch.title !== undefined) p.title = i.patch.title;
  if (i.patch.location !== undefined) p.location = i.patch.location;
  if (i.patch.description !== undefined) p.description = i.patch.description;
  if (i.patch.start_local !== undefined) {
    const s = localToMs(i.patch.start_local, zone);
    if (s === null) return 'invalid start_local';
    p.start = isoWithOffset(s, zone);
    if (i.patch.end_local === undefined && prev) p.end = isoWithOffset(s + Math.max(MIN, Date.parse(prev.end) - Date.parse(prev.start)), zone);
  }
  if (i.patch.end_local !== undefined) {
    const e = localToMs(i.patch.end_local, zone);
    if (e === null) return 'invalid end_local';
    p.end = isoWithOffset(e, zone);
  }
  const start = Date.parse(p.start ?? prev?.start ?? '');
  const end = Date.parse(p.end ?? prev?.end ?? '');
  if (Number.isFinite(start) && Number.isFinite(end) && end <= start) return 'end must be after start';
  if (!Object.keys(p).length) return 'the patch is empty';
  if (p.start || p.end) p.tz = zone;
  return p;
}

const updateTool: ToolSpec<UpdateIn> = {
  name: 'calendar_update_event',
  description: 'Change an existing calendar event (title, time, place, notes). Call when asked to move or edit an event; get its id first.',
  input: updateInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: (i, ctx): Classification => {
    const ev = knownEvent(ownerOf(ctx), i.event_id, ctx.now);
    if (ev && selfOnly(ev)) return { actionClass: 'write_self', risk: 1, integration: 'gcal', requiredLevel: 'draft' };
    return { actionClass: 'send_external', risk: 2, integration: 'gcal', requiredLevel: 'act', ...(ev ? { bulkCount: ev.attendees.length } : {}) };
  },
  async targets(i, ctx) {
    const c = calOf(ctx);
    const ev = c ? await findEvent(c.api, c.userId, i.event_id, ctx.now).catch(() => null) : null;
    return attendeeTargets(ev?.attendees ?? []);
  },
  async renderDiff(i, ctx): Promise<ApprovalDiff> {
    const c = calOf(ctx);
    const ev = c ? await findEvent(c.api, c.userId, i.event_id, ctx.now) : null;
    if (!ev) return { title: '📅 Update event', summary: 'event not found', rows: [], warnings: ['This event could not be found.'], targets: [] };
    const p = toPatch(i, ev, ctx.tz);
    const rows: Array<[string, string]> = [['Event', ev.title]];
    if (typeof p !== 'string') {
      if (p.title) rows.push(['Title', `${ev.title} → ${p.title}`]);
      if (p.start || p.end) rows.push(['When', `${show(ev.start, ev.tz, ctx.lang)} → ${show(p.start ?? ev.start, ev.tz, ctx.lang)}`]);
      if (p.location !== undefined) rows.push(['Where', `${ev.location ?? '—'} → ${p.location}`]);
    }
    if (ev.attendees.length) rows.push(['Attendees', ev.attendees.join(', ')]);
    return {
      title: '📅 Update event',
      summary: `${ev.title} — ${show(ev.start, ev.tz, ctx.lang)}`,
      rows,
      ...(typeof p !== 'string' && p.description !== undefined ? { body: { label: 'New description', text: p.description } } : {}),
      warnings: [...(typeof p === 'string' ? [p] : []), ...(ev.attendees.length ? ['Attendees will be notified of the change.'] : [])],
      targets: attendeeTargets(ev.attendees),
    };
  },
  statusLabel: (_i, lang) => L(lang, '📅 Updating the event…', '📅 Меняю событие…'),
  execute: (i, ctx) =>
    withApi(ctx, 'calendar_update_event', async ({ userId, api }) => {
      // What classify() decided from (read before findEvent refreshes the memo).
      const seen = memoEntry(userId, i.event_id);
      const prev = await findEvent(api, userId, i.event_id, ctx.now);
      if (!prev) return toolError('NOT_FOUND', 'event not found; list events to get its id');
      // Auto-run as the owner's own event (write_self, no card), but it now involves other people: never edit it
      // silently. The memo now holds the fresh version, so calling again classifies it send_external (ask).
      const approved = ctx.approvedAction !== undefined;
      if (!approved && seen && selfOnly(seen) && !selfOnly(prev)) {
        return toolError('NEEDS_APPROVAL', 'this event now has other attendees, so changing it notifies them; call calendar_update_event again to ask the owner');
      }
      const p = toPatch(i, prev, ctx.tz);
      if (typeof p === 'string') return toolError('INVALID_INPUT', p);
      const ev = await api.update(i.event_id, p);
      rememberEvents(userId, [ev], ctx.now);
      const out: ToolOutput = {
        content: JSON.stringify({ updated: eventView(ev, ctx.lang) }),
        data: { eventId: ev.id },
        ledger: [{ kind: 'calendar_changed', summary: 'event updated', runId: ctx.runId, toolUseId: ctx.toolUseId }],
      };
      if (selfOnly(prev)) {
        const restore: Partial<CalEventInput> = { title: prev.title, start: prev.start, end: prev.end, tz: prev.tz, location: prev.location ?? '', description: prev.description ?? '' };
        out.undo = { payload: { userId, eventId: ev.id, restore }, line: `📅 ${truncate(ev.title, 60)} — ${show(ev.start, ev.tz, ctx.lang)}` };
      }
      return out;
    }),
  async undo(payload, ctx) {
    const p = payload as { userId: UserId; eventId: string; restore: Partial<CalEventInput> };
    const api = ctx.services.integrations.calendar(p.userId);
    if (!api) throw new Error('calendar is no longer connected');
    rememberEvents(p.userId, [await api.update(p.eventId, p.restore)], ctx.now);
  },
};

// ── calendar_delete_event
const deleteInput = z.object({ event_id: z.string().min(1).max(256) });
type DeleteIn = z.infer<typeof deleteInput>;
const deleteTool: ToolSpec<DeleteIn> = {
  name: 'calendar_delete_event',
  description: 'Delete a calendar event (always asks the owner first). Call only when the owner asks to remove or cancel an event.',
  input: deleteInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: (i, ctx): Classification => {
    const ev = knownEvent(ownerOf(ctx), i.event_id, ctx.now);
    return { actionClass: 'destructive', risk: 3, integration: 'gcal', requiredLevel: ev && ev.attendees.length === 0 ? 'draft' : 'act', grantable: false };
  },
  async targets(i, ctx) {
    const c = calOf(ctx);
    const ev = c ? await findEvent(c.api, c.userId, i.event_id, ctx.now).catch(() => null) : null;
    return attendeeTargets(ev?.attendees ?? []);
  },
  async renderDiff(i, ctx): Promise<ApprovalDiff> {
    const c = calOf(ctx);
    const ev = c ? await findEvent(c.api, c.userId, i.event_id, ctx.now) : null;
    if (!ev) return { title: '🗑 Delete event', summary: 'event not found', rows: [], warnings: ['This event could not be found.'], targets: [] };
    return {
      title: '🗑 Delete event',
      summary: `${ev.title} — ${show(ev.start, ev.tz, ctx.lang)}`,
      rows: [['Event', ev.title], ['When', show(ev.start, ev.tz, ctx.lang)], ['Attendees', ev.attendees.length ? ev.attendees.join(', ') : '—']],
      warnings: ev.attendees.length ? ['Attendees will be told the event was cancelled.'] : [],
      targets: attendeeTargets(ev.attendees),
    };
  },
  statusLabel: (_i, lang) => L(lang, '🗑 Deleting the event…', '🗑 Удаляю событие…'),
  execute: (i, ctx) =>
    withApi(ctx, 'calendar_delete_event', async ({ userId, api }) => {
      try {
        await api.remove(i.event_id);
      } catch (e) {
        if (!/not found|gone|deleted/i.test(errorMessage(e))) throw e; // idempotent: already deleted
      }
      forgetEvent(userId, i.event_id);
      return { content: JSON.stringify({ deleted: i.event_id }), ledger: [{ kind: 'calendar_changed', summary: 'event deleted', runId: ctx.runId, toolUseId: ctx.toolUseId }] };
    }),
};

// ── calendar_respond_invite
const respondInput = z.object({ event_id: z.string().min(1).max(256), response: z.enum(['accepted', 'declined', 'tentative']) });
type RespondIn = z.infer<typeof respondInput>;
const respondTool: ToolSpec<RespondIn> = {
  name: 'calendar_respond_invite',
  description: 'Accept, decline or tentatively accept a calendar invitation (the organizer sees it). Call when asked to RSVP.',
  input: respondInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'send_external', risk: 2, integration: 'gcal', requiredLevel: 'act' }),
  async renderDiff(i, ctx): Promise<ApprovalDiff> {
    const c = calOf(ctx);
    const ev = c ? await findEvent(c.api, c.userId, i.event_id, ctx.now) : null;
    const label = { accepted: 'Accept', declined: 'Decline', tentative: 'Maybe' }[i.response];
    return {
      title: `📅 ${label} invitation`,
      summary: ev ? `${ev.title} — ${show(ev.start, ev.tz, ctx.lang)}` : i.event_id,
      rows: [['Event', ev?.title ?? i.event_id], ...(ev ? ([['When', show(ev.start, ev.tz, ctx.lang)]] as Array<[string, string]>) : []), ['Response', label]],
      warnings: ['The organizer will see your response.', ...(ev ? [] : ['This event could not be found.'])],
      targets: [],
    };
  },
  statusLabel: (_i, lang) => L(lang, '📅 Replying to the invite…', '📅 Отвечаю на приглашение…'),
  execute: (i, ctx) =>
    withApi(ctx, 'calendar_respond_invite', async ({ api }) => {
      await api.respond(i.event_id, i.response);
      return { content: JSON.stringify({ responded: i.response, event_id: i.event_id }), ledger: [{ kind: 'calendar_changed', summary: `invitation ${i.response}`, runId: ctx.runId, toolUseId: ctx.toolUseId }] };
    }),
};

export const CALENDAR_TOOLS: readonly ToolSpec[] = [createTool, deleteTool, freeTool, listTool, respondTool, updateTool];
