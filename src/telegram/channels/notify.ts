// telegram/channels/notify.ts (WP2) — missions, briefs and event runs (01 §5.5): no drafts. Status labels edit the mission
// status card (MissionService.setStatusLine), coalesced to once per 3 s. The final message goes through the outbox, with
// disable_notification for low-priority runs and during the owner's quiet hours.
import type { ConversationRow, ReplyChannel, RunRow, SentRef, Services } from '../../contracts/index.ts';
import { inQuietHours } from '../../kernel/timeMath.ts';
import { assembleFinal, plainLine, recordLinks, retryRow, runCtx, sanitizeFor, sendDurable, sendEffectMessages } from './common.ts';

export const STATUS_COALESCE_MS = 3000;

export function createNotifyChannel(s: Services, run: RunRow, conv: ConversationRow): ReplyChannel {
  const c = runCtx(s, run, conv);
  const clock = s.clock;
  const missionId = run.replyRef.missionId;
  // F8: a topic-less (fallback) mission lives in the main DM: every post carries an escaped '[<missionId>] ' prefix, as
  // missions.ts does for its own card / report / finish / stop posts (01 "an [M12] prefix"). A leading block construct
  // (heading, list, quote, fence, table) keeps its own line.
  const tag = missionId && run.replyRef.threadId === undefined ? s.telegram.render.escape(`[${missionId}]`) : null;
  const pre = (md: string): string => {
    if (!tag || !md) return md;
    return /^(\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|))/.test(md) ? `${tag}\n\n${md}` : `${tag} ${md}`;
  };
  let flushed = '';
  let committed = '';
  let pending = '';
  let closed = false;
  let checkpoints = 0;
  // status coalescing
  let wanted: string | null | undefined; // undefined = nothing new
  let lastPushAt = -Infinity;
  let statusTimer: unknown = null;
  let statusChain: Promise<void> = Promise.resolve();

  const silent = (): boolean => {
    if (run.priority === 'proactive' || run.priority === 'background') return true;
    if (!c.user) return false;
    try {
      const st = s.repos.users.settings(c.user.id);
      return inQuietHours(clock.now(), c.user.tz, st.quietStart, st.quietEnd);
    } catch {
      return false;
    }
  };

  const pushStatus = () => {
    statusTimer = null;
    if (wanted === undefined || !missionId) return;
    const label = wanted;
    wanted = undefined;
    lastPushAt = clock.now();
    statusChain = statusChain
      .then(() => s.missions.setStatusLine(missionId, label))
      .catch((e: unknown) => s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'mission status line failed'));
  };

  const stopStatus = async () => {
    if (statusTimer !== null) clock.clearTimeout(statusTimer);
    statusTimer = null;
    await statusChain;
  };

  const ch: ReplyChannel = {
    kind: 'notify',
    get visibleText() {
      return [flushed, committed + pending].filter((x) => x).join('\n\n');
    },
    async begin() {},
    text(d) {
      if (!closed) pending += d;
    },
    status(label) {
      if (closed || !missionId) return;
      wanted = label;
      if (statusTimer !== null) return;
      const delay = Math.max(0, lastPushAt + STATUS_COALESCE_MS - clock.now());
      statusTimer = clock.setTimeout(pushStatus, delay);
    },
    resetIteration() {
      pending = '';
    },
    commitIteration() {
      committed += pending;
      pending = '';
    },
    blockStart(b) {
      if (b.index === -1 && b.type === 'retry') ch.resetIteration();
      else if (b.index === -1 && b.type === 'busy') ch.status(s.strings.t('busy_retrying', c.lang, { seconds: b.name ?? '' }));
    },
    async checkpoint() {
      const text = committed + pending;
      committed = '';
      pending = '';
      if (!text.trim()) return;
      const refs = await sendDurable(c, `cp:${checkpoints++}`, pre(sanitizeFor(c, text)), { silent: silent() });
      recordLinks(c, refs, 'answer');
      flushed += (flushed ? '\n\n' : '') + text;
    },
    async finalize(o) {
      closed = true;
      await stopStatus();
      if (missionId) await s.missions.setStatusLine(missionId, null).catch(() => undefined);
      const body = committed + pending;
      const safe = body.trim() ? s.telegram.render.sanitize(body, { allowedLinkHosts: o.allowedLinkHosts, allowedEmails: o.allowedEmails }) : '';
      const final = assembleFinal(c, safe, o.footerLines, o.effects);
      let refs: SentRef[] = [];
      if (final.markdown) {
        refs = await sendDurable(c, 'final', pre(final.markdown), { ...(final.replyMarkup ? { replyMarkup: final.replyMarkup } : {}), silent: silent() });
        recordLinks(c, refs, run.trigger === 'event' && conv.kind !== 'mission' ? 'brief' : 'answer');
      }
      const extra = await sendEffectMessages(c, o.effects.filter((e) => e.kind !== 'line' && e.kind !== 'buttons'));
      return [...refs, ...extra];
    },
    async stopped() {
      closed = true;
      await stopStatus();
      const body = committed + pending;
      const md = [body.trim() ? sanitizeFor(c, body) : '', s.strings.t('stopped', c.lang)].filter((x) => x).join('\n\n');
      recordLinks(c, await sendDurable(c, 'stopped', pre(md), { silent: silent() }), 'answer');
    },
    async fail(message, retryButton) {
      closed = true;
      await stopStatus();
      const md = [committed.trim() ? sanitizeFor(c, committed) : '', plainLine(message)].filter((x) => x).join('\n\n');
      const rows = retryButton ? retryRow(c) : [];
      recordLinks(c, await sendDurable(c, 'fail', pre(md), rows.length ? { replyMarkup: { inline_keyboard: rows } } : {}), 'answer');
    },
  };
  return ch;
}
