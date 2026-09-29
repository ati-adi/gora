// integrations/service.ts (WP5, s07 CAL) — IntegrationService (01 F9, §5.6, §12; spec 07 B1/B2): connections +
// oauth_states (WP5 tables) + integration_links (links.ts), the one-line Connect card (url button), the OAuth callback
// and the `integration_poll` poller (both complete through `finish`, exactly once), "Готово ✓" + resuming the owner's
// pending question, the friendly `first_look` line, `cn:` chips (old messages), the capabilities and location context
// lines, and the privacy hook. A provider passed in is used as-is and exposed as `.provider`.
import type { InlineKeyboardButton } from 'grammy/types';
import type {
  CalendarApi, CallbackCtx, ContextProvider, ConversationRow, IntegrationKind, IntegrationProvider, IntegrationService, JobRow, MailApi, PermissionLevel, PrivacyHook, Services, UserId,
} from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { newId, randomToken } from '../kernel/ids.ts';
import { registerNamed } from '../kernel/registries.ts';
import { wallTimeOf, zonedToInstant, addDaysToDate } from '../kernel/timeMath.ts';
import { clearEventMemo } from '../tools/impl/calMemo.ts';
import { createLinksRepo, createPollHandler, MAX_PENDING_LINKS_PER_USER, type LinkRow, type LinksRepo } from './links.ts';

export const OAUTH_STATE_TTL_MS = 15 * 60_000;
export const FIRST_LOOK_DELAY_MS = 5_000;
/** B2 "no card storm": a second connect card for the same service in the same chat within this window is not sent. */
export const CONNECT_CARD_DEDUPE_MS = 2 * 60_000;
const KINDS: readonly IntegrationKind[] = ['gmail', 'gcal'];
const LEVELS: readonly PermissionLevel[] = ['read', 'draft', 'act'];
const SERVICE_NAME: Record<IntegrationKind, string> = { gmail: 'Gmail', gcal: 'Google Calendar' };
const SERVICE_NAME_RU: Record<IntegrationKind, string> = { gmail: 'Gmail', gcal: 'Google Календарь' };

interface ConnRow { id: string; user_id: string; integration: IntegrationKind; provider: string; account_ref_enc: Uint8Array | null; status: 'pending' | 'active' | 'error' | 'revoked'; connected_at: number | null; last_used_at: number | null }
interface StateRow { state: string; user_id: string; integration: IntegrationKind; return_chat_id: number; return_thread_id: number | null; created_at: number; expires_at: number; used_at: number | null }
/** The `chat` argument of sendConnectCard (contracts/integrations.ts; resumeConversationId added by the s07 lead). */
type ConnectChat = Parameters<IntegrationService['sendConnectCard']>[2];

const ru = (lang: string | null | undefined) => /^(ru|uk|kk|be)/i.test(lang ?? '');
const nameIn = (kind: IntegrationKind, lang: string | null | undefined) => (ru(lang) ? SERVICE_NAME_RU[kind] : SERVICE_NAME[kind]);
const html = (title: string, body: string, status: number) =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;margin:2rem"><h1>${title}</h1><p>${body}</p></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

/** 01 F9 permission chips. Since s07 (B2) they live in the Mini App Connections screen; `cn:` taps on old messages still work. */
export function levelChips(s: Services, tgUserId: number, kind: IntegrationKind, current: PermissionLevel, lang: string | null): InlineKeyboardButton[][] {
  const label: Record<PermissionLevel, string> = ru(lang)
    ? { none: '', read: 'Только чтение', draft: 'Чтение + черновики', act: 'Может предлагать отправку' }
    : { none: '', read: 'Read only', draft: 'Read + drafts', act: 'Can propose sends' };
  return [LEVELS.map((l) => ({ text: `${label[l]}${l === current ? ' ✓' : ''}`, callback_data: s.telegram.codec.encode('cn', [kind, l], tgUserId) }))];
}

export function createIntegrationServiceImpl(s: Services, provider: IntegrationProvider | null): IntegrationService {
  const links = createLinksRepo(s);
  const aad = (id: string) => `connections|account_ref_enc|${id}`;
  const conn = (userId: UserId, kind: IntegrationKind): ConnRow | undefined =>
    s.db.prepare('SELECT id, user_id, integration, provider, account_ref_enc, status, connected_at, last_used_at FROM connections WHERE user_id = ? AND integration = ?').get<ConnRow>(userId, kind);
  const stateRow = (state: string): StateRow | undefined => (state ? s.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get<StateRow>(state) : undefined);
  const accountRef = (r: ConnRow): string | null => {
    if (!r.account_ref_enc) return null;
    try {
      return s.crypto.openText(r.account_ref_enc, aad(r.id));
    } catch (e) {
      s.log.warn({ err: errorMessage(e), integration: r.integration }, 'connection ref unreadable');
      return null;
    }
  };
  const active = (userId: UserId, kind: IntegrationKind): { row: ConnRow; ref: string } | null => {
    if (!provider) return null;
    const r = conn(userId, kind);
    if (!r || r.status !== 'active' || r.provider !== provider.name) return null;
    const ref = accountRef(r);
    return ref ? { row: r, ref } : null;
  };
  const touch = (id: string) => s.db.prepare('UPDATE connections SET last_used_at = ? WHERE id = ?').run(s.clock.now(), id);
  const chatOf = (r: { return_chat_id: number; return_thread_id: number | null } | LinkRow) => {
    const chatId = 'returnChatId' in r ? r.returnChatId : r.return_chat_id;
    const threadId = 'returnChatId' in r ? r.returnThreadId : r.return_thread_id;
    return { chatId, ...(threadId ? { threadId } : {}) };
  };

  /** A DM/topic conversation of this owner that a connect may resume (B2); missions resume through task_wait instead. */
  function resumeTarget(userId: UserId, chat: ConnectChat): string | null {
    const ok = (c: ConversationRow | undefined): c is ConversationRow => !!c && c.userId === userId && c.status === 'active' && (c.kind === 'dm' || c.kind === 'topic');
    if (chat.resumeConversationId) {
      const c = s.repos.conversations.get(chat.resumeConversationId);
      return ok(c) ? c.id : null;
    }
    try {
      const hit = s.repos.conversations.listByUser(userId, { status: 'active', limit: 20 })
        .find((c) => ok(c) && c.tgChatId === chat.chatId && (c.threadId ?? null) === (chat.threadId ?? null));
      return hit?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Issues a connect link: an oauth_states row, the provider link, an integration_links row and (when the provider can) polling. */
  async function issue(userId: UserId, kind: IntegrationKind, ret: { chatId: number; threadId?: number }, resumeConversationId: string | null): Promise<{ url: string; link: LinkRow }> {
    if (!provider) throw new Error('integrations are not configured');
    const now = s.clock.now();
    const state = randomToken(24);
    s.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
    s.db.prepare('INSERT INTO oauth_states (state, user_id, integration, return_chat_id, return_thread_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(state, userId, kind, ret.chatId, ret.threadId ?? null, now, now + OAUTH_STATE_TTL_MS);
    const callbackUrl = `${s.config.publicUrl}/oauth/callback?state=${encodeURIComponent(state)}`;
    const r = await provider.connectLink(userId, kind, callbackUrl);
    // cap the user's pending (polled) links: the oldest beyond the cap expire and stop polling
    for (const id of links.pendingIds(userId, now).slice(MAX_PENDING_LINKS_PER_USER - 1)) {
      if (links.finish(id, 'expired', now)) s.scheduler.cancel(`ipoll:${id}`);
    }
    const link = links.insert({ userId, kind, provider: provider.name, state, ...(r.pendingRef ? { pendingRef: r.pendingRef } : {}), ret, resumeConversationId, now });
    if (r.pendingRef && provider.connectionStatus) {
      s.scheduler.schedule({ kind: 'integration_poll', runAt: link.nextPollAt, userId, refId: link.id, payload: { linkId: link.id }, dedupeKey: `ipoll:${link.id}` });
    }
    return { url: r.url, link };
  }

  async function startConnect(userId: UserId, kind: IntegrationKind, ret: { chatId: number; threadId?: number }): Promise<{ url: string }> {
    const { url } = await issue(userId, kind, { chatId: ret.chatId, ...(ret.threadId !== undefined ? { threadId: ret.threadId } : {}) }, null);
    return { url };
  }

  /** B2: one line, no permission chips (they live in the Mini App Connections screen). */
  function sendDone(userId: UserId, kind: IntegrationKind, state: string, chat: { chatId: number; threadId?: number }): void {
    const user = s.repos.users.getById(userId);
    if (!user) return;
    const text = ru(user.languageCode) ? `Готово ✓ ${SERVICE_NAME_RU[kind]} подключён.` : `Done ✓ ${SERVICE_NAME[kind]} is connected.`;
    s.telegram.outbox.enqueue({ idempotencyKey: `connected:${state}`, userId, chatId: chat.chatId, ...(chat.threadId ? { threadId: chat.threadId } : {}), method: 'sendMessage', payload: { text }, priority: 1 });
  }

  /**
   * Completes a connection exactly once, for the callback and the poller alike: claims the oauth_states row
   * (`used_at IS NULL`), stores the connection, marks the link active, says "Готово ✓" and resumes the owner's pending
   * question (GoraEvent 'integration_connected', B2) — or, when nothing is pending, schedules `first_look`.
   * Returns false when the state was already used (the other path won the race).
   */
  function finish(st: StateRow, ref: string, via: 'callback' | 'poll'): boolean {
    if (!provider) return false;
    const now = s.clock.now();
    const kind = st.integration;
    const userId = st.user_id;
    const link = links.byState(st.state);
    let claimed = false;
    s.db.tx(() => {
      claimed = Number(s.db.prepare('UPDATE oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL').run(now, st.state).changes) === 1;
      if (!claimed) return;
      const existing = conn(userId, kind);
      const id = existing?.id ?? newId('cn', now);
      const enc = s.crypto.seal(`u:${userId}`, ref, aad(id));
      if (existing) s.db.prepare("UPDATE connections SET provider = ?, account_ref_enc = ?, status = 'active', connected_at = ?, revoked_at = NULL WHERE id = ?").run(provider.name, enc, now, id);
      else s.db.prepare("INSERT INTO connections (id, user_id, integration, provider, account_ref_enc, status, connected_at, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(id, userId, kind, provider.name, enc, now, now);
      if (s.repos.users.permissions(userId)[kind] === 'none') s.repos.users.setPermission(userId, kind, 'draft', 'system');
      if (link) s.db.prepare("UPDATE integration_links SET status = 'active', completed_at = ? WHERE id = ?").run(now, link.id);
    });
    if (!claimed) return false;
    if (link && via === 'callback') s.scheduler.cancel(`ipoll:${link.id}`); // the poller stops (it also re-checks the link status)
    s.ledger.append({ userId, actor: 'system', kind: 'connection', summary: `${SERVICE_NAME[kind]} connected (${provider.name}, ${via})` });
    const chat = link ? chatOf(link) : chatOf(st);
    sendDone(userId, kind, st.state, chat);
    const resume = link?.resumeConversationId ? s.repos.conversations.get(link.resumeConversationId) : undefined;
    if (resume && resume.status === 'active' && resume.userId === userId) {
      try {
        s.runner.startEventRun(
          resume.id,
          { type: 'integration_connected', ref: kind, body: `The owner just connected ${SERVICE_NAME[kind]}. Answer their pending question now.` },
          { channel: 'dm_stream', replyRef: { chatId: resume.tgChatId ?? chat.chatId, ...(resume.threadId ? { threadId: resume.threadId } : {}) }, priority: 'interactive' },
        );
        return true;
      } catch (e) {
        s.log.warn({ err: errorMessage(e), integration: kind }, 'connect resume run not started');
      }
    }
    s.scheduler.schedule({ kind: 'first_look', runAt: now + FIRST_LOOK_DELAY_MS, userId, refId: kind, payload: { kind }, dedupeKey: `first_look:${userId}:${kind}` });
    return true;
  }

  /** The OAuth redirect (GET /oauth/callback?state=…&status=…&connected_account_id=…). */
  async function complete(query: Record<string, string>): Promise<Response> {
    if (!provider) return html('Not configured', 'Integrations are not configured on this server.', 404);
    const state = query['state'] ?? '';
    const now = s.clock.now();
    const st = stateRow(state);
    const expired = () => html('Link expired', 'This connect link is invalid or has expired. Ask Gora for a new one in Telegram.', 400);
    if (!st) return expired();
    const link = links.byState(state);
    if (st.used_at !== null) {
      // The poller (or an earlier redirect) already completed this state: same page, no second message.
      const done = link?.status === 'active' || active(st.user_id, st.integration) !== null;
      return done ? html('Connected ✓', `${SERVICE_NAME[st.integration]} is already connected. You can go back to Telegram.`, 200) : expired();
    }
    if (st.expires_at < now) return expired();
    if (query['status'] && !/^(success|active|ok)$/i.test(query['status'])) {
      if (link && links.finish(link.id, 'failed', now)) onFailed(link, 'failed');
      return html('Not connected', 'The connection was not completed. You can try again from Telegram.', 400);
    }
    const claimedRef = query['connected_account_id'] ?? query['connectedAccountId'];
    // The docs: the query alone is no proof of ownership. It must be the account this link was issued for.
    if (link?.pendingRef && claimedRef && claimedRef !== link.pendingRef) {
      s.log.warn({ integration: st.integration }, 'oauth callback account does not match the issued link');
      return html('Not connected', 'The connection could not be completed. Please try again from Telegram.', 400);
    }
    const q = !claimedRef && link?.pendingRef ? { ...query, connected_account_id: link.pendingRef } : query;
    let ref: string;
    try {
      // Bind the callback to the state's owner and toolkit: the query's account id is attacker-controllable.
      ref = (await provider.completeConnection(q, { userId: st.user_id, kind: st.integration })).accountRef;
    } catch (e) {
      s.log.warn({ err: errorMessage(e), integration: st.integration }, 'oauth completion failed');
      return html('Not connected', 'The connection could not be completed. Please try again from Telegram.', 502);
    }
    finish(st, ref, 'callback');
    return html('Connected ✓', `${SERVICE_NAME[st.integration]} is connected. You can go back to Telegram.`, 200);
  }

  function onFailed(link: LinkRow, reason: string): void {
    s.ledger.append({ userId: link.userId, actor: 'system', kind: 'connection', summary: `${SERVICE_NAME[link.kind]} connect failed (${reason})` });
    const user = s.repos.users.getById(link.userId);
    if (!user) return;
    const text = ru(user.languageCode) ? `Не получилось подключить ${SERVICE_NAME_RU[link.kind]} — попробуем ещё раз?` : `Couldn't connect ${SERVICE_NAME[link.kind]} — want to try again?`;
    const chat = chatOf(link);
    s.telegram.outbox.enqueue({ idempotencyKey: `connect_failed:${link.id}`, userId: link.userId, chatId: chat.chatId, ...(chat.threadId ? { threadId: chat.threadId } : {}), method: 'sendMessage', payload: { text }, priority: 1 });
  }

  const poll = createPollHandler(s, {
    links,
    provider,
    onActive(link, ref) {
      const st = stateRow(link.state);
      if (!st || (st.used_at === null && st.expires_at < s.clock.now())) {
        links.finish(link.id, 'expired', s.clock.now());
        return;
      }
      if (st.used_at !== null) return; // the callback already completed it
      finish(st, ref, 'poll');
    },
    onFailed,
    onExpired(link) {
      s.ledger.append({ userId: link.userId, actor: 'system', kind: 'connection', summary: `${SERVICE_NAME[link.kind]} connect link expired unused` });
    },
  });

  /**
   * 01 F9 `first_look`, friend mode (spec 07 B2): ONE friendly line that says what was just read (transparency) and one
   * useful bit, deterministic — no model call and no card. Only scheduled when no pending question resumes (the resumed
   * answer is the first look then).
   */
  async function firstLook(job: JobRow): Promise<{ status: 'done' }> {
    const userId = job.userId;
    const kind = String(job.payload['kind'] ?? job.refId ?? '') as IntegrationKind;
    const user = userId ? s.repos.users.getById(userId) : undefined;
    if (!user || user.status !== 'active' || !KINDS.includes(kind)) return { status: 'done' };
    const chatId = user.dmChatId ?? user.tgUserId;
    const now = s.clock.now();
    const isRu = ru(user.languageCode);
    let line: string | null = null;
    let read = '';
    try {
      if (kind === 'gmail') {
        const mail = service.mail(user.id);
        if (mail) {
          const hdrs = await mail.search({ query: 'newer_than:2d', maxResults: 50, newerThanDays: 2 });
          const unread = hdrs.filter((h) => h.unread).length;
          read = `${hdrs.length} email headers (48 h)`;
          line = isRu
            ? `👀 Одним глазком: ${plural(hdrs.length, ['письмо', 'письма', 'писем'])} за 2 дня${unread ? ` (непрочитанных: ${unread})` : ''}. Больше ничего не трогаю.`
            : `👀 Quick look: ${hdrs.length} email${hdrs.length === 1 ? '' : 's'} in the last 2 days${unread ? ` (${unread} unread)` : ''}. I didn't read anything else.`;
        }
      } else {
        const cal = service.calendar(user.id);
        if (cal) {
          const w = wallTimeOf(now, user.tz);
          const d = addDaysToDate(w.year, w.month, w.day, 1);
          const from = zonedToInstant({ ...d, hour: 0, minute: 0 }, user.tz).instant;
          const d2 = addDaysToDate(d.year, d.month, d.day, 1);
          const to = zonedToInstant({ ...d2, hour: 0, minute: 0 }, user.tz).instant;
          const evs = await cal.list({ fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), max: 50 });
          read = `${evs.length} events tomorrow`;
          const first = evs[0];
          const title = first ? `«${first.title.replace(/\s+/g, ' ').trim().slice(0, 60)}»` : '';
          const at = first && first.start.length > 10 && Number.isFinite(Date.parse(first.start)) ? (() => {
            const t = wallTimeOf(Date.parse(first.start), user.tz);
            return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
          })() : null;
          line = isRu
            ? evs.length
              ? `👀 Одним глазком: на завтра ${plural(evs.length, ['событие', 'события', 'событий'])}, первое — ${title}${at ? ` в ${at}` : ''}. Больше ничего не трогаю.`
              : '👀 Одним глазком: на завтра событий нет. Больше ничего не трогаю.'
            : evs.length
              ? `👀 Quick look: ${evs.length} event${evs.length === 1 ? '' : 's'} tomorrow, the first is ${title.replace(/[«»]/g, '"')}${at ? ` at ${at}` : ''}. I didn't read anything else.`
              : "👀 Quick look: nothing on your calendar tomorrow. I didn't read anything else.";
        }
      }
    } catch (e) {
      s.log.warn({ err: errorMessage(e), integration: kind }, 'first_look read failed');
    }
    if (!line) return { status: 'done' };
    s.telegram.outbox.enqueue({ idempotencyKey: `first_look:${job.id}`, userId: user.id, chatId, method: 'sendMessage', payload: { text: line }, priority: 1 });
    s.ledger.append({ userId: user.id, actor: 'scheduler', kind: 'data_read', summary: `first look: ${read}` });
    return { status: 'done' };
  }

  async function onChip(c: CallbackCtx): Promise<{ text: string; alert?: boolean }> {
    const [kind, level] = c.parts as [IntegrationKind | undefined, PermissionLevel | undefined];
    const user = c.user;
    if (!user || !kind || !level || !KINDS.includes(kind) || !LEVELS.includes(level)) return { text: '⚠️' };
    if (!conn(user.id, kind) || conn(user.id, kind)?.status !== 'active') return { text: ru(user.languageCode) ? 'Сначала подключите сервис.' : 'Connect it first.', alert: true };
    const before = s.repos.users.permissions(user.id)[kind];
    if (before !== level) {
      s.repos.users.setPermission(user.id, kind, level, 'callback');
      s.ledger.append({ userId: user.id, actor: 'user', kind: 'permission_change', summary: `${SERVICE_NAME[kind]}: ${before} → ${level}` });
    }
    if (c.message) {
      s.telegram.outbox.enqueue({
        idempotencyKey: `cn_edit:${c.callbackQueryId}`, userId: user.id, chatId: c.message.chatId, method: 'editMessageReplyMarkup',
        payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: levelChips(s, user.tgUserId, kind, level, user.languageCode) } }, priority: 0,
      });
    }
    return { text: ru(user.languageCode) ? 'Сохранено ✓' : 'Saved ✓' };
  }

  const service: IntegrationService = {
    provider,
    status(userId) {
      const perms = s.repos.users.permissions(userId);
      const out = {} as Record<IntegrationKind, { connected: boolean; level: PermissionLevel }>;
      for (const k of KINDS) {
        const connected = active(userId, k) !== null;
        out[k] = { connected, level: connected ? perms[k] : 'none' };
      }
      return out;
    },
    startConnect,
    oauthCallback: complete,
    mail(userId): MailApi | null {
      const a = active(userId, 'gmail');
      if (!a || !provider) return null;
      touch(a.row.id);
      return provider.mail(userId, a.ref);
    },
    calendar(userId): CalendarApi | null {
      const a = active(userId, 'gcal');
      if (!a || !provider) return null;
      touch(a.row.id);
      return provider.calendar(userId, a.ref);
    },
    async revoke(userId, kind) {
      const r = conn(userId, kind);
      if (!r || r.status === 'revoked') return;
      const ref = accountRef(r);
      if (provider && ref && r.provider === provider.name) {
        try {
          await provider.revoke(userId, kind, ref);
        } catch (e) {
          s.log.warn({ err: errorMessage(e), integration: kind }, 'provider revoke failed; marking revoked locally');
        }
      }
      s.db.prepare("UPDATE connections SET status = 'revoked', revoked_at = ?, account_ref_enc = NULL WHERE id = ?").run(s.clock.now(), r.id);
      if (kind === 'gcal') clearEventMemo(userId); // no plaintext event data outlives the connection
      s.repos.users.setPermission(userId, kind, 'none', 'system');
      s.ledger.append({ userId, actor: 'user', kind: 'connection', summary: `${SERVICE_NAME[kind]} disconnected` });
    },
    /**
     * B2: ONE short line + a url button `[Подключить Google Календарь]`, no "why" paragraph and no chips. A card for the
     * same service in the same chat within CONNECT_CARD_DEDUPE_MS is not repeated (the executor's not_connected card and
     * a following integration_connect in the same run collapse into one); its link only learns the resume target.
     */
    async sendConnectCard(userId, kind, chat, _reason) {
      const user = s.repos.users.getById(userId);
      if (!user) return;
      const c: ConnectChat = chat;
      const ret = { chatId: c.chatId, ...(c.threadId !== undefined ? { threadId: c.threadId } : {}) };
      const resume = resumeTarget(userId, c);
      const now = s.clock.now();
      const recent = links.recentPending(userId, kind, ret, now - CONNECT_CARD_DEDUPE_MS, now);
      if (recent) {
        if (resume && !recent.resumeConversationId) links.setResume(recent.id, resume);
        return;
      }
      const { url } = await issue(userId, kind, ret, resume);
      const lang = user.languageCode;
      const text = ru(lang)
        ? `Подключи ${kind === 'gcal' ? 'календарь' : 'почту'} — и сразу продолжим 👇`
        : `Connect your ${kind === 'gcal' ? 'calendar' : 'Gmail'} and we'll pick up right there 👇`;
      s.telegram.outbox.enqueue({
        idempotencyKey: `connect_card:${userId}:${kind}:${url.slice(-24)}`, userId, chatId: ret.chatId, ...(ret.threadId ? { threadId: ret.threadId } : {}),
        method: 'sendMessage',
        payload: { text, reply_markup: { inline_keyboard: [[{ text: ru(lang) ? `Подключить ${nameIn(kind, lang)}` : `Connect ${SERVICE_NAME[kind]}`, url }]] } },
        priority: 1,
      });
    },
    pendingLinks(userId) {
      return links.pendingFor(userId, s.clock.now());
    },
    async devConnect(state) {
      if (!provider || provider.name !== 'fake' || s.config.env === 'production') return new Response('Not found', { status: 404 });
      return complete({ state, status: 'success' });
    },
  };

  // ── factory-time registrations (timing rule, 04 §3)
  s.scheduler.register('first_look', (job) => firstLook(job));
  s.scheduler.register('integration_poll', poll);
  s.telegram.callbacks.register('cn', (c) => onChip(c));
  s.privacyHooks.push(integrationsPrivacyHook(s, service, links));
  registerNamed(s.contextProviders, capabilitiesContext(s, service));
  registerNamed(s.contextProviders, locationContext(s));
  return service;
}

function integrationsPrivacyHook(s: Services, svc: IntegrationService, links: LinksRepo): PrivacyHook {
  return {
    name: 'integrations',
    async onDeleteUser(userId) {
      for (const k of KINDS) await svc.revoke(userId, k).catch(() => undefined);
      clearEventMemo(userId);
      links.deleteUser(userId);
      s.db.prepare('DELETE FROM oauth_states WHERE user_id = ?').run(userId);
      s.db.prepare('DELETE FROM connections WHERE user_id = ?').run(userId);
    },
    async exportUser(userId) {
      const rows = s.db.prepare('SELECT integration, provider, status, connected_at, last_used_at, revoked_at FROM connections WHERE user_id = ?').all<Record<string, unknown>>(userId);
      return { connections: rows, permissions: s.repos.users.permissions(userId), connect_links: links.exportUser(userId) };
    },
    async retentionSweep(now) {
      links.sweep(now);
      s.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
    },
  };
}

function capabilitiesContext(s: Services, svc: IntegrationService): ContextProvider {
  return {
    name: 'integrations.capabilities',
    surfaces: ['dm', 'topic', 'mission'],
    async parts(conv) {
      const userId = conv.userId;
      if (!userId) return [];
      const st = svc.status(userId);
      const fmt = (k: IntegrationKind) => `${k}=${st[k].connected ? st[k].level : 'not_connected'}`;
      return [{ key: 'capabilities', lines: [`capabilities: ${fmt('gmail')} ${fmt('gcal')} | cannot: pay, buy, log in to sites, call, message anyone except approved email/secretary replies`] }];
    },
  };
}

function locationContext(s: Services): ContextProvider {
  return {
    name: 'integrations.location',
    surfaces: ['dm', 'topic', 'mission'],
    async parts(conv) {
      if (!conv.userId) return [];
      const loc = s.location.get(conv.userId);
      if (!loc) return [];
      const ageMin = Math.max(0, Math.round((s.clock.now() - loc.updatedAt) / 60_000));
      return [{ key: 'location', lines: [`location: shared ${ageMin} min ago, approx ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}${loc.liveUntil ? ' (live)' : ''}`] }];
    },
  };
}

/** Russian plural: 1 событие, 2 события, 5 событий. */
function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const f = m10 === 1 && m100 !== 11 ? forms[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? forms[1] : forms[2];
  return `${n} ${f}`;
}
