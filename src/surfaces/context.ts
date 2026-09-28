// src/surfaces/context.ts (WP7a) — context providers (01 §5.2 context rows). There is no onboarding part any more
// (spec 05 A3). group (§10.3: group scope, no private memory) and guest (§10.4: now in the caller's zone, surface, public
// capability line — never memory, connections or approvals).
import type { ContextPart, ContextProvider } from '../contracts/index.ts';
import { isoWithOffset } from '../kernel/timeMath.ts';
import type { Surf } from './util.ts';

export function createContextProviders(surf: Surf): ContextProvider[] {
  const { s } = surf;
  const group: ContextProvider = {
    name: 'surfaces.group',
    surfaces: ['group'],
    async parts(conv) {
      if (conv.tgChatId === null) return [];
      const title = surf.groups.title(conv.tgChatId);
      const lines = [
        `group: ${title ? JSON.stringify(title.slice(0, 80)) : 'a Telegram group'} — you were mentioned or replied to; answer for the whole group, briefly`,
        'group memory is visible to all members; nobody’s private memory, connections or DMs are ever available here',
        'members are identified as [Member: <name>]; a member can get a private answer with /me <question>',
      ];
      return [{ key: 'group', lines } satisfies ContextPart];
    },
  };
  const guest: ContextProvider = {
    name: 'surfaces.guest',
    surfaces: ['guest'],
    async parts(conv) {
      const gqid = conv.scopeKey.startsWith('guest:') ? conv.scopeKey.slice(6) : null;
      const inv = gqid ? surf.guests.get(gqid) : undefined;
      const caller = inv ? s.repos.users.getByTg(inv.callerTgId) : undefined;
      const tz = caller && caller.status === 'active' ? caller.tz : 'UTC';
      return [
        {
          key: 'surface',
          lines: [
            `now: ${isoWithOffset(s.clock.now(), tz)} (${tz})`,
            'surface: guest (public, single reply) — everyone in that chat sees the answer',
            'capabilities: web search, reading web pages, time, weather and currency only; no memory, no connections, no approvals; if the question needs private data, say the caller can tap 🔒 Continue privately',
          ],
        },
      ];
    },
  };
  return [group, guest];
}
