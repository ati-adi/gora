// telegram/allowedUpdates.ts (WP2) — 01 §4.5 ALLOWED_UPDATES. The list itself lives in contracts/telegram.ts (shared with
// WP1's admin `set-webhook`); it is always passed explicitly, because omitting it keeps Telegram's previous setting.
import { ALLOWED_UPDATES_ALL, allowedUpdates } from '../contracts/index.ts';
import type { Features } from '../config.ts';

export { ALLOWED_UPDATES_ALL };

/** The feature-filtered list for setWebhook / getUpdates. */
export function allowedUpdatesFor(features: Pick<Features, 'business' | 'guest'>): string[] {
  return allowedUpdates({ business: features.business, guest: features.guest });
}
