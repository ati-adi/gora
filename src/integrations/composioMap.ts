// integrations/composioMap.ts (WP5) — ⚠U11: every Composio action slug and argument mapping lives here. Slugs and
// argument names are not verified against a live account; an operation mapped to null returns a clean
// "not supported by provider" error (the tools turn it into is_error). Response parsing is defensive.
import type { CalEvent, CalEventInput, DraftInput, IntegrationKind, MailThread, MailThreadSummary } from '../contracts/index.ts';

export const COMPOSIO_TOOLKIT: Record<IntegrationKind, string> = { gmail: 'gmail', gcal: 'googlecalendar' };

export type MailOp = 'search' | 'readThread' | 'createDraft' | 'getDraft' | 'deleteDraft' | 'sendDraft' | 'findSent';
export type CalOp = 'list' | 'freeBusy' | 'create' | 'update' | 'remove' | 'respond' | 'findByIdem';

export const MAIL_SLUGS: Readonly<Record<MailOp, string | null>> = Object.freeze({
  search: 'GMAIL_FETCH_EMAILS',
  readThread: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  createDraft: 'GMAIL_CREATE_EMAIL_DRAFT',
  getDraft: 'GMAIL_GET_DRAFT',
  deleteDraft: 'GMAIL_DELETE_DRAFT',
  sendDraft: 'GMAIL_SEND_DRAFT',
  findSent: 'GMAIL_FETCH_EMAILS',
});
export const CAL_SLUGS: Readonly<Record<CalOp, string | null>> = Object.freeze({
  list: 'GOOGLECALENDAR_EVENTS_LIST',
  freeBusy: 'GOOGLECALENDAR_FREE_BUSY_QUERY',
  create: 'GOOGLECALENDAR_CREATE_EVENT',
  update: 'GOOGLECALENDAR_PATCH_EVENT',
  remove: 'GOOGLECALENDAR_DELETE_EVENT',
  respond: null, // no documented RSVP action: not supported by provider
  findByIdem: 'GOOGLECALENDAR_EVENTS_LIST',
});

// ── argument builders
export const mailArgs = {
  search: (q: { query: string; maxResults: number; newerThanDays?: number }) => ({ query: `${q.query}${q.newerThanDays ? ` newer_than:${q.newerThanDays}d` : ''}`.trim(), max_results: q.maxResults, include_payload: false }),
  readThread: (threadId: string) => ({ thread_id: threadId }),
  createDraft: (d: DraftInput) => ({ recipient_email: d.to[0], extra_recipients: d.to.slice(1), cc: d.cc, subject: d.subject, body: d.body, ...(d.replyToThreadId ? { thread_id: d.replyToThreadId } : {}) }),
  getDraft: (draftId: string) => ({ draft_id: draftId }),
  deleteDraft: (draftId: string) => ({ draft_id: draftId }),
  sendDraft: (draftId: string) => ({ draft_id: draftId }),
  findSent: (q: { to: string; subject: string; afterMs: number }) => ({ query: `in:sent to:${q.to} subject:"${q.subject.replace(/"/g, '')}" after:${Math.floor(q.afterMs / 1000)}`, max_results: 5 }),
};
/** The idempotency key travels as a private extended property so findByIdem can look it up. */
export const IDEM_PROP = 'gora_idem';
export const calArgs = {
  list: (q: { fromIso: string; toIso: string; query?: string; max: number }) => ({ calendar_id: 'primary', timeMin: q.fromIso, timeMax: q.toIso, ...(q.query ? { q: q.query } : {}), maxResults: q.max, singleEvents: true, orderBy: 'startTime' }),
  freeBusy: (q: { fromIso: string; toIso: string }) => ({ timeMin: q.fromIso, timeMax: q.toIso, items: [{ id: 'primary' }] }),
  create: (e: CalEventInput, idemKey: string) => ({
    calendar_id: 'primary', summary: e.title, start_datetime: e.start, end_datetime: e.end, timezone: e.tz, attendees: e.attendees, send_updates: e.attendees.length > 0,
    ...(e.location ? { location: e.location } : {}), ...(e.description ? { description: e.description } : {}), extended_properties: { private: { [IDEM_PROP]: idemKey } },
  }),
  update: (id: string, p: Partial<CalEventInput>) => ({
    calendar_id: 'primary', event_id: id, ...(p.title !== undefined ? { summary: p.title } : {}), ...(p.start ? { start_time: p.start } : {}), ...(p.end ? { end_time: p.end } : {}),
    ...(p.tz ? { timezone: p.tz } : {}), ...(p.location !== undefined ? { location: p.location } : {}), ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.attendees ? { attendees: p.attendees } : {}),
  }),
  remove: (id: string) => ({ calendar_id: 'primary', event_id: id }),
  findByIdem: (idemKey: string) => ({ calendar_id: 'primary', privateExtendedProperty: `${IDEM_PROP}=${idemKey}`, maxResults: 1 }),
};

// ── response parsers (defensive: Composio wraps Google payloads in `data` with varying nesting)
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
/** Unwraps data / response_data / nested data. */
export function payload(data: unknown): J {
  let o = obj(data);
  for (let i = 0; i < 3; i++) {
    const inner = o['response_data'] ?? o['data'];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) o = inner as J;
    else break;
  }
  return o;
}
function header(m: J, name: string): string {
  const h = arr(obj(m['payload'])['headers']).map(obj).find((x) => str(x['name']).toLowerCase() === name);
  return str(m[name] ?? m[name === 'from' ? 'sender' : name] ?? h?.['value']);
}
const splitAddrs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : str(v).split(',')).map((x) => x.trim()).filter(Boolean);
const toMs = (v: unknown): number => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
};

export function parseMessages(data: unknown): J[] {
  const p = payload(data);
  return arr(p['messages'] ?? p['emails'] ?? p['items']).map(obj);
}
export function toSummaries(data: unknown): MailThreadSummary[] {
  return parseMessages(data).map((m) => ({
    threadId: str(m['threadId'] ?? m['thread_id'] ?? m['id'] ?? m['messageId']),
    from: header(m, 'from'), subject: header(m, 'subject'), snippet: str(m['snippet'] ?? m['preview'] ?? m['messageText']).slice(0, 300),
    date: toMs(m['messageTimestamp'] ?? m['internalDate'] ?? m['date']), unread: arr(m['labelIds']).map(str).includes('UNREAD'),
  })).filter((t) => t.threadId);
}
export function toThread(threadId: string, data: unknown): MailThread {
  return {
    threadId,
    messages: parseMessages(data).map((m) => ({
      from: header(m, 'from'), to: splitAddrs(m['to'] ?? header(m, 'to')), cc: splitAddrs(m['cc'] ?? header(m, 'cc')), subject: header(m, 'subject'),
      date: toMs(m['messageTimestamp'] ?? m['internalDate'] ?? m['date']), text: str(m['messageText'] ?? m['text'] ?? m['body'] ?? m['snippet']),
    })),
  };
}
export function draftIdOf(data: unknown): string {
  const p = payload(data);
  return str(p['id'] ?? p['draft_id'] ?? obj(p['draft'])['id']);
}
export function toDraft(draftId: string, data: unknown): DraftInput & { draftId: string } {
  const p = payload(data);
  const m = obj(p['message'] ?? p);
  return { draftId, to: splitAddrs(m['to'] ?? header(m, 'to')), cc: splitAddrs(m['cc'] ?? header(m, 'cc')), subject: header(m, 'subject'), body: str(m['messageText'] ?? m['body'] ?? m['snippet']) };
}
export function messageIdOf(data: unknown): string {
  const p = payload(data);
  return str(p['id'] ?? p['message_id'] ?? p['messageId']);
}
function toEvent(e: J): CalEvent {
  const start = obj(e['start']);
  const end = obj(e['end']);
  const loc = str(e['location']);
  const desc = str(e['description']);
  return {
    id: str(e['id']), title: str(e['summary'] ?? e['title']), start: str(start['dateTime'] ?? start['date'] ?? e['start']), end: str(end['dateTime'] ?? end['date'] ?? e['end']),
    tz: str(start['timeZone'] ?? e['timeZone']) || 'UTC', attendees: arr(e['attendees']).map((a) => str(obj(a)['email'] ?? a)).filter(Boolean),
    ...(loc ? { location: loc } : {}), ...(desc ? { description: desc } : {}), organizerSelf: obj(e['organizer'])['self'] === true || e['organizer'] === undefined,
  };
}
export function toEvents(data: unknown): CalEvent[] {
  const p = payload(data);
  return arr(p['items'] ?? p['events']).map(obj).map(toEvent).filter((e) => e.id);
}
export function toOneEvent(data: unknown): CalEvent {
  const p = payload(data);
  return toEvent(obj(p['event'] ?? p));
}
export function toBusy(data: unknown): Array<{ start: string; end: string }> {
  const p = payload(data);
  const cals = obj(p['calendars']);
  const primary = obj(cals['primary'] ?? Object.values(cals)[0]);
  return arr(primary['busy'] ?? p['busy']).map(obj).map((b) => ({ start: str(b['start']), end: str(b['end']) })).filter((b) => b.start && b.end);
}
