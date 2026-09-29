// groups/observe.ts (GR, spec 07 C3/C4) — every group message the bot can read (privacy mode OFF): stored sealed under
// the group DEK (14-day rolling retention), counted toward the next summary batch (40 messages, or 10 idle minutes),
// the 45 s lull check (re)armed, and engagement with an open chime-in rewarded. Local work only (C7: reading the group
// costs no LLM call). Never throws.
import type { GroupChimeKind, GroupObservedMessage, Ms } from '../contracts/index.ts';
import type { GroupCtx } from './ctx.ts';
import { scriptLang } from './ctx.ts';
import type { Feedback } from './feedback.ts';

export function createObserve(g: GroupCtx, fb: Feedback) {
  const { s } = g;

  function scheduleSummary(chatId: number, pending: number, now: Ms): void {
    const L = g.L();
    const runAt = pending >= L.groupSummaryEveryMessages ? now : now + L.groupSummaryIdleMs;
    s.scheduler.schedule({ kind: 'group_summarize', runAt, refId: String(chatId), payload: { chatId }, dedupeKey: `gsum:${chatId}` });
  }

  async function observe(m: GroupObservedMessage): Promise<void> {
    try {
      if (!g.readsAll()) return;
      const text = m.text.replace(/\u0000/g, '').trim();
      if (!text) return;
      const inserted = g.repo().insertMessage({
        chatId: m.chatId, tgMessageId: m.tgMessageId, threadId: m.threadId, fromTgId: m.fromTgId, kind: m.kind, addressed: m.addressed,
        replyToTgMessageId: m.replyToTgMessageId, text: text.slice(0, g.L().groupMessageMaxChars), senderName: (m.fromName || 'Member').replace(/[[\]\n]/g, ' ').slice(0, 64), at: m.at,
      });
      if (!inserted) return; // re-delivery
      const now = s.clock.now();
      const pol = g.repo().policy(m.chatId);
      const lang = pol?.lang ?? scriptLang(text) ?? null;
      g.repo().updatePolicy(m.chatId, { lastActivityAt: now, readsAll: true, ...(lang && !pol?.lang ? { lang } : {}) });
      fb.onMemberMessage(m);
      scheduleSummary(m.chatId, g.repo().bumpPending(m.chatId), now);
      if ((g.repo().policy(m.chatId)?.chattiness ?? 'normal') !== 'quiet') {
        s.scheduler.schedule({ kind: 'group_chime', runAt: now + g.L().groupLullMs, refId: String(m.chatId), payload: { chatId: m.chatId }, dedupeKey: `gchime:${m.chatId}` });
      }
    } catch (e) {
      g.log().warn({ chatId: m.chatId, err: e instanceof Error ? e.name : 'error' }, 'groups: observe failed');
    }
  }

  /** Gora's own message in the group (an addressed reply or a chime-in): stored as kind 'bot' for the summary / catch-up. */
  function onBotMessage(p: { chatId: number; threadId: number | null; tgMessageId: number; text: string; at: Ms; chime?: { kind: GroupChimeKind } }): void {
    try {
      if (!g.readsAll()) return;
      const text = p.text.trim();
      if (!text) return;
      g.repo().insertMessage({
        chatId: p.chatId, tgMessageId: p.tgMessageId, threadId: p.threadId, fromTgId: s.telegram.botInfo.id, kind: 'bot', addressed: null,
        replyToTgMessageId: null, text: text.slice(0, g.L().groupMessageMaxChars), senderName: null, at: p.at, chimeKind: p.chime?.kind ?? null,
      });
      g.repo().bumpPending(p.chatId);
    } catch (e) {
      g.log().warn({ chatId: p.chatId, err: e instanceof Error ? e.name : 'error' }, 'groups: bot message not stored');
    }
  }

  return { observe, onBotMessage };
}
