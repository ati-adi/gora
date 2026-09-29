// groups/catchup.ts (GR, spec 07 C5) — "что я пропустил?" / /catchup: what happened since the asking member's last
// message (stored messages, capped; the rolling summary covers anything older than the cap), summarised by a fast side
// call at priority 'interactive' into ≤ 8 lines. The surface delivers it privately (ephemeral reply, else the DM).
// The member's own lines are not repeated back to them.
import type { GroupCtx } from './ctx.ts';
import { catchupFallback } from './strings.ts';
import { CATCHUP_SYSTEM, CatchupSchema, catchupUser, transcript, withSummary } from './prompts.ts';

const CAP = 150;
/**
 * A member with no stored message of their own gets only the last hour (s07 lead fix, red team: a just-added member of
 * a group that hides its history from new members must not receive a day of it through Gora).
 */
const DEFAULT_LOOKBACK_MS = 3_600_000;

export function createCatchup(g: GroupCtx) {
  const { s } = g;
  return async function catchup(chatId: number, forTgId: number, o: { lang?: string; threadId?: number | null }): Promise<string | null> {
    if (!g.readsAll()) return null;
    const now = s.clock.now();
    // The surface asks before storing the request itself, so the member's latest stored line is the previous one.
    const last = g.repo().lastOf(chatId, forTgId, now + 1);
    const since = last?.at ?? now - DEFAULT_LOOKBACK_MS;
    const win = g.repo().catchupWindow(chatId, {
      sinceAt: since, ...(last ? { afterId: last.tgMessageId } : {}), exceptTgId: forTgId, untilAt: now, ...(o.threadId ? { threadId: o.threadId } : {}), limit: CAP,
    });
    const msgs = win.msgs;
    if (!msgs.length) return null;
    const sum = g.repo().summary(chatId);
    const olderCut = win.total > msgs.length;
    const lang = o.lang ?? g.langOf(chatId);
    const names = [...new Set(msgs.filter((m) => m.kind !== 'bot').map((m) => (m.senderName ?? '').trim()).filter(Boolean))];
    try {
      const text = withSummary(olderCut ? (sum?.summary ?? null) : null, transcript(msgs, { tz: g.tzOf(chatId), maxCharsPerLine: 300 }));
      const wrapped = await s.untrusted.wrap({ source: 'group_member', label: 'group chat', text, priority: 'interactive' });
      const r = await s.side.structured(
        { purpose: 'group_catchup', role: 'fast', system: CATCHUP_SYSTEM, user: catchupUser({ wrapped: wrapped.text, lang }), schema: CatchupSchema, maxTokens: 500 },
        { priority: 'interactive' },
      );
      const lines = (r?.lines ?? []).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 8);
      if (lines.length) return lines.map((l) => `• ${l}`).join('\n');
    } catch (e) {
      g.log().warn({ chatId, err: e instanceof Error ? e.name : 'error' }, 'groups: catch-up call failed');
    }
    return catchupFallback(lang, msgs.length, names);
  };
}
