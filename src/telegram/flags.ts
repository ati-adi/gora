// telegram/flags.ts (WP2) — BotFlags from getMe (⚠U4) persisted in kv.bot_flags, the BotFather checklist (01 §4.5), and the
// ⚠U13 downgrade: when createForumTopic says "not a forum", topics are switched off (kv.bot_flags.topics=false) and every
// caller falls back to message prefixes. The downgrade is sticky for 24 h, then getMe's answer is trusted again.
import type { UserFromGetMe } from 'grammy/types';
import type { BotFlags, KvRepo, Logger } from '../contracts/index.ts';

export const TOPICS_DOWNGRADE_MS = 24 * 3600_000;
interface StoredFlags extends BotFlags { topicsDisabledAt?: number | null }

export function deriveFlags(me: UserFromGetMe): BotFlags {
  return {
    topics: me.has_topics_enabled === true,
    guest: me.supports_guest_queries === true,
    business: me.can_connect_to_business === true,
    mainWebApp: me.has_main_web_app === true,
    usersCanCreateTopics: me.allows_users_to_create_topics === true,
  };
}

/** Boot: getMe flags, minus a recent U13 downgrade; stored in kv; logs a checklist line for each false flag. */
export function loadFlags(me: UserFromGetMe, kv: KvRepo, log: Logger, now: number): BotFlags & { disableTopics(now: number): void } {
  const derived = deriveFlags(me);
  let stored: StoredFlags | undefined;
  try {
    stored = kv.get<StoredFlags>('bot_flags');
  } catch {
    stored = undefined;
  }
  const disabledAt = stored?.topicsDisabledAt ?? null;
  const flags: BotFlags = { ...derived };
  if (disabledAt !== null && now - disabledAt < TOPICS_DOWNGRADE_MS) flags.topics = false;
  const save = (topicsDisabledAt: number | null) => {
    try {
      kv.set('bot_flags', { ...flags, topicsDisabledAt } satisfies StoredFlags);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.name : 'error' }, 'could not store bot_flags');
    }
  };
  save(flags.topics ? null : disabledAt);
  for (const line of checklist(flags)) log.warn({ botfather: true }, line);
  log.info({ botfather: true, checklist: STATIC_CHECKLIST }, 'BotFather checklist (01 §4.5)');
  const live = flags as BotFlags & { disableTopics(now: number): void };
  Object.defineProperty(live, 'disableTopics', {
    enumerable: false,
    value: (at: number) => {
      if (!live.topics) return;
      live.topics = false;
      save(at);
      log.warn({ botfather: true }, 'createForumTopic failed with "not a forum": topics disabled for 24 h (⚠U13); turn ON Threaded Mode in @BotFather');
    },
  });
  return live;
}

/** 01 §4.5: the settings getMe cannot report, logged once at boot. */
export const STATIC_CHECKLIST: readonly string[] = Object.freeze([
  'Turn ON: Threaded Mode, "allow users to create topics", Guest Mode, Secretary Mode',
  'Main Mini App + domain = PUBLIC_URL; menu button set by the bot',
  'Stars payments need no provider token',
  'Inline mode OFF · Group Privacy ON · Bot-to-Bot Communication Mode OFF · Mini App origin protection ON',
]);

/** The BotFather checklist lines for the flags that are off (01 §4.5, ⚠U4). */
export function checklist(f: BotFlags): string[] {
  const out: string[] = [];
  if (!f.topics) out.push('BotFather checklist: turn ON "Threaded Mode" (topics in private chats) — missions and Inbox/Today topics fall back to prefixes');
  if (!f.usersCanCreateTopics) out.push('BotFather checklist: turn ON "allow users to create topics"');
  if (!f.guest) out.push('BotFather checklist: turn ON "Guest Mode" — @gora guest answers are unavailable');
  if (!f.business) out.push('BotFather checklist: turn ON "Secretary Mode" — Chat Automation is unavailable');
  if (!f.mainWebApp) out.push('BotFather checklist: set the Main Mini App and its domain to exactly PUBLIC_URL');
  return out;
}
