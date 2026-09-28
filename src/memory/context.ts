// memory/context.ts (WP6a; friend mode, spec 05 B3/B4) — the memory part of the context row (01 §5.9, §9 "Retrieval").
// The scope comes from the surface: DM / topic / mission → the owner's `<user_model>` block (the profile card head
// ≤ LIMITS.profileMaxTokens, then the best hybrid-ranked facts; on Groq the facts fit ≤ LIMITS.userModelMaxTokens);
// group → that group's facts only (`memories`); biz_draft → the owner's facts, top 8 (`memories`, no card); guest → none.
// Nothing at all while memory is off or incognito (memoryEnabled). Facts keep their ids (memory_forget, /why).
import type { ContextPart, ContextProvider } from '../contracts/agent.ts';
import type { Ms, Scope } from '../contracts/common.ts';
import type { ProfileCard } from '../contracts/memory.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import type { ConversationRow } from '../contracts/storage.ts';
import type { Services } from '../contracts/services.ts';
import { LIMITS } from '../config.ts';
import { errorMessage } from '../kernel/errors.ts';
import { neutralizeReservedTags } from '../kernel/tags.ts';
import { estimateTokens } from '../kernel/tokens.ts';
import { cardTexts, filterCard, liveContext } from './consolidate.ts';
import type { MemoryStore } from './store.ts';

export const BIZ_DRAFT_FACTS = 8;

export function memoryScopeOf(conv: ConversationRow): Scope | null {
  if (conv.kind === 'group') return conv.tgChatId !== null ? { kind: 'group', chatId: conv.tgChatId } : null;
  if (conv.kind === 'guest') return null;
  return conv.userId ? { kind: 'user', userId: conv.userId } : null;
}

const flat = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * The profile card as `<user_model>` head lines, most important first, trimmed (items from the end of each line, then
 * whole lines from the end) to `maxTokens`.
 */
export function profileHeadLines(card: ProfileCard, o: { tz: string; now: Ms; maxTokens: number }): string[] {
  const groups: Array<{ label: string; items: string[]; sep: string }> = [
    { label: 'about', items: card.summary ? [flat(card.summary)] : [], sep: ' ' },
    { label: 'people', items: card.people.map((p) => flat(`${p.name}${p.relation ? ` (${p.relation})` : ''}${p.notes ? `: ${p.notes}` : ''}`)), sep: '; ' },
    { label: 'now', items: liveContext(card, o.tz, o.now).map((x) => flat(`${x.text}${x.expires_local ? ` (until ${x.expires_local})` : ''}`)), sep: '; ' },
    {
      label: 'open threads',
      items: card.open_threads.map((t) => flat(`${t.what}${t.when_local ? ` (${t.when_local})` : ''}${t.follow_up_after_local ? ` [ask after ${t.follow_up_after_local}]` : ''}`)),
      sep: '; ',
    },
    { label: 'goals', items: card.goals.map(flat), sep: '; ' },
    { label: 'preferences', items: card.preferences.map(flat), sep: '; ' },
  ];
  const render = () => groups.filter((g) => g.items.length).map((g) => `${g.label}: ${g.items.join(g.sep)}`);
  const cost = (ls: string[]) => ls.reduce((n, l) => n + estimateTokens(l) + 2, 0);
  let lines = render();
  // trim from the least important group (the end) backwards, one item at a time
  for (let gi = groups.length - 1; gi >= 0 && cost(lines) > o.maxTokens; gi--) {
    const g = groups[gi]!;
    while (g.items.length && cost(lines) > o.maxTokens) {
      if (g.items.length === 1 && g.label === 'about') g.items[0] = g.items[0]!.split(' ').slice(0, -8).join(' ');
      else g.items.pop();
      if (g.items[0] === '') g.items.length = 0;
      lines = render();
    }
  }
  return lines;
}

export function createMemoryContext(s: Services, store: MemoryStore): ContextProvider {
  const log = () => s.log.child({ mod: 'memory' });
  return {
    name: 'memory',
    surfaces: ['dm', 'topic', 'mission', 'group', 'biz_draft'],
    async parts(conv, run, query): Promise<ContextPart[]> {
      const scope = memoryScopeOf(conv);
      if (!scope) return [];
      const now = s.clock.now();
      const factLine = (h: { id: string; kind: string; text: string; sourceLabel: string }) => neutralizeReservedTags(`- [${h.id}] (${h.kind}) ${h.text.replace(/\s+/g, ' ')} — ${h.sourceLabel}`);
      if (scope.kind === 'group') {
        const hits = await store.retrieve(scope, query, run?.id ?? null);
        return hits.length ? [{ key: 'memories', lines: hits.map(factLine) }] : [];
      }
      const u = s.repos.users.getById(scope.userId);
      if (!u || !memoryEnabled(u, now)) return [];
      if (conv.kind === 'biz_draft') {
        const hits = await store.retrieve(scope, query, run?.id ?? null, { limit: BIZ_DRAFT_FACTS });
        return hits.length ? [{ key: 'memories', lines: hits.map(factLine) }] : [];
      }
      let head: string[] = [];
      try {
        const view = s.userProfile?.get(scope.userId) ?? null;
        if (view) {
          // defense in depth: a forgotten fact's text never reaches a prompt, even from a card written before the forget
          const texts = cardTexts(view.card);
          const ok = new Set(store.filterFingerprinted(scope, texts));
          const card = filterCard(view.card, (t) => ok.has(t));
          head = profileHeadLines(card, { tz: u.tz, now, maxTokens: LIMITS.profileMaxTokens }).map((l) => neutralizeReservedTags(l));
        }
      } catch (e) {
        log().warn({ err: errorMessage(e) }, 'profile card unavailable for context');
      }
      const hits = await store.retrieve(scope, query, run?.id ?? null, { hasCard: head.length > 0 });
      const lines = [...head, ...hits.map(factLine)];
      return lines.length ? [{ key: 'user_model', lines }] : [];
    },
  };
}
