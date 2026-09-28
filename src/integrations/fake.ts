// integrations/fake.ts (WP5) — FakeIntegrationProvider (01 F9): an in-memory demo mailbox and calendar labelled
// "Demo data". The default provider (refused in production by config). The instance is the "external world": it survives
// testApp.restart() because the service keeps a passed provider as-is. Idempotency keys make create calls repeat-safe.
import type { CalendarApi, CalEvent, CalEventInput, DraftInput, IntegrationKind, IntegrationProvider, MailApi, Ms, UserId } from '../contracts/index.ts';
import { demoEvents, demoThreads, type DemoThread } from './fakeFixtures.ts';

interface Draft extends DraftInput { draftId: string; idemKey: string }
interface Sent extends DraftInput { messageId: string; at: Ms }
interface Box { threads: DemoThread[]; drafts: Map<string, Draft>; sent: Sent[]; events: Map<string, CalEvent>; eventIdem: Map<string, string>; responses: Map<string, string>; seq: number }

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class FakeIntegrationProvider implements IntegrationProvider {
  readonly name = 'fake' as const;
  private readonly boxes = new Map<UserId, Box>();
  private readonly now: () => Ms;
  /** Every provider call, for tests: `${op}:${userId}`. */
  readonly calls: string[] = [];
  readonly revoked: Array<{ userId: UserId; kind: IntegrationKind }> = [];

  constructor(o: { now: () => Ms; publicUrl?: string }) {
    this.now = o.now;
  }

  private box(userId: UserId): Box {
    let b = this.boxes.get(userId);
    if (!b) {
      const now = this.now();
      b = { threads: demoThreads(now), drafts: new Map(), sent: [], events: new Map(demoEvents(now).map((e) => [e.id, e])), eventIdem: new Map(), responses: new Map(), seq: 0 };
      this.boxes.set(userId, b);
    }
    return b;
  }

  /** The fake "consent screen" is GET /dev/fake-connect?state=… (IntegrationService.devConnect). */
  async connectLink(userId: UserId, kind: IntegrationKind, callbackUrl: string): Promise<{ url: string }> {
    this.calls.push(`connectLink:${userId}:${kind}`);
    const u = new URL(callbackUrl);
    const state = u.searchParams.get('state') ?? '';
    return { url: `${u.origin}/dev/fake-connect?state=${encodeURIComponent(state)}` };
  }

  async completeConnection(query: Record<string, string>, _expect?: { userId: UserId; kind: IntegrationKind }): Promise<{ accountRef: string }> {
    const state = query['state'];
    if (!state) throw new Error('missing state');
    return { accountRef: `fake:${state.slice(0, 12)}` };
  }

  async revoke(userId: UserId, kind: IntegrationKind): Promise<void> {
    this.calls.push(`revoke:${userId}:${kind}`);
    this.revoked.push({ userId, kind });
  }

  /** Test helper: what was sent from a user's demo mailbox. */
  sentMail(userId: UserId): ReadonlyArray<Readonly<Sent>> {
    return this.box(userId).sent;
  }
  drafts(userId: UserId): ReadonlyArray<Readonly<Draft>> {
    return [...this.box(userId).drafts.values()];
  }
  events(userId: UserId): ReadonlyArray<Readonly<CalEvent>> {
    return [...this.box(userId).events.values()];
  }

  mail(userId: UserId, _accountRef: string): MailApi {
    const b = () => this.box(userId);
    const now = () => this.now();
    const log = (op: string) => this.calls.push(`mail.${op}:${userId}`);
    return {
      async search(q) {
        log('search');
        const terms = q.query.toLowerCase().split(/\s+/).filter(Boolean);
        let newer = q.newerThanDays ?? null;
        let unreadOnly = false;
        const words: string[] = [];
        for (const t of terms) {
          const m = /^newer_than:(\d+)([dhm])$/.exec(t);
          if (m) newer = m[2] === 'd' ? Number(m[1]) : m[2] === 'h' ? Number(m[1]) / 24 : Number(m[1]) * 30;
          else if (t === 'is:unread') unreadOnly = true;
          else if (!t.includes(':')) words.push(t);
          else if (t.startsWith('from:')) words.push(t.slice(5));
        }
        const since = newer !== null ? now() - newer * 86_400_000 : -Infinity;
        return b()
          .threads.filter((t) => {
            const last = t.messages[t.messages.length - 1]!;
            if (last.date < since || (unreadOnly && !t.unread)) return false;
            const hay = t.messages.map((m) => `${m.from} ${m.subject} ${m.text}`).join(' ').toLowerCase();
            return words.every((w) => hay.includes(w));
          })
          .sort((x, y) => y.messages[y.messages.length - 1]!.date - x.messages[x.messages.length - 1]!.date)
          .slice(0, q.maxResults)
          .map((t) => {
            const first = t.messages[0]!;
            const last = t.messages[t.messages.length - 1]!;
            return { threadId: t.threadId, from: first.from, subject: first.subject, snippet: last.text.slice(0, 140), date: last.date, unread: t.unread };
          });
      },
      async readThread(threadId) {
        log('readThread');
        const t = b().threads.find((x) => x.threadId === threadId);
        if (!t) throw new NotFoundError('thread');
        return { threadId: t.threadId, messages: t.messages.map((m) => ({ ...m, to: [...m.to], cc: [...m.cc] })) };
      },
      async createDraft(d, idemKey) {
        log('createDraft');
        const box = b();
        for (const x of box.drafts.values()) if (x.idemKey === idemKey) return { draftId: x.draftId };
        const draftId = `demo-d${++box.seq}`;
        box.drafts.set(draftId, { ...d, to: [...d.to], cc: [...d.cc], draftId, idemKey });
        return { draftId };
      },
      async getDraft(draftId) {
        log('getDraft');
        const d = b().drafts.get(draftId);
        if (!d) throw new NotFoundError('draft');
        const { idemKey: _k, ...rest } = d;
        return { ...rest, to: [...rest.to], cc: [...rest.cc] };
      },
      async deleteDraft(draftId) {
        log('deleteDraft');
        b().drafts.delete(draftId);
      },
      async sendDraft(draftId) {
        log('sendDraft');
        const box = b();
        const d = box.drafts.get(draftId);
        if (!d) throw new NotFoundError('draft');
        const messageId = `demo-m${++box.seq}`;
        box.sent.push({ to: d.to, cc: d.cc, subject: d.subject, body: d.body, ...(d.replyToThreadId ? { replyToThreadId: d.replyToThreadId } : {}), messageId, at: now() });
        box.drafts.delete(draftId);
        return { messageId };
      },
      async findSent(q) {
        log('findSent');
        const hit = b().sent.find((s) => s.at >= q.afterMs && s.subject === q.subject && s.to.some((t) => t.toLowerCase() === q.to.toLowerCase()));
        return hit ? { messageId: hit.messageId } : null;
      },
    };
  }

  calendar(userId: UserId, _accountRef: string): CalendarApi {
    const b = () => this.box(userId);
    const log = (op: string) => this.calls.push(`cal.${op}:${userId}`);
    const copy = (e: CalEvent): CalEvent => ({ ...e, attendees: [...e.attendees] });
    return {
      async list(q) {
        log('list');
        const from = Date.parse(q.fromIso);
        const to = Date.parse(q.toIso);
        const needle = q.query?.toLowerCase();
        return [...b().events.values()]
          .filter((e) => Date.parse(e.end) > from && Date.parse(e.start) < to && (!needle || `${e.title} ${e.description ?? ''}`.toLowerCase().includes(needle)))
          .sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
          .slice(0, q.max)
          .map(copy);
      },
      async freeBusy(q) {
        log('freeBusy');
        const from = Date.parse(q.fromIso);
        const to = Date.parse(q.toIso);
        return [...b().events.values()].filter((e) => Date.parse(e.end) > from && Date.parse(e.start) < to && b().responses.get(e.id) !== 'declined').map((e) => ({ start: e.start, end: e.end }));
      },
      async create(e, idemKey) {
        log('create');
        const box = b();
        const existing = box.eventIdem.get(idemKey);
        if (existing && box.events.has(existing)) return copy(box.events.get(existing)!);
        const id = `demo-e${100 + ++box.seq}`;
        const ev: CalEvent = { id, title: e.title, start: e.start, end: e.end, tz: e.tz, attendees: [...e.attendees], ...(e.location ? { location: e.location } : {}), ...(e.description ? { description: e.description } : {}), organizerSelf: true };
        box.events.set(id, ev);
        box.eventIdem.set(idemKey, id);
        return copy(ev);
      },
      async update(id, patch: Partial<CalEventInput>) {
        log('update');
        const box = b();
        const cur = box.events.get(id);
        if (!cur) throw new NotFoundError('event');
        const next: CalEvent = { ...cur };
        for (const [k, v] of Object.entries(patch) as Array<[keyof CalEventInput, unknown]>) {
          if (v === undefined) continue;
          if ((k === 'location' || k === 'description') && v === '') delete next[k];
          else (next as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
        }
        box.events.set(id, next);
        return copy(next);
      },
      async remove(id) {
        log('remove');
        if (!b().events.delete(id)) throw new NotFoundError('event');
      },
      async respond(id, r) {
        log('respond');
        if (!b().events.has(id)) throw new NotFoundError('event');
        b().responses.set(id, r);
      },
      async findByIdem(idemKey) {
        log('findByIdem');
        const id = b().eventIdem.get(idemKey);
        const e = id ? b().events.get(id) : undefined;
        return e ? copy(e) : null;
      },
    };
  }
}
