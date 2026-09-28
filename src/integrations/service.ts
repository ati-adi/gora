// integrations/service.ts (WP5) — IntegrationService (01 F9, §5.6, §12): connections + oauth_states (WP5 tables),
// Connect cards (url button), the OAuth callback, permission chips (`cn:`), the `first_look` job, the capabilities and
// location context lines, and the privacy hook. A provider passed in is used as-is and exposed as `.provider`.
import type { InlineKeyboardButton } from 'grammy/types';
import type {
  CalendarApi, CallbackCtx, ContextProvider, IntegrationKind, IntegrationProvider, IntegrationService, JobRow, MailApi, PermissionLevel, PrivacyHook, Services, UserId,
} from '../contracts/index.ts';
import { errorMessage } from '../kernel/errors.ts';
import { newId, randomToken } from '../kernel/ids.ts';
import { registerNamed } from '../kernel/registries.ts';
import { formatDisplay, wallTimeOf, zonedToInstant, addDaysToDate } from '../kernel/timeMath.ts';
import { clearEventMemo } from '../tools/impl/calMemo.ts';

export const OAUTH_STATE_TTL_MS = 15 * 60_000;
export const FIRST_LOOK_DELAY_MS = 5_000;
const KINDS: readonly IntegrationKind[] = ['gmail', 'gcal'];
const LEVELS: readonly PermissionLevel[] = ['read', 'draft', 'act'];
const SERVICE_NAME: Record<IntegrationKind, string> = { gmail: 'Gmail', gcal: 'Google Calendar' };

interface ConnRow { id: string; user_id: string; integration: IntegrationKind; provider: string; account_ref_enc: Uint8Array | null; status: 'pending' | 'active' | 'error' | 'revoked'; connected_at: number | null; last_used_at: number | null }
interface StateRow { state: string; user_id: string; integration: IntegrationKind; return_chat_id: number; return_thread_id: number | null; created_at: number; expires_at: number; used_at: number | null }

const ru = (lang: string | null | undefined) => /^(ru|uk|kk|be)/i.test(lang ?? '');
const html = (title: string, body: string, status: number) =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;margin:2rem"><h1>${title}</h1><p>${body}</p></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export function levelChips(s: Services, tgUserId: number, kind: IntegrationKind, current: PermissionLevel, lang: string | null): InlineKeyboardButton[][] {
  const label: Record<PermissionLevel, string> = ru(lang)
    ? { none: '', read: 'Только чтение', draft: 'Чтение + черновики', act: 'Может предлагать отправку' }
    : { none: '', read: 'Read only', draft: 'Read + drafts', act: 'Can propose sends' };
  return [LEVELS.map((l) => ({ text: `${label[l]}${l === current ? ' ✓' : ''}`, callback_data: s.telegram.codec.encode('cn', [kind, l], tgUserId) }))];
}

export function createIntegrationServiceImpl(s: Services, provider: IntegrationProvider | null): IntegrationService {
  const aad = (id: string) => `connections|account_ref_enc|${id}`;
  const conn = (userId: UserId, kind: IntegrationKind): ConnRow | undefined =>
    s.db.prepare('SELECT id, user_id, integration, provider, account_ref_enc, status, connected_at, last_used_at FROM connections WHERE user_id = ? AND integration = ?').get<ConnRow>(userId, kind);
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

  async function startConnect(userId: UserId, kind: IntegrationKind, ret: { chatId: number; threadId?: number }): Promise<{ url: string }> {
    if (!provider) throw new Error('integrations are not configured');
    const now = s.clock.now();
    const state = randomToken(24);
    s.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
    s.db.prepare('INSERT INTO oauth_states (state, user_id, integration, return_chat_id, return_thread_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(state, userId, kind, ret.chatId, ret.threadId ?? null, now, now + OAUTH_STATE_TTL_MS);
    const callbackUrl = `${s.config.publicUrl}/oauth/callback?state=${encodeURIComponent(state)}`;
    return provider.connectLink(userId, kind, callbackUrl);
  }

  function sendConnected(userId: UserId, kind: IntegrationKind, st: StateRow, level: PermissionLevel): void {
    const user = s.repos.users.getById(userId);
    if (!user) return;
    const lang = user.languageCode;
    const text = ru(lang)
      ? `Подключено ✓ ${SERVICE_NAME[kind]}. Я читаю только то, что нужно для задачи, и каждое чтение записывается в журнал. Что мне можно?`
      : `Connected ✓ ${SERVICE_NAME[kind]}. I only read what a task needs, and every read is logged. What may I do?`;
    s.telegram.outbox.enqueue({
      idempotencyKey: `connected:${st.state}`, userId, chatId: st.return_chat_id, ...(st.return_thread_id ? { threadId: st.return_thread_id } : {}),
      method: 'sendMessage', payload: { text, reply_markup: { inline_keyboard: levelChips(s, user.tgUserId, kind, level, lang) } }, priority: 1,
    });
  }

  async function complete(query: Record<string, string>): Promise<Response> {
    if (!provider) return html('Not configured', 'Integrations are not configured on this server.', 404);
    const state = query['state'] ?? '';
    const now = s.clock.now();
    const st = state ? s.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get<StateRow>(state) : undefined;
    if (!st || st.used_at !== null || st.expires_at < now) return html('Link expired', 'This connect link is invalid or has expired. Ask Gora for a new one in Telegram.', 400);
    if (query['status'] && !/^(success|active|ok)$/i.test(query['status'])) return html('Not connected', 'The connection was not completed. You can try again from Telegram.', 400);
    let ref: string;
    try {
      // Bind the callback to the state's owner and toolkit: the query's account id is attacker-controllable.
      ref = (await provider.completeConnection(query, { userId: st.user_id, kind: st.integration })).accountRef;
    } catch (e) {
      s.log.warn({ err: errorMessage(e), integration: st.integration }, 'oauth completion failed');
      return html('Not connected', 'The connection could not be completed. Please try again from Telegram.', 502);
    }
    const kind = st.integration;
    const userId = st.user_id;
    let level: PermissionLevel = 'draft';
    s.db.tx(() => {
      const claimed = s.db.prepare('UPDATE oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL').run(now, state);
      if (Number(claimed.changes) !== 1) return;
      const existing = conn(userId, kind);
      const id = existing?.id ?? newId('cn', now);
      const enc = s.crypto.seal(`u:${userId}`, ref, aad(id));
      if (existing) s.db.prepare("UPDATE connections SET provider = ?, account_ref_enc = ?, status = 'active', connected_at = ?, revoked_at = NULL WHERE id = ?").run(provider.name, enc, now, id);
      else s.db.prepare("INSERT INTO connections (id, user_id, integration, provider, account_ref_enc, status, connected_at, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(id, userId, kind, provider.name, enc, now, now);
      const cur = s.repos.users.permissions(userId)[kind];
      if (cur === 'none') s.repos.users.setPermission(userId, kind, 'draft', 'system');
      else level = cur;
    });
    s.ledger.append({ userId, actor: 'system', kind: 'connection', summary: `${SERVICE_NAME[kind]} connected (${provider.name})` });
    sendConnected(userId, kind, st, level);
    s.scheduler.schedule({ kind: 'first_look', runAt: now + FIRST_LOOK_DELAY_MS, userId, refId: kind, payload: { kind }, dedupeKey: `first_look:${userId}:${kind}` });
    return html('Connected ✓', `${SERVICE_NAME[kind]} is connected. You can go back to Telegram.`, 200);
  }

  async function firstLook(job: JobRow): Promise<{ status: 'done' }> {
    const userId = job.userId;
    const kind = String(job.payload['kind'] ?? job.refId ?? '') as IntegrationKind;
    const user = userId ? s.repos.users.getById(userId) : undefined;
    if (!user || user.status !== 'active' || !KINDS.includes(kind)) return { status: 'done' };
    const chatId = user.dmChatId ?? user.tgUserId;
    const now = s.clock.now();
    const read: string[] = [];
    const untrusted: Array<{ source: 'email' | 'calendar'; label: string; text: string }> = [];
    const taint: Array<'email' | 'calendar'> = [];
    const mail = service.mail(user.id);
    const cal = service.calendar(user.id);
    try {
      if (mail && (kind === 'gmail' || !cal)) {
        const hdrs = await mail.search({ query: 'newer_than:2d', maxResults: 50, newerThanDays: 2 });
        read.push(ru(user.languageCode) ? `${hdrs.length} заголовков писем за 48 ч` : `${hdrs.length} email headers from the last 48 h`);
        if (hdrs.length) {
          untrusted.push({ source: 'email', label: 'email headers (48 h)', text: hdrs.slice(0, 20).map((h) => `- thread ${h.threadId} | ${h.from} | ${h.subject}${h.unread ? ' | unread' : ''}`).join('\n') });
          taint.push('email');
        }
      }
      if (cal) {
        const w = wallTimeOf(now, user.tz);
        const d = addDaysToDate(w.year, w.month, w.day, 1);
        const from = zonedToInstant({ ...d, hour: 0, minute: 0 }, user.tz).instant;
        const d2 = addDaysToDate(d.year, d.month, d.day, 1);
        const to = zonedToInstant({ ...d2, hour: 0, minute: 0 }, user.tz).instant;
        const evs = await cal.list({ fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), max: 50 });
        read.push(ru(user.languageCode) ? `${evs.length} событий на завтра` : `${evs.length} events tomorrow`);
        if (evs.length) {
          untrusted.push({ source: 'calendar', label: 'calendar (tomorrow)', text: evs.map((e) => `- ${e.id} | ${formatDisplay(Date.parse(e.start), user.tz, 'en')} | ${e.title} | attendees ${e.attendees.length}${e.organizerSelf ? '' : ' | invited'}`).join('\n') });
          taint.push('calendar');
        }
      }
    } catch (e) {
      s.log.warn({ err: errorMessage(e), integration: kind }, 'first_look read failed');
    }
    if (!read.length) return { status: 'done' };
    const line = ru(user.languageCode) ? `🔎 Я прочитал: ${read.join(' и ')} — больше ничего.` : `🔎 I read: ${read.join(' and ')} — nothing else.`;
    s.telegram.outbox.enqueue({ idempotencyKey: `first_look:${job.id}`, userId: user.id, chatId, method: 'sendMessage', payload: { text: line }, priority: 1 });
    s.ledger.append({ userId: user.id, actor: 'scheduler', kind: 'data_read', summary: `first look: ${read.join(', ')}` });
    if (untrusted.length) {
      try {
        const conv = s.conversations.resolve({ kind: 'dm', tgUserId: user.tgUserId }, { userId: user.id, tgChatId: chatId });
        s.runner.startEventRun(
          conv.id,
          { type: 'first_look', ref: kind, body: `${SERVICE_NAME[kind]} was just connected. From the items below, surface exactly ONE useful thing for the owner (e.g. propose a draft reply to one email that needs an answer, or flag one event). Do not list everything and do not send anything.`, untrusted },
          { channel: 'notify', replyRef: { chatId }, taint, priority: 'interactive' },
        );
      } catch (e) {
        s.log.warn({ err: errorMessage(e) }, 'first_look event run not started');
      }
    }
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
    async sendConnectCard(userId, kind, chat, reason) {
      const user = s.repos.users.getById(userId);
      if (!user) return;
      const { url } = await startConnect(userId, kind, chat);
      const lang = user.languageCode;
      const what = kind === 'gmail'
        ? (ru(lang) ? 'письма, которые нужны для задачи' : 'the emails a task needs')
        : (ru(lang) ? 'события, которые нужны для задачи' : 'the events a task needs');
      const lines = ru(lang)
        ? [`🔗 Подключить ${SERVICE_NAME[kind]}`, reason ? `Зачем: ${reason}` : '', `Я прочитаю только ${what}; каждое чтение записывается в журнал. Отправка — только после вашего подтверждения.`]
        : [`🔗 Connect ${SERVICE_NAME[kind]}`, reason ? `Why: ${reason}` : '', `I'll read only ${what}; every read is logged. Nothing is sent without your approval.`];
      s.telegram.outbox.enqueue({
        idempotencyKey: `connect_card:${userId}:${kind}:${url.slice(-24)}`, userId, chatId: chat.chatId, ...(chat.threadId ? { threadId: chat.threadId } : {}),
        method: 'sendMessage',
        payload: { text: lines.filter(Boolean).join('\n'), reply_markup: { inline_keyboard: [[{ text: s.strings.t('connect_button', lang, { service: SERVICE_NAME[kind] }), url }]] } },
        priority: 1,
      });
    },
    async devConnect(state) {
      if (!provider || provider.name !== 'fake' || s.config.env === 'production') return new Response('Not found', { status: 404 });
      return complete({ state, status: 'success' });
    },
  };

  // ── factory-time registrations (timing rule, 04 §3)
  s.scheduler.register('first_look', (job) => firstLook(job));
  s.telegram.callbacks.register('cn', (c) => onChip(c));
  s.privacyHooks.push(integrationsPrivacyHook(s, service));
  registerNamed(s.contextProviders, capabilitiesContext(s, service));
  registerNamed(s.contextProviders, locationContext(s));
  return service;
}

function integrationsPrivacyHook(s: Services, svc: IntegrationService): PrivacyHook {
  return {
    name: 'integrations',
    async onDeleteUser(userId) {
      for (const k of KINDS) await svc.revoke(userId, k).catch(() => undefined);
      clearEventMemo(userId);
      s.db.prepare('DELETE FROM oauth_states WHERE user_id = ?').run(userId);
      s.db.prepare('DELETE FROM connections WHERE user_id = ?').run(userId);
    },
    async exportUser(userId) {
      const rows = s.db.prepare('SELECT integration, provider, status, connected_at, last_used_at, revoked_at FROM connections WHERE user_id = ?').all<Record<string, unknown>>(userId);
      return { connections: rows, permissions: s.repos.users.permissions(userId) };
    },
    async retentionSweep(now) {
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
