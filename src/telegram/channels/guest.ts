// telegram/channels/guest.ts (WP2) — @gora guest answers (01 §5.5, F13, ⚠U1, ⚠U2): the run races a 3 s timer. Exactly one
// answerGuestQuery per guest_query_id: the answer itself when it is ready in time, otherwise a placeholder that is edited
// later through inline_message_id — rich edit, then plain edit; when both fail the invocation is marked failed (the
// placeholder already tells the caller to tap 🔒 Continue privately).
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { ConversationRow, ReplyChannel, RunRow, SentRef, Services } from '../../contracts/index.ts';
import { editMarkdownChain, isBadRequest, plainChunks, plainText, rawOf } from '../render/fallback.ts';
import { plainLine, runCtx, sanitizeFor } from './common.ts';

export const GUEST_RACE_MS = 3000;

export function createGuestChannel(s: Services, run: RunRow, conv: ConversationRow): ReplyChannel {
  const c = runCtx(s, run, conv);
  const clock = s.clock;
  const ref = run.replyRef;
  const gqid = ref.guestQueryId ?? '';
  const ru = /^(ru|uk|kk|be)/i.test(c.lang ?? '');
  let committed = '';
  let pending = '';
  let answered = !!ref.inlineMessageId; // one answerGuestQuery per query (a restart finds the placeholder id on the run)
  let inlineId: string | null = ref.inlineMessageId ?? null;
  let raceTimer: unknown = null;
  let placeholder: Promise<void> | null = null;
  let done = false;

  const markup = (): InlineKeyboardMarkup | undefined =>
    ref.continueUrl ? { inline_keyboard: [[{ text: s.strings.t('continue_privately_button', c.lang), url: ref.continueUrl }]] } : undefined;
  const article = (content: Record<string, unknown>) => {
    const m = markup();
    return { type: 'article', id: 'g1', title: 'Gora', input_message_content: content, ...(m ? { reply_markup: m } : {}) };
  };
  const mark = (status: 'placeholder' | 'answered' | 'edited' | 'failed', id?: string) => {
    try {
      s.guests.mark(gqid, status, id);
    } catch (e) {
      s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'guest invocation mark failed');
    }
  };

  function sendPlaceholder(): Promise<void> {
    if (answered || !gqid) return Promise.resolve();
    answered = true;
    const hint = ru ? 'Если ответ не обновится, нажмите 🔒 «Продолжить лично».' : 'If this doesn’t update, tap 🔒 Continue privately.';
    return (async () => {
      try {
        const r = await rawOf(s.telegram.api)['answerGuestQuery']!({ guest_query_id: gqid, result: article({ message_text: `${s.strings.t('guest_placeholder', c.lang)}\n\n${hint}` }) });
        inlineId = (r as { inline_message_id?: string }).inline_message_id ?? null;
        mark('placeholder', inlineId ?? undefined);
        if (inlineId) {
          try {
            s.repos.runs.update(run.id, { replyRef: { ...ref, inlineMessageId: inlineId } }); // a restart edits instead of re-answering
          } catch (e) {
            s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'could not persist the guest placeholder id');
          }
        }
      } catch (e) {
        s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'guest placeholder failed');
        mark('failed');
      }
    })();
  }

  /** Delivers the final markdown: direct answer if nothing was answered yet, else the ⚠U1 edit chain. */
  async function deliver(md: string): Promise<SentRef[]> {
    done = true;
    if (raceTimer !== null) clock.clearTimeout(raceTimer);
    raceTimer = null;
    if (placeholder) await placeholder;
    const first = s.telegram.render.split(md)[0] ?? md;
    if (!answered) {
      answered = true;
      const raw = rawOf(s.telegram.api);
      try {
        let r: unknown;
        try {
          r = await raw['answerGuestQuery']!({ guest_query_id: gqid, result: article({ rich_message: { markdown: first, skip_entity_detection: true } }) });
        } catch (e) {
          if (!isBadRequest(e)) throw e;
          r = await raw['answerGuestQuery']!({ guest_query_id: gqid, result: article({ message_text: plainChunks(plainText(first))[0] ?? '…' }) });
        }
        mark('answered', (r as { inline_message_id?: string }).inline_message_id);
      } catch (e) {
        s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'answerGuestQuery failed');
        mark('failed');
      }
      return [];
    }
    if (!inlineId) return []; // the placeholder itself failed; nothing can be edited
    try {
      const m = markup();
      await editMarkdownChain(s.telegram.api, { inlineMessageId: inlineId }, first, m ? { replyMarkup: m } : {});
      mark('edited', inlineId);
    } catch (e) {
      s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'guest edit failed (⚠U1)');
      mark('failed', inlineId);
    }
    return [];
  }

  const ch: ReplyChannel = {
    kind: 'guest',
    get visibleText() {
      return committed + pending;
    },
    async begin() {
      if (answered || done) return;
      raceTimer = clock.setTimeout(() => {
        raceTimer = null;
        if (!done) placeholder = sendPlaceholder();
      }, GUEST_RACE_MS);
    },
    text(d) {
      if (!done) pending += d;
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
    async checkpoint() {},
    async finalize(o) {
      const body = committed + pending;
      const safe = body.trim() ? s.telegram.render.sanitize(body, { allowedLinkHosts: o.allowedLinkHosts, allowedEmails: o.allowedEmails }) : '';
      const lines = [...o.footerLines, ...o.effects.flatMap((e) => (e.kind === 'line' ? [e.markdown] : []))].filter((l) => l.trim());
      const md = [safe, lines.join('\n')].filter((x) => x).join('\n\n') || '…';
      return deliver(md);
    },
    async stopped() {
      const body = committed + pending;
      await deliver([body.trim() ? sanitizeFor(c, body) : '', s.strings.t('stopped', c.lang)].filter((x) => x).join('\n\n'));
    },
    async fail(message) {
      await deliver(plainLine(message));
    },
  };
  return ch;
}
