// telegram/channels/dmStream.ts (WP2) — the streaming DM channel, F2 mechanics exactly:
//   - each run segment has a random non-zero int32 draft_id; the first draft is
//     sendRichMessageDraft(chat, id, {markdown:'<tg-thinking>Thinking…</tg-thinking>'}, {message_thread_id?, can_stop, keep_on_stop});
//   - updates re-send the same draft_id with the accumulated, sanitized markdown, at most every 700 ms and only on change;
//     a status tail <tg-thinking>…</tg-thinking> while tools run; a keep-alive re-send every 15 s (drafts live 30 s);
//   - never switch a draft_id from rich to plain: a 400 on a rich draft moves the run to sendMessageDraft with a NEW id and
//     empty text (Telegram's native "Thinking…"); a 400 on plain drafts too → sendChatAction('typing') every 4.5 s;
//   - ⚠U3: on 429 the interval doubles (cap 3 s); after 3 consecutive 429s drafts stop for the run (typing actions only);
//   - automatic checkpoint when the text passes 30 000 chars; checkpoint() persists the visible text and starts a new draft_id;
//   - finalize: sanitized text + code-built footer, split and sent with the rich → entities → plain chain (durable,
//     idempotent outbox rows run:<id>:final:<i>); Stop sends the partial text plus "⏹ Stopped";
//   - 03 R1/R8 block starts: 'retry' discards the current call's partial text, 'busy' shows "⏳ Busy — retrying in Ns";
//   - 03 R4: a DM run started from a voice input, with voice replies on, also gets a voice reply (≤ 600 chars of plain
//     text through capabilities.tts + sendVoice); longer answers get [🔊 Listen] (vo:<runId>, WP7's callback).
import { GrammyError } from 'grammy';
import type { ConversationRow, Effect, ReplyChannel, RunRow, SentRef, Services } from '../../contracts/index.ts';
import { draftId as newDraftId } from '../../kernel/ids.ts';
import { escapeHtmlText } from '../render/escape.ts';
import { plainText, rawOf } from '../render/fallback.ts';
import { hygiene } from '../render/hygiene.ts';
import { assembleFinal, DRAFT_CTX, plainLine, recordLinks, retryRow, runCtx, sanitizeFor, sendDurable, sendEffectMessages, type RunCtx } from './common.ts';

export const DRAFT_MIN_INTERVAL_MS = 700;
export const DRAFT_MAX_INTERVAL_MS = 3000;
export const KEEPALIVE_MS = 15_000;
export const TYPING_EVERY_MS = 4500;
export const AUTO_CHECKPOINT_CHARS = 30_000;
export const PLAIN_AUTO_CHECKPOINT_CHARS = 4000;
export const VOICE_MAX_CHARS = 600;
/** The text of a final message that only carries the keyboard (everything else was sent as checkpoints). */
export const KEYBOARD_ONLY_TEXT = '⤴';

type Mode = 'rich' | 'plain' | 'typing' | 'closed';

export function createDmStreamChannel(s: Services, run: RunRow, conv: ConversationRow, onDraft: (draftId: number) => void): ReplyChannel {
  const c: RunCtx = runCtx(s, run, conv);
  const clock = s.clock;
  const thinkingLabel = /^(ru|uk|kk|be)/i.test(c.lang ?? '') ? 'Думаю…' : 'Thinking…';

  let mode: Mode = 'rich';
  let draft = 0;
  let flushed = ''; // text already persisted by checkpoints
  let committed = '';
  let pending = '';
  let status: string | null = null;
  let busy: string | null = null;
  let thinking = false;
  let interval = DRAFT_MIN_INTERVAL_MS;
  let consecutive429 = 0;
  let lastSentAt = -Infinity;
  let lastContent: string | null = null;
  let throttle: unknown = null;
  let keepAlive: unknown = null;
  let typing: unknown = null;
  let inFlight: Promise<void> | null = null;
  let dirty = false;
  let checkpoints = 0;
  let ops: Promise<unknown> = Promise.resolve(); // serializes checkpoint sends

  const api = () => rawOf(s.telegram.api);
  const threadOpt = () => (c.threadId ? { message_thread_id: c.threadId } : {});

  function allocateDraft() {
    draft = newDraftId();
    lastContent = null;
    onDraft(draft);
  }

  function compose(): string {
    const body = committed + pending;
    const label = busy ?? status ?? (thinking || !body.trim() ? thinkingLabel : null);
    if (mode === 'plain') {
      let text = body.trim() ? plainText(sanitizeFor(c, hygiene(body), DRAFT_CTX)) : '';
      if (label && text) text += `\n\n⏳ ${label}`;
      else if (label && (status || busy)) text = `⏳ ${label}`;
      return [...text].slice(-4096).join('');
    }
    let md = body.trim() ? sanitizeFor(c, hygiene(body), DRAFT_CTX) : '';
    if (label) md += `${md ? '\n\n' : ''}<tg-thinking>${escapeHtmlText(label)}</tg-thinking>`;
    return md;
  }

  function clearTimers() {
    if (throttle !== null) clock.clearTimeout(throttle);
    if (keepAlive !== null) clock.clearTimeout(keepAlive);
    if (typing !== null) clock.clearTimeout(typing);
    throttle = keepAlive = typing = null;
  }

  function schedule(): void {
    if (mode === 'closed' || mode === 'typing' || draft === 0) return;
    if (inFlight || throttle !== null) {
      dirty = true;
      return;
    }
    const delay = Math.max(0, lastSentAt + interval - clock.now());
    throttle = clock.setTimeout(() => {
      throttle = null;
      void push(false);
    }, delay);
  }

  function armKeepAlive() {
    if (keepAlive !== null) clock.clearTimeout(keepAlive);
    keepAlive = null;
    if (mode !== 'rich' && mode !== 'plain') return;
    keepAlive = clock.setTimeout(() => {
      keepAlive = null;
      if (inFlight || throttle !== null) return;
      void push(true);
    }, KEEPALIVE_MS);
  }

  function startTyping() {
    mode = 'typing';
    clearTimers();
    const tick = async () => {
      typing = null;
      if (mode !== 'typing') return;
      try {
        await api()['sendChatAction']!({ chat_id: c.chatId, action: 'typing', ...threadOpt() });
      } catch {
        /* best effort */
      }
      if (mode === 'typing') typing = clock.setTimeout(() => void tick(), TYPING_EVERY_MS);
    };
    void tick();
  }

  /** Sends the current draft content (force = keep-alive re-send even when unchanged). */
  function push(force: boolean): Promise<void> {
    if (mode !== 'rich' && mode !== 'plain') return Promise.resolve();
    let content: string;
    try {
      content = compose();
    } catch (e) {
      // push runs inside timer callbacks: a throw here would be an uncaught exception (review F10). Skip this update.
      s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'draft compose failed');
      return Promise.resolve();
    }
    if (!force && content === lastContent) return Promise.resolve();
    const sentMode = mode;
    const id = draft;
    lastSentAt = clock.now();
    const call =
      sentMode === 'rich'
        ? api()['sendRichMessageDraft']!({ chat_id: c.chatId, draft_id: id, rich_message: { markdown: content, skip_entity_detection: true }, can_stop: true, keep_on_stop: true, ...threadOpt() })
        : api()['sendMessageDraft']!({ chat_id: c.chatId, draft_id: id, text: content, can_stop: true, keep_on_stop: true, ...threadOpt() });
    inFlight = call.then(
      () => {
        consecutive429 = 0;
        lastContent = content;
      },
      (e: unknown) => onDraftError(e, sentMode),
    ).finally(() => {
      inFlight = null;
      if (mode === 'rich' || mode === 'plain') {
        armKeepAlive();
        if (dirty) {
          dirty = false;
          schedule();
        }
      }
    });
    return inFlight;
  }

  async function onDraftError(e: unknown, sentMode: Mode): Promise<void> {
    if (mode !== sentMode) return; // already moved on
    if (e instanceof GrammyError && e.error_code === 429) {
      consecutive429++;
      interval = Math.min(interval * 2, DRAFT_MAX_INTERVAL_MS);
      if (consecutive429 >= 3) {
        s.log.warn({ runId: run.id }, 'drafts rate-limited 3 times: typing actions for the rest of the run (⚠U3)');
        startTyping();
        return;
      }
      dirty = true;
      return;
    }
    if (e instanceof GrammyError && e.error_code === 400) {
      if (sentMode === 'rich') {
        // never switch a draft_id from rich to plain: a NEW id, empty text first (native "Thinking…")
        mode = 'plain';
        allocateDraft();
        lastSentAt = clock.now();
        try {
          await api()['sendMessageDraft']!({ chat_id: c.chatId, draft_id: draft, text: '', can_stop: true, keep_on_stop: true, ...threadOpt() });
          lastContent = '';
          dirty = true;
        } catch (e2) {
          if (e2 instanceof GrammyError && e2.error_code === 429) {
            consecutive429++;
            dirty = true;
          } else startTyping();
        }
        return;
      }
      startTyping();
      return;
    }
    s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'draft update failed');
  }

  function autoCheckpointIfNeeded() {
    const limit = mode === 'plain' ? PLAIN_AUTO_CHECKPOINT_CHARS : AUTO_CHECKPOINT_CHARS;
    if ((committed + pending).length > limit) void checkpointInternal();
  }

  function checkpointInternal(): Promise<void> {
    const text = committed + pending;
    committed = '';
    pending = '';
    if (throttle !== null) clock.clearTimeout(throttle);
    throttle = null;
    const n = checkpoints++;
    const p = ops.then(async () => {
      if (!text.trim()) return;
      const refs = await sendDurable(c, `cp:${n}`, sanitizeFor(c, text));
      recordLinks(c, refs, 'answer');
      flushed += (flushed ? '\n\n' : '') + text;
    });
    ops = p.catch(() => undefined);
    if (mode === 'rich' || mode === 'plain') allocateDraft(); // later text uses a new draft_id
    return p;
  }

  async function settle() {
    mode = 'closed';
    clearTimers();
    if (inFlight) await inFlight.catch(() => undefined);
    await ops;
  }

  function wantsVoice(): boolean {
    if (!s.config.features.voiceReplies || !c.user?.voiceReplies || !run.userId) return false;
    try {
      return s.repos.inputs.consumedBy(run.id).some((i) => i.kind === 'voice');
    } catch {
      return false;
    }
  }

  async function sendVoice(text: string, replyTo: number | undefined): Promise<void> {
    try {
      const { ogg } = await s.capabilities.tts.speak(text, { priority: run.priority, meta: { userId: run.userId!, runId: run.id, conversationId: conv.id } });
      const blobId = s.repos.messages.putBlob({ ownerUserId: run.userId, dek: `u:${run.userId}`, mime: 'audio/ogg', bytes: ogg });
      const refs = await s.telegram.outbox.sendNow({
        idempotencyKey: `run:${run.id}:voice`, userId: run.userId!, chatId: c.chatId, ...(c.threadId ? { threadId: c.threadId } : {}),
        method: 'sendVoice', payload: { blob_id: blobId, filename: 'voice.ogg', ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) },
        priority: 1,
      });
      recordLinks(c, refs, 'voice');
    } catch (e) {
      s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'voice reply failed (text was sent)'); // R4: silent
    }
  }

  const ch: ReplyChannel = {
    kind: 'dm_stream',
    get visibleText() {
      return [flushed, committed + pending].filter((x) => x).join('\n\n');
    },
    async begin() {
      if (draft !== 0) return;
      allocateDraft();
      await push(true);
    },
    text(delta) {
      if (mode === 'closed' || !delta) return;
      pending += delta;
      thinking = false;
      busy = null;
      autoCheckpointIfNeeded();
      schedule();
    },
    status(label) {
      if (mode === 'closed') return;
      status = label;
      busy = null;
      schedule();
    },
    resetIteration() {
      pending = '';
      schedule();
    },
    commitIteration() {
      committed += pending;
      pending = '';
    },
    blockStart(b) {
      if (mode === 'closed') return;
      if (b.index === -1 && b.type === 'retry') return ch.resetIteration();
      if (b.index === -1 && b.type === 'busy') {
        busy = s.strings.t('busy_retrying', c.lang, { seconds: b.name ?? '' });
        schedule();
        return;
      }
      if (b.type === 'thinking') {
        thinking = true;
        schedule();
      }
    },
    async checkpoint() {
      await checkpointInternal();
    },
    async finalize(o) {
      const body = committed + pending;
      await settle();
      const safe = body.trim() ? s.telegram.render.sanitize(body, { allowedLinkHosts: o.allowedLinkHosts, allowedEmails: o.allowedEmails }) : '';
      const voice = safe && wantsVoice() ? plainText(safe).trim() : '';
      const listen = voice.length > VOICE_MAX_CHARS ? listenRow() : [];
      const final = assembleFinal(c, safe, o.footerLines, o.effects, listen);
      let refs: SentRef[] = [];
      if (final.markdown) {
        refs = await sendDurable(c, 'final', final.markdown, final.replyMarkup ? { replyMarkup: final.replyMarkup } : {});
        recordLinks(c, refs, 'answer');
      } else if (final.replyMarkup) {
        // the whole answer already went out as checkpoints: the keyboard (Undo, Continue, Listen) still needs a message
        refs = await sendDurable(c, 'final', KEYBOARD_ONLY_TEXT, { replyMarkup: final.replyMarkup });
        recordLinks(c, refs, 'answer');
      }
      if (voice && voice.length <= VOICE_MAX_CHARS) await sendVoice(voice, run.replyRef.triggerMessageId ?? refs[0]?.messageId);
      const extra = await sendEffectMessages(c, o.effects.filter((e: Effect) => e.kind !== 'line' && e.kind !== 'buttons'));
      return [...refs, ...extra];
    },
    async stopped() {
      const body = committed + pending;
      await settle();
      const md = [body.trim() ? sanitizeFor(c, body) : '', s.strings.t('stopped', c.lang)].filter((x) => x).join('\n\n');
      const refs = await sendDurable(c, 'stopped', md);
      recordLinks(c, refs, 'answer');
    },
    async fail(message, retryButton) {
      const body = committed; // nothing from the failed call was persisted
      await settle();
      const md = [body.trim() ? sanitizeFor(c, body) : '', plainLine(message)].filter((x) => x).join('\n\n');
      const rows = retryButton ? retryRow(c) : [];
      const refs = await sendDurable(c, 'fail', md, rows.length ? { replyMarkup: { inline_keyboard: rows } } : {});
      recordLinks(c, refs, 'answer');
    },
  };

  function listenRow() {
    try {
      return [[{ text: s.strings.t('listen_button', c.lang), callback_data: s.telegram.codec.encode('vo', [run.id], c.owner) }]];
    } catch {
      return [];
    }
  }

  return ch;
}
