// agent/fallbackChannel.ts (WP3) — a minimal, non-streaming ReplyChannel used ONLY when no ChannelFactory has been
// attached to the agent module (the Telegram module, which owns the real channels of 01 §5.5, is built after the agent;
// see AgentModuleImpl.attachChannels). It buffers the text and sends the final answer once through the gateway's
// renderer (sanitize + rich → entities → plain chain). No drafts, no Stop button, no guest/biz surfaces.
import type { ChannelFactory, ConversationRow, Effect, ReplyChannel, RunRow, SentRef, Services } from '../contracts/index.ts';
import type { InlineKeyboardButton } from 'grammy/types';
import { uiLang } from '../contracts/i18n.ts';

export function createFallbackChannelFactory(s: Services): ChannelFactory {
  let warned = false;
  return {
    forRun(run: RunRow, conv: ConversationRow): ReplyChannel {
      if (!warned) {
        warned = true;
        s.log.warn({}, 'agent: using the fallback (non-streaming) reply channel; attach the Telegram ChannelFactory');
      }
      let committed = '';
      let pending = '';
      const user = run.userId ? s.repos.users.getById(run.userId) : undefined;
      const lang = uiLang(user?.languageCode ?? null);
      const target = {
        chatId: run.replyRef.chatId,
        ...(run.replyRef.threadId ? { threadId: run.replyRef.threadId } : {}),
        ...(run.replyRef.businessConnectionId && conv.kind !== 'biz_draft' ? { businessConnectionId: run.replyRef.businessConnectionId } : {}),
        ...(run.replyRef.triggerMessageId ? { replyTo: run.replyRef.triggerMessageId } : {}),
      };
      const silent = run.channel === 'guest' || run.channel === 'biz_owner' || !target.chatId;
      const send = async (md: string, rows?: InlineKeyboardButton[][]): Promise<SentRef[]> => {
        if (silent || !md.trim()) return [];
        return s.telegram.render.sendMarkdown(target, md, rows && rows.length ? { replyMarkup: { inline_keyboard: rows } } : {});
      };
      return {
        kind: run.channel,
        get visibleText() {
          return committed + pending;
        },
        async begin() {},
        text(d) {
          pending += d;
        },
        status() {},
        resetIteration() {
          pending = '';
        },
        commitIteration() {
          committed += pending;
          pending = '';
        },
        blockStart(b) {
          if (b.index === -1 && b.type === 'retry') pending = '';
        },
        async checkpoint() {
          const txt = committed + pending;
          committed = '';
          pending = '';
          if (txt.trim()) await send(s.telegram.render.sanitize(txt, { allowedLinkHosts: new Set(), allowedEmails: new Set() }));
        },
        async finalize(o: { footerLines: string[]; effects: Effect[]; allowedLinkHosts: ReadonlySet<string>; allowedEmails: ReadonlySet<string> }) {
          const body = s.telegram.render.sanitize(committed + pending, { allowedLinkHosts: o.allowedLinkHosts, allowedEmails: o.allowedEmails });
          const lines = o.effects.filter((e): e is Extract<Effect, { kind: 'line' }> => e.kind === 'line').map((e) => e.markdown);
          const rows = o.effects.filter((e): e is Extract<Effect, { kind: 'buttons' }> => e.kind === 'buttons').flatMap((e) => e.rows);
          const md = [body, ...lines, ...o.footerLines].filter((x) => x && x.trim()).join('\n\n');
          committed = '';
          pending = '';
          return send(md, rows);
        },
        async stopped() {
          const txt = committed + pending;
          await send(`${txt ? `${s.telegram.render.sanitize(txt, { allowedLinkHosts: new Set(), allowedEmails: new Set() })}\n\n` : ''}${s.strings.t('stopped', lang)}`);
        },
        async fail(message) {
          await send(message);
        },
      };
    },
  };
}
