// src/surfaces/callbacks.ts (WP7a) — the generic callback router (01 §4.3: decode + MAC/owner check through WP2's
// codec, per-user tap rate, dispatch through the shared CallbackRegistry, answerCallbackQuery) and the WP7a callback
// kinds: ch (offer_choices taps), pl (plans), ct (Retry / Continue), vo (🔊 Listen, 03 R4). ob/tz live in
// onboarding.ts, dl in commands.ts.
import type { Context } from 'grammy';
import type { CallbackAnswer, CallbackCtx, ChannelKind, ConversationRow } from '../contracts/index.ts';
import type { PaymentsModule } from './payments.ts';
import { st } from './strings.ts';
import { cb, cutAt, errName, langOf, plainOf, sendRich, setKeyboard, type Surf } from './util.ts';

export const LISTEN_MAX_CHARS = 600;

export function channelFor(conv: ConversationRow): ChannelKind {
  switch (conv.kind) {
    case 'group':
      return 'group';
    case 'guest':
      return 'guest';
    case 'biz_draft':
      return 'biz_owner';
    case 'mission':
      return 'notify';
    default:
      return 'dm_stream';
  }
}

export function createCallbacks(surf: Surf, deps: { payments: PaymentsModule }) {
  const { s } = surf;
  const pending = new Set<Promise<void>>();

  /** bot.on('callback_query:data') */
  async function route(ctx: Context): Promise<void> {
    const q = ctx.callbackQuery;
    if (!q || q.data === undefined) return;
    const fromId = q.from.id;
    const lang = q.from.language_code;
    const answer = async (a: CallbackAnswer) => {
      try {
        await s.telegram.api.answerCallbackQuery(q.id, a && a.text ? { text: a.text.slice(0, 200), ...(a.alert ? { show_alert: true } : {}) } : {});
      } catch (e) {
        surf.log.debug({ err: errName(e) }, 'callbacks: answerCallbackQuery failed');
      }
    };
    if (!s.quotas.rate(`cb:${fromId}`, s.config.limits.callbacksPerSecond, 1_000)) {
      await answer({ text: st('too_many_taps', lang) });
      return;
    }
    const dec = s.telegram.codec.decode(q.data, fromId);
    if ('error' in dec) {
      await answer({ text: st(dec.error === 'not_owner' ? 'button_not_yours' : 'button_invalid', lang), ...(dec.error === 'not_owner' ? {} : {}) });
      return;
    }
    const user = s.repos.users.getByTg(fromId);
    const m = q.message;
    const c: CallbackCtx = {
      kind: dec.kind, parts: dec.parts, fromTgId: fromId, user: user && user.status !== 'deleting' ? user : undefined, callbackQueryId: q.id,
      ...(m ? { message: { chatId: m.chat.id, messageId: m.message_id, ...('message_thread_id' in m && m.message_thread_id ? { threadId: m.message_thread_id } : {}) } } : {}),
      ...(q.inline_message_id ? { inlineMessageId: q.inline_message_id } : {}),
    };
    let res: CallbackAnswer;
    try {
      res = await s.telegram.callbacks.dispatch(c);
    } catch (e) {
      surf.log.warn({ err: errName(e), kind: dec.kind }, 'callbacks: handler failed');
      res = { text: st('something_wrong', lang) };
    }
    await answer(res);
  }

  // ── ch:<setId>:<i>
  async function onChoice(c: CallbackCtx): Promise<CallbackAnswer> {
    const lang = langOf(c.user);
    const [setId, idx] = c.parts;
    if (!setId) return { text: st('button_invalid', lang) };
    const set = surf.choices.get(setId);
    if (!set) return { text: st('button_expired', lang) };
    if (set.userId && set.userId !== c.user?.id) return { text: st('button_not_yours', lang) };
    if (set.usedAt !== null || idx === 'x') return { text: st('choice_used', lang) };
    if (set.expiresAt <= s.clock.now()) return { text: st('button_expired', lang) };
    const i = Number(idx);
    const option = Number.isInteger(i) ? set.options[i] : undefined;
    if (option === undefined) return { text: st('button_invalid', lang) };
    if (!surf.choices.markUsed(setId)) return { text: st('choice_used', lang) };
    const conv = s.repos.conversations.get(set.conversationId);
    if (!conv || conv.status !== 'active') return { text: st('button_expired', lang) };
    if (c.message) {
      const label = `✓ ${option}`.slice(0, 60);
      await setKeyboard(surf, { chatId: c.message.chatId, messageId: c.message.messageId, userId: conv.userId }, [[{ text: label, callback_data: cb(surf, 'ch', [setId, 'x'], 0) }]], `ch:${setId}:kb`);
    }
    const isGroup = conv.kind === 'group';
    const name = c.user?.firstName ?? 'Member';
    s.repos.inputs.add({
      conversationId: conv.id, kind: 'choice', author: isGroup ? 'member' : 'owner', untrusted: false,
      content: [{ type: 'text', text: isGroup ? `[Member: ${name}] ${option}` : option }],
      tgUpdateId: null, tgChatId: set.chatId, tgMessageId: c.message?.messageId ?? null, fromTgUserId: c.fromTgId, replyToCardId: null,
    });
    s.runner.kick(conv.id);
    return { text: `✓ ${option}`.slice(0, 190) };
  }

  // ── pl:open | pl:inc | pl:buy:<plan> | pl:cancel
  async function onPlan(c: CallbackCtx): Promise<CallbackAnswer> {
    const user = c.user;
    if (!user) return { text: st('start_first', null) };
    const lang = langOf(user);
    const chat = { chatId: user.dmChatId ?? user.tgUserId };
    switch (c.parts[0]) {
      case 'open':
        await deps.payments.planCard(user, chat, `pl:open:${c.callbackQueryId}`);
        return;
      case 'inc':
        await sendRich(surf, { ...chat, userId: user.id }, deps.payments.includedText(lang), { idem: `pl:inc:${c.callbackQueryId}` });
        return;
      case 'buy': {
        const plan = c.parts[1];
        if (plan !== 'plus' && plan !== 'pro') return { text: st('button_invalid', lang) };
        await deps.payments.sendInvoice(user, plan, chat, `pl:buy:${c.callbackQueryId}`);
        return;
      }
      case 'cancel': {
        const stt = deps.payments.status(user.id);
        if (stt.state !== 'active' || user.plan === 'free') return { text: st('plan_no_sub', lang), alert: true };
        try {
          await deps.payments.cancel(user.id);
        } catch (e) {
          surf.log.warn({ err: errName(e) }, 'plan: cancel failed');
          return { text: st('something_wrong', lang), alert: true };
        }
        const after = deps.payments.status(user.id);
        const planName = st(user.plan === 'pro' ? 'plan_pro' : 'plan_plus', lang);
        const date = after.periodEnd ? s.telegram.render.tgTime(Math.floor(after.periodEnd / 1000), 'DT', new Date(after.periodEnd).toISOString().slice(0, 10)) : '—';
        if (c.message) await setKeyboard(surf, { chatId: c.message.chatId, messageId: c.message.messageId, userId: user.id }, null, `pl:cancel:kb:${c.message.chatId}:${c.message.messageId}`);
        await sendRich(surf, { ...chat, userId: user.id }, st('plan_canceled', lang, { plan: planName, date }), { idem: `pl:cancel:${c.callbackQueryId}` });
        return;
      }
      default:
        return { text: st('button_invalid', lang) };
    }
  }

  // ── ct:<conversationId>:r|c  (↻ Retry / Continue ▶)
  async function onContinue(c: CallbackCtx): Promise<CallbackAnswer> {
    const lang = langOf(c.user);
    const [convId, what] = c.parts;
    const conv = convId ? s.repos.conversations.get(convId) : undefined;
    if (!conv || conv.status !== 'active') return { text: st('button_expired', lang) };
    const ownerOk = conv.userId ? c.user?.id === conv.userId : conv.kind === 'group' && c.message?.chatId === conv.tgChatId;
    if (!ownerOk) return { text: st('button_not_yours', lang) };
    if (what !== 'r' && what !== 'c') return { text: st('button_invalid', lang) };
    if (c.message) await setKeyboard(surf, { chatId: c.message.chatId, messageId: c.message.messageId, userId: conv.userId }, null, `ct:${convId}:${c.message.messageId}:kb`);
    const chatId = conv.tgChatId ?? c.message?.chatId ?? c.fromTgId;
    const replyRef = { chatId, ...(conv.threadId ? { threadId: conv.threadId } : {}), ...(c.message ? { triggerMessageId: c.message.messageId } : {}) };
    try {
      s.runner.startEventRun(conv.id, what === 'r' ? { type: 'retry', body: 'The owner tapped Retry: answer their last message again.' } : { type: 'continue', body: 'The owner tapped Continue: carry on from where you stopped.' }, { channel: channelFor(conv), replyRef, priority: 'interactive' });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'ct: startEventRun failed');
      return { text: st('something_wrong', lang) };
    }
    return { text: st('continue_toast', lang) };
  }

  // ── vo:<runId>  (🔊 Listen: synthesize the first 600 chars of that answer)
  async function onListen(c: CallbackCtx): Promise<CallbackAnswer> {
    const user = c.user;
    if (!user) return { text: st('start_first', null) };
    const lang = langOf(user);
    if (!s.config.features.voiceReplies) return { text: st('voice_unavailable', lang), alert: true };
    const run = c.parts[0] ? s.repos.runs.get(c.parts[0]) : undefined;
    if (!run || run.userId !== user.id) return { text: st('listen_unavailable', lang), alert: true };
    if (!s.quotas.rate(`vo:${user.id}`, 5, 60_000)) return { text: st('too_many_taps', lang) };
    let text = '';
    try {
      const rows = s.repos.messages.load(run.conversationId, run.epoch).filter((m) => m.runId === run.id && m.role === 'assistant');
      const parts: string[] = [];
      for (const m of rows) {
        const content = m.content.content;
        if (typeof content === 'string') parts.push(content);
        else for (const b of content) if (b.type === 'text') parts.push(b.text);
      }
      text = parts.join('\n').trim();
    } catch (e) {
      surf.log.debug({ err: errName(e) }, 'vo: transcript unavailable');
    }
    if (!text && run.visibleText) text = run.visibleText;
    const speakable = cutAt(plainOf(text), LISTEN_MAX_CHARS);
    if (!speakable) return { text: st('listen_unavailable', lang), alert: true };
    const chat = c.message ? { chatId: c.message.chatId, ...(c.message.threadId ? { threadId: c.message.threadId } : {}) } : { chatId: user.dmChatId ?? user.tgUserId };
    const replyTo = c.message?.messageId;
    const job = (async () => {
      try {
        const { ogg } = await s.caps.tts.speak(speakable, { priority: 'interactive', meta: { userId: user.id, runId: run.id, conversationId: run.conversationId } });
        const blobId = s.repos.messages.putBlob({ ownerUserId: user.id, dek: `u:${user.id}`, mime: 'audio/ogg', bytes: ogg });
        await s.telegram.outbox.sendNow({
          idempotencyKey: `vo:${run.id}:${c.callbackQueryId}`, userId: user.id, ...chat, method: 'sendVoice',
          payload: { blob_id: blobId, filename: 'gora.ogg', ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) },
        });
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'vo: tts failed');
        await sendRich(surf, { ...chat, userId: user.id }, st('listen_failed', lang), { idem: `vo:fail:${c.callbackQueryId}` });
      }
    })();
    pending.add(job);
    void job.finally(() => pending.delete(job));
    return { text: st('listen_toast', lang) };
  }

  return {
    route,
    onChoice,
    onPlan,
    onContinue,
    onListen,
    /** Tests / shutdown: wait for background Listen syntheses. */
    async idle() {
      await Promise.all([...pending]);
    },
  };
}
export type Callbacks = ReturnType<typeof createCallbacks>;
