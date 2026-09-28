// surfaces/business/index.ts (WP7b) — createBusinessModule: the Secretary pipeline (01 F12, §10.1, §10.2).
// Factory-time registrations (04 §3 timing rule): jobs business_triage / business_window / business_digest, the `bz`
// callback, the 'business' privacy hook (deletion, export, 30-day retention), the run hook that closes single-shot
// drafting conversations, and the 'business' context provider. Handlers for business_connection, business_message,
// edited_business_message, deleted_business_messages and `/start bizChat<id>` are installed by registerHandlers.
import type { Bot, Context, NextFunction } from 'grammy';
import type { BizChatView, BusinessModule, BusinessService, ContextPart, JobRow, PrivacyHook, Services } from '../../contracts/index.ts';
import { registerNamed } from '../../kernel/registries.ts';
import {
  chatRef, clip, CONSENT_TEXT_VERSION, dekOwnerOf, errName, ledger, MESSAGE_RETENTION_MS, parseChatRef, safe, safeName, type Biz,
} from './core.ts';
import { onBzCallback, purgeConnectionData, sendChatCard, setChatAi, setDefault, updateChat } from './consent.ts';
import { onConnection } from './connection.ts';
import { addDigestItem, clearDigest, runDigest } from './digest.ts';
import { canReply, connectionLive } from './drafting.ts';
import { onDeleted, onMessage } from './pipeline.ts';
import { createBizRepo } from './repo.ts';
import { contextOf, runWindow, sendReply } from './send.ts';
import { runTriage } from './triage.ts';
import { bt } from './text.ts';

const READ_LIMIT = 30;
const BIZ = new WeakMap<Services, Biz>();

/** The module context for `s` (shared by the factory and the business tools, which only receive ctx.services). */
export function bizFor(s: Services): Biz {
  let b = BIZ.get(s);
  if (!b) {
    b = { s, repo: createBizRepo(s.db, s.crypto), log: s.log.child({ mod: 'business' }) };
    BIZ.set(s, b);
  }
  return b;
}

export function createBusinessModule(s: Services): BusinessModule {
  const b = bizFor(s);
  const repo = b.repo;

  const payloadConn = (job: JobRow): { conn: string; chat: number } | null => {
    const conn = job.payload['conn'];
    const chat = Number(job.payload['chat']);
    return typeof conn === 'string' && conn ? { conn, chat } : null;
  };

  const service: BusinessService = {
    onConnection: (bc) => onConnection(b, bc),
    onMessage: (msg, edited) => onMessage(b, msg, edited),
    onDeleted: (ev) => onDeleted(b, ev),
    setChatAi: (userId, ref, enabled, via) => setChatAi(b, userId, ref, enabled, via),
    setDefault: (userId, v, via) => setDefault(b, userId, v, via),

    listChats(userId, filter, limit) {
      const conn = repo.connectionOfUser(userId);
      if (!conn) return [];
      const lang = safe(() => s.repos.users.getById(userId)?.languageCode ?? 'en', 'en');
      const rows = repo.listChats(conn.id, { aiOnly: filter === 'unanswered', unansweredOnly: filter === 'unanswered', limit: Math.max(1, Math.min(200, limit)) });
      return rows.map(
        (c): BizChatView => ({
          ref: chatRef(conn.id, c.chatId),
          title: repo.title(conn.id, c.chatId) ?? bt('unknown_chat', lang, { id: c.chatId }),
          aiEnabled: c.aiEnabled,
          mode: c.mode,
          lastIncomingAt: c.lastIncomingAt,
          unansweredSince: c.unansweredSince,
          windowExpiresAt: c.windowExpiresAt,
          priority: c.priority,
        }),
      );
    },

    readChat(userId, ref, limit) {
      const p = parseChatRef(ref);
      const conn = p ? repo.getConnection(p.connectionId) : undefined;
      if (!p || !conn || conn.userId !== userId) return { error: 'not_found' };
      const chat = repo.getChat(conn.id, p.chatId);
      if (!chat) return { error: 'not_found' };
      if (!chat.aiEnabled || !connectionLive(conn)) return { error: 'not_consented' };
      const u = s.repos.users.getById(userId);
      const tz = u?.tz ?? 'UTC';
      const peerName = repo.title(conn.id, p.chatId) ?? bt('peer', u?.languageCode ?? 'en');
      const msgs = repo.lastMessages(conn.id, p.chatId, Math.max(1, Math.min(READ_LIMIT, limit)));
      const fmt = (at: number) => safe(() => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(at)).replace(',', ''), new Date(at).toISOString().slice(0, 16));
      const transcript = msgs
        .map((m) => {
          const who = m.fromOwner ? (m.viaBot ? '[owner, sent via Gora]' : '[owner]') : `[${clip(peerName, 40)}]`;
          const media = m.mediaKind ? `[${m.mediaKind}] ` : '';
          return `#${m.messageId} ${fmt(m.date)} ${who} ${media}${m.text.trim()}`;
        })
        .join('\n');
      return { transcript, peerName };
    },

    send: (userId, ref, text, idemKey) => sendReply(b, { userId, ref, text, idemKey }),
    context: (userId, ref) => contextOf(b, userId, ref),

    connection(userId) {
      const conn = repo.connectionOfUser(userId);
      if (!conn) return null;
      return { id: conn.id, enabled: connectionLive(conn), canReply: canReply(conn), aiDefault: conn.aiDefault, connectedAt: conn.connectedAt, consentTextVersion: CONSENT_TEXT_VERSION };
    },
    updateChat: (userId, ref, patch, via) => updateChat(b, userId, ref, patch, via),

    async noteNoDraft(conversationId) {
      const d = repo.draftOf(conversationId);
      if (!d) return;
      const conn = repo.getConnection(d.connectionId);
      if (!conn || !connectionLive(conn)) return;
      const chat = repo.getChat(d.connectionId, d.chatId);
      if (!chat?.aiEnabled || chat.unansweredSince === null) return;
      addDigestItem(b, { connectionId: conn.id, userId: conn.userId, chatId: d.chatId, item: { at: s.clock.now(), noDraft: true, drafted: false } });
    },
  };

  // ── jobs
  s.scheduler.register('business_triage', async (job) => {
    const p = payloadConn(job);
    return p && Number.isSafeInteger(p.chat) ? runTriage(b, p.conn, p.chat) : { status: 'done' };
  });
  s.scheduler.register('business_window', async (job) => {
    const p = payloadConn(job);
    return p && Number.isSafeInteger(p.chat) ? runWindow(b, p.conn, p.chat) : { status: 'done' };
  });
  s.scheduler.register('business_digest', async (job) => {
    const p = payloadConn(job);
    return p ? runDigest(b, p.conn) : { status: 'done' };
  });

  // ── callbacks
  s.telegram.callbacks.register('bz', (c) => onBzCallback(b, c));

  // ── privacy: deletion, export, retention
  const hook: PrivacyHook = {
    name: 'business',
    async onDeleteUser(userId) {
      for (const conn of repo.connectionsOfUser(userId)) {
        try {
          await purgeConnectionData(b, conn, 'deleted');
        } catch (e) {
          b.log.warn({ err: errName(e) }, 'business: purge on deletion failed; deleting rows directly');
        }
        clearDigest(b, conn.id);
        repo.purgeConnection(conn.id, true);
        safe(() => s.crypto.destroyOwner(dekOwnerOf(conn.id)), 0);
      }
    },
    async onShredEpoch(conversationId) {
      // A shredded drafting conversation no longer needs its message links.
      if (repo.draftOf(conversationId)) repo.deleteDraft(conversationId);
    },
    async exportUser(userId) {
      const connections = repo.connectionsOfUser(userId);
      const out = { connections: [] as unknown[], chats: [] as unknown[], messages: [] as unknown[] };
      for (const conn of connections) {
        out.connections.push({ id: conn.id, enabled: conn.isEnabled, aiDefault: conn.aiDefault, rights: conn.rights, connectedAt: conn.connectedAt, disconnectedAt: conn.disconnectedAt });
        for (const c of repo.listChats(conn.id, { aiOnly: false, unansweredOnly: false, limit: 500 })) {
          out.chats.push({
            ref: chatRef(conn.id, c.chatId), title: repo.title(conn.id, c.chatId), aiEnabled: c.aiEnabled, mode: c.mode, toneNotes: repo.tone(conn.id, c.chatId),
            firstSeenAt: c.firstSeenAt, lastIncomingAt: c.lastIncomingAt, lastOwnerAt: c.lastOwnerAt, unansweredSince: c.unansweredSince, windowExpiresAt: c.windowExpiresAt, priority: c.priority,
          });
        }
        for (const m of repo.allMessagesOfConnection(conn.id, 20_000)) {
          out.messages.push({ ref: chatRef(conn.id, m.chatId), messageId: m.messageId, fromOwner: m.fromOwner, viaBot: m.viaBot, date: m.date, text: m.text, mediaKind: m.mediaKind, editedAt: m.editedAt });
        }
      }
      return out;
    },
    async retentionSweep(now) {
      const n = repo.deleteMessagesOlderThan(now - MESSAGE_RETENTION_MS);
      if (n) b.log.info({ deleted: n }, 'business: retention removed stored messages');
    },
  };
  s.privacyHooks.push(hook);

  // ── single-shot drafting conversations are closed after their run (01 §10.2 step 4)
  s.runHooks.push({
    name: 'business',
    onRunFinished(_run, conv) {
      if (conv.kind === 'biz_draft' && conv.status === 'active') safe(() => s.repos.conversations.update(conv.id, { status: 'closed' }), undefined);
    },
  });

  // ── context: the Secretary capability line (private surfaces) and the drafting surface line
  registerNamed(s.contextProviders, {
    name: 'business',
    surfaces: ['dm', 'topic', 'mission', 'biz_draft'],
    async parts(conv): Promise<ContextPart[]> {
      if (conv.kind === 'biz_draft') {
        const d = repo.draftOf(conv.id);
        if (!d) return [];
        return [{ key: 'surface', lines: [`biz_draft chat "${safeName(repo.title(d.connectionId, d.chatId), 'peer')}"`] }];
      }
      if (!conv.userId) return [];
      const conn = repo.connectionOfUser(conv.userId);
      if (!conn || !connectionLive(conn)) return [];
      const n = repo.countAiChats(conn.id);
      return [{ key: 'capabilities', lines: [`secretary=${n.ai} chats (${n.unanswered} unanswered)${canReply(conn) ? '' : ', cannot reply'}`] }];
    },
  });

  const wrap =
    (name: string, fn: (ctx: Context, next: NextFunction) => Promise<void>) =>
    async (ctx: Context, next: NextFunction): Promise<void> => {
      try {
        await fn(ctx, next);
      } catch (e) {
        b.log.error({ err: errName(e), handler: name, updateId: ctx.update.update_id }, 'business: handler failed');
      }
    };

  return {
    business: service,
    registerHandlers(bot: Bot) {
      bot.on('business_connection', wrap('business_connection', async (ctx) => {
        const bc = ctx.update.business_connection;
        if (bc && s.config.features.business) await service.onConnection(bc);
      }));
      bot.on('business_message', wrap('business_message', async (ctx) => {
        const m = ctx.update.business_message;
        if (m && s.config.features.business) await service.onMessage(m, false);
      }));
      bot.on('edited_business_message', wrap('edited_business_message', async (ctx) => {
        const m = ctx.update.edited_business_message;
        if (m && s.config.features.business) await service.onMessage(m, true);
      }));
      bot.on('deleted_business_messages', wrap('deleted_business_messages', async (ctx) => {
        const ev = ctx.update.deleted_business_messages;
        if (ev && s.config.features.business) await service.onDeleted(ev);
      }));
      // `/start bizChat<chat id>` (the "Manage Bot" deep link of a managed chat) → the per-chat card (01 §10.2 step 8).
      bot.chatType('private').command('start', wrap('bizChat', async (ctx, next) => {
        const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
        const m = ctx.message;
        if (!payload.startsWith('bizChat') || !m?.from || m.from.is_bot) return next();
        const chatId = Number(payload.slice('bizChat'.length));
        if (!Number.isSafeInteger(chatId) || chatId === 0) return;
        const u = s.repos.users.getByTg(m.from.id);
        if (!u || u.status === 'deleting') return;
        // The user id keeps the key unique for onboarding's post-consent replay (update_id 0 / message_id 0 for everyone).
        await sendChatCard(b, u, chatId, `bizchat:card:${u.id}:${ctx.update.update_id}:${m.message_id}`);
        ledger(b, { userId: u.id, actor: 'user', kind: 'business_event', summary: 'Opened Secretary chat settings', detail: { chat: chatId } });
      }));
    },
  };
}
