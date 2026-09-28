// ── contracts/integrations.ts (WP0, frozen) — 01 §4.4
import type { Ms, PermissionLevel, UserId } from './common.ts';

export type IntegrationKind = 'gmail' | 'gcal';
export interface MailThreadSummary { threadId: string; from: string; subject: string; snippet: string; date: Ms; unread: boolean }
export interface MailThread { threadId: string; messages: Array<{ from: string; to: string[]; cc: string[]; subject: string; date: Ms; text: string }> }
export interface DraftInput { to: string[]; cc: string[]; subject: string; body: string; replyToThreadId?: string }
export interface MailApi {
  search(q: { query: string; maxResults: number; newerThanDays?: number }): Promise<MailThreadSummary[]>;
  readThread(threadId: string): Promise<MailThread>;
  createDraft(d: DraftInput, idemKey: string): Promise<{ draftId: string }>;
  getDraft(draftId: string): Promise<DraftInput & { draftId: string }>;
  deleteDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<{ messageId: string }>;
  findSent(q: { to: string; subject: string; afterMs: Ms }): Promise<{ messageId: string } | null>;
}
export interface CalEvent { id: string; title: string; start: string; end: string; tz: string; attendees: string[]; location?: string; description?: string; organizerSelf: boolean }
export interface CalEventInput { title: string; start: string; end: string; tz: string; attendees: string[]; location?: string; description?: string }
export interface CalendarApi {
  list(q: { fromIso: string; toIso: string; query?: string; max: number }): Promise<CalEvent[]>;
  freeBusy(q: { fromIso: string; toIso: string }): Promise<Array<{ start: string; end: string }>>;
  create(e: CalEventInput, idemKey: string): Promise<CalEvent>;
  update(id: string, patch: Partial<CalEventInput>): Promise<CalEvent>;
  remove(id: string): Promise<void>;
  respond(id: string, r: 'accepted' | 'declined' | 'tentative'): Promise<void>;
  findByIdem(idemKey: string): Promise<CalEvent | null>;
}
export interface IntegrationProvider {
  readonly name: 'fake' | 'composio';
  connectLink(userId: UserId, kind: IntegrationKind, callbackUrl: string): Promise<{ url: string }>;
  /** `expect`: the owner and toolkit the OAuth state was started for; providers refuse an account that does not match. */
  completeConnection(query: Record<string, string>, expect?: { userId: UserId; kind: IntegrationKind }): Promise<{ accountRef: string }>;
  revoke(userId: UserId, kind: IntegrationKind, accountRef: string): Promise<void>;
  mail(userId: UserId, accountRef: string): MailApi;
  calendar(userId: UserId, accountRef: string): CalendarApi;
}
/**
 * `provider` (WP0 addition): the provider instance in use — the one passed to createIntegrationService(s, provider) when
 * given (MUST be used as-is), else the one built from config (fake / composio), null for INTEGRATIONS_PROVIDER=none.
 * testApp.restart() hands it to the next App, so the fake "external world" (drafts, sent mail, events) survives restarts.
 */
export interface IntegrationService {
  readonly provider: IntegrationProvider | null;
  status(userId: UserId): Record<IntegrationKind, { connected: boolean; level: PermissionLevel }>;
  startConnect(userId: UserId, kind: IntegrationKind, ret: { chatId: number; threadId?: number }): Promise<{ url: string }>;
  oauthCallback(query: Record<string, string>): Promise<Response>;
  mail(userId: UserId): MailApi | null;
  calendar(userId: UserId): CalendarApi | null;
  revoke(userId: UserId, kind: IntegrationKind): Promise<void>;
  /** WP0 addition (§5.6 not_connected, integration_connect): sends the Connect card (url button) into `chat` via the outbox. */
  sendConnectCard(userId: UserId, kind: IntegrationKind, chat: { chatId: number; threadId?: number }, reason?: string): Promise<void>;
  /**
   * WP0 addition (GET /dev/fake-connect?state=…, development + fake provider only; WP8 mounts the route): completes the
   * pending oauth_states row as if the provider had redirected back, then behaves like oauthCallback. 404 Response otherwise.
   */
  devConnect(state: string): Promise<Response>;
}
