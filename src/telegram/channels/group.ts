// telegram/channels/group.ts (WP2) — group replies (01 §5.5, F14): 👀 reaction on the trigger, typing every 4.5 s, a
// placeholder after 12 s that is later edited with the answer (rich → entities → plain), otherwise sendRichMessage replying
// to the trigger. The 👀 is cleared at the end. The first reply of the day in each group carries [🔒 Use Gora privately].
import type { InlineKeyboardButton } from 'grammy/types';
import type { ConversationRow, OutboxRequest, ReplyChannel, RunRow, SentRef, Services } from '../../contracts/index.ts';
import { localDay } from '../../kernel/timeMath.ts';
import { isOutboxPending } from '../outbox.ts';
import { editMarkdownChainWithRest, rawOf, type EditOverflow } from '../render/fallback.ts';
import { assembleFinal, plainLine, recordLinks, runCtx, sanitizeFor, sendDurable, sendEffectMessages } from './common.ts';

export const GROUP_TYPING_MS = 4500;
export const GROUP_PLACEHOLDER_MS = 12_000;

export function createGroupChannel(s: Services, run: RunRow, conv: ConversationRow): ReplyChannel {
  const c = runCtx(s, run, conv);
  const clock = s.clock;
  const trigger = run.replyRef.triggerMessageId;
  let committed = '';
  let pending = '';
  let closed = false;
  let typingTimer: unknown = null;
  let placeholderTimer: unknown = null;
  let placeholderId: number | null = run.replyRef.placeholderMessageId ?? null;
  let placeholderSending: Promise<void> | null = null;
  const api = () => rawOf(s.telegram.api);
  const thread = () => (c.threadId ? { message_thread_id: c.threadId } : {});

  const react = async (on: boolean) => {
    if (!trigger) return;
    try {
      await api()['setMessageReaction']!({ chat_id: c.chatId, message_id: trigger, reaction: on ? [{ type: 'emoji', emoji: '👀' }] : [] });
    } catch {
      /* reactions are cosmetic */
    }
  };
  const typing = async () => {
    typingTimer = null;
    if (closed) return;
    try {
      await api()['sendChatAction']!({ chat_id: c.chatId, action: 'typing', ...thread() });
    } catch {
      /* best effort */
    }
    if (!closed) typingTimer = clock.setTimeout(() => void typing(), GROUP_TYPING_MS);
  };
  const stopTimers = () => {
    if (typingTimer !== null) clock.clearTimeout(typingTimer);
    if (placeholderTimer !== null) clock.clearTimeout(placeholderTimer);
    typingTimer = placeholderTimer = null;
  };

  const privateHintRow = (): InlineKeyboardButton[][] => {
    try {
      if (!s.groups.claimPrivateHint(c.chatId, localDay(clock.now(), 'UTC'))) return [];
      const hash = s.crypto.hmac('chat_ref', String(c.chatId)).slice(0, 16);
      return [[{ text: s.strings.t('use_privately_button', c.lang), url: `https://t.me/${s.telegram.botInfo.username}?start=grp_${hash}` }]];
    } catch {
      return [];
    }
  };

  /**
   * Edits the placeholder with the answer; overflow parts and total failure fall back to new messages. When the edit
   * fell back to entities / plain text (4096 chars), what did not fit goes out as new messages before the other parts
   * (review F1), all through the outbox in order; the keyboard is on the last message.
   */
  async function deliver(what: string, md: string, markup: { inline_keyboard: InlineKeyboardButton[][] } | undefined): Promise<SentRef[]> {
    if (placeholderSending) await placeholderSending;
    if (placeholderId === null) return sendDurable(c, what, md, { ...(markup ? { replyMarkup: markup } : {}), ...(trigger ? { replyTo: trigger } : {}) });
    const parts = s.telegram.render.split(md);
    const whole = parts.length <= 1;
    let edited: { kind: 'rich' | 'entities' | 'plain'; rest: EditOverflow[] };
    try {
      edited = await editMarkdownChainWithRest(s.telegram.api, { chatId: c.chatId, messageId: placeholderId }, parts[0] ?? '', whole && markup ? { replyMarkup: markup } : {});
    } catch (e) {
      s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'placeholder edit failed; sending a new message');
      const refs = await sendDurable(c, what, md, { ...(markup ? { replyMarkup: markup } : {}), ...(trigger ? { replyTo: trigger } : {}) });
      try {
        await api()['deleteMessage']!({ chat_id: c.chatId, message_id: placeholderId });
      } catch {
        /* the placeholder stays */
      }
      return refs;
    }
    const refs: SentRef[] = [{ chatId: c.chatId, messageId: placeholderId, kind: edited.kind }];
    if (edited.rest.length) refs.push(...(await sendOverflow(`${what}-ov`, edited.rest, whole ? markup : undefined)));
    if (parts.length > 1) refs.push(...(await sendDurable(c, `${what}-rest`, parts.slice(1).join('\n\n'), markup ? { replyMarkup: markup } : {})));
    return refs;
  }

  /** Entity / plain chunks as durable outbox rows (`run:<id>:<what>:<i>`), enqueued first so they keep their order. */
  async function sendOverflow(what: string, chunks: EditOverflow[], markup: { inline_keyboard: InlineKeyboardButton[][] } | undefined): Promise<SentRef[]> {
    const reqs: OutboxRequest[] = chunks.map((ch, i) => ({
      idempotencyKey: `run:${run.id}:${what}:${i}`,
      ...(run.userId ? { userId: run.userId } : {}),
      chatId: c.chatId,
      ...(c.threadId ? { threadId: c.threadId } : {}),
      method: 'sendMessage',
      payload: {
        text: ch.text,
        ...(ch.entities?.length ? { entities: ch.entities } : {}),
        link_preview_options: { is_disabled: true },
        ...(i === chunks.length - 1 && markup ? { reply_markup: markup } : {}),
      },
      priority: 1,
    }));
    for (const r of reqs) s.telegram.outbox.enqueue(r);
    const out: SentRef[] = [];
    for (const r of reqs) {
      try {
        out.push(...(await s.telegram.outbox.sendNow(r)));
      } catch (e) {
        if (!isOutboxPending(e)) throw e;
        break; // the outbox worker delivers this chunk and the rest in order
      }
    }
    return out;
  }

  const ch: ReplyChannel = {
    kind: 'group',
    get visibleText() {
      return committed + pending;
    },
    async begin() {
      await react(true);
      void typing();
      if (placeholderId === null) {
        placeholderTimer = clock.setTimeout(() => {
          placeholderTimer = null;
          if (closed) return;
          placeholderSending = (async () => {
            try {
              const m = await api()['sendMessage']!({ chat_id: c.chatId, text: s.strings.t('guest_placeholder', c.lang), ...thread(), ...(trigger ? { reply_parameters: { message_id: trigger, allow_sending_without_reply: true } } : {}) });
              const id = (m as { message_id?: number }).message_id;
              if (typeof id === 'number') placeholderId = id;
            } catch (e) {
              s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'group placeholder failed');
            }
          })();
        }, GROUP_PLACEHOLDER_MS);
      }
    },
    text(d) {
      if (!closed) pending += d;
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
      if (b.index === -1 && b.type === 'retry') ch.resetIteration();
    },
    async checkpoint() {
      // groups have no drafts: text is only ever sent at the end (approval cards go to the owner's DM)
    },
    async finalize(o) {
      closed = true;
      stopTimers();
      const body = committed + pending;
      const safe = body.trim() ? s.telegram.render.sanitize(body, { allowedLinkHosts: o.allowedLinkHosts, allowedEmails: o.allowedEmails }) : '';
      const final = assembleFinal(c, safe, o.footerLines, o.effects, safe ? privateHintRow() : []);
      let refs: SentRef[] = [];
      if (final.markdown) {
        refs = await deliver('final', final.markdown, final.replyMarkup);
        recordLinks(c, refs, 'answer');
      }
      await react(false);
      const extra = await sendEffectMessages(c, o.effects.filter((e) => e.kind !== 'line' && e.kind !== 'buttons'));
      return [...refs, ...extra];
    },
    async stopped() {
      closed = true;
      stopTimers();
      const body = committed + pending;
      const md = [body.trim() ? sanitizeFor(c, body) : '', s.strings.t('stopped', c.lang)].filter((x) => x).join('\n\n');
      recordLinks(c, await deliver('stopped', md, undefined), 'answer');
      await react(false);
    },
    async fail(message) {
      closed = true;
      stopTimers();
      recordLinks(c, await deliver('fail', plainLine(message), undefined), 'answer');
      await react(false);
    },
  };
  return ch;
}
