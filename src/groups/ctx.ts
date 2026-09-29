// groups/ctx.ts (GR) — the shared internal context of src/groups: lazy repo, logger, the C1 visibility check and the
// group's inferred time zone / language. Nothing here is exported outside src/groups.
import type { Logger, Services } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import type { LIMITS } from '../config.ts';
import { isValidTz } from '../kernel/timeMath.ts';
import type { GroupRepo } from './repo.ts';

export interface GroupCtx {
  s: Services;
  repo(): GroupRepo;
  log(): Logger;
  L(): typeof LIMITS;
  /** C1: privacy mode OFF (getMe().can_read_all_group_messages) and both group features on. */
  readsAll(): boolean;
  /** The group's IANA zone: the majority of known members' confirmed zones; null = unknown (then no chime-ins). */
  tzOf(chatId: number): string | null;
  /** 'ru' | 'en' — the chat's language (from what members write), default from the member who added Gora. */
  langOf(chatId: number): string;
}

const DAY = 86_400_000;

export function inferTz(g: Pick<GroupCtx, 's' | 'repo' | 'L'>, chatId: number): string | null {
  const now = g.s.clock.now();
  const counts = new Map<string, number>();
  for (const tgId of g.repo().members(chatId, now - g.L().groupMessageRetentionDays * DAY)) {
    const u = g.s.repos.users.getByTg(tgId);
    if (!u || u.tzSource === 'default' || !isValidTz(u.tz)) continue;
    counts.set(u.tz, (counts.get(u.tz) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  // deterministic tie-break: the most members, then the zone name
  for (const [tz, c] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (c > n) {
      best = tz;
      n = c;
    }
  }
  if (best) return best;
  const stored = g.repo().policy(chatId)?.tz ?? null;
  return stored && isValidTz(stored) ? stored : null;
}

/** 'ru' when the text is mostly Cyrillic, 'en' when mostly Latin, null when it has too few letters to tell. */
export function scriptLang(text: string): 'ru' | 'en' | null {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyr + lat < 4) return null;
  return cyr >= lat ? 'ru' : 'en';
}

export const langOrDefault = (lang: string | null | undefined): string => uiLang(lang ?? 'en');
