// src/surfaces/location.ts (WP7a; friend mode 05 A5/A6) — location shares in the DM: the last point goes to
// location_state (WP5's LocationService, 1 h retention), a 👌 reaction acknowledges it, a default (guessed) zone is
// confirmed silently from the point, a confirmed zone that differs gets a proposal (travel), and the share becomes a
// location input for the model (coordinates rounded to ~100 m before they reach any provider).
import type { Location, Venue } from 'grammy/types';
import type { ChatRef, UserRow } from '../contracts/index.ts';
import { isValidTz, offsetMinutes } from '../kernel/timeMath.ts';
import type { Onboarding } from './onboarding.ts';
import { st } from './strings.ts';
import { dmConversation, errName, langOf, sendRich, utcOffsetLabel, type Surf } from './util.ts';

export const round3 = (x: number) => Math.round(x * 1000) / 1000;

export interface LocationHandlers {
  onShare(user: UserRow, loc: Location, chat: ChatRef & { messageId: number }, updateId: number): Promise<void>;
  onLiveEdit(user: UserRow, loc: Location): void;
  /**
   * A point that is NOT the owner's own position: a forwarded location/venue (`forwardedFrom` = forward label) or a venue
   * the owner picked. It becomes a conversation input only — never location_state, never a tz proposal. Forwards stay
   * untrusted (01 §11.2).
   */
  onPlace(user: UserRow, p: { location: Location; venue?: Venue; forwardedFrom: string | null }, chat: ChatRef & { messageId: number }, updateId: number): void;
}

export function createLocation(surf: Surf, ob: Onboarding): LocationHandlers {
  const { s } = surf;
  const reactTo = (user: UserRow, chat: ChatRef & { messageId: number }, updateId: number) => {
    try {
      s.telegram.outbox.enqueue({
        idempotencyKey: `locrx:${updateId}`, userId: user.id, chatId: chat.chatId, method: 'setMessageReaction', priority: 1,
        payload: { message_id: chat.messageId, reaction: [{ type: 'emoji', emoji: '👌' }] },
      });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'location: reaction failed');
    }
  };
  const store = (user: UserRow, loc: Location) => {
    try {
      s.location.set(user.id, { lat: loc.latitude, lon: loc.longitude, ...(loc.horizontal_accuracy ? { accuracyM: loc.horizontal_accuracy } : {}), ...(loc.live_period ? { livePeriodSec: loc.live_period } : {}) });
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'location: store failed');
    }
  };
  return {
    async onShare(user, loc, chat, updateId) {
      const lang = langOf(user);
      store(user, loc);
      const to = { chatId: chat.chatId, ...(chat.threadId ? { threadId: chat.threadId } : {}), userId: user.id };
      let tz: string | null = null;
      try {
        tz = s.caps.geo.tzForPoint(loc.latitude, loc.longitude);
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'location: tz lookup failed');
      }
      // Minimal UI (05 A5): a reaction instead of a text acknowledgement (the one-time location keyboard hides itself).
      reactTo(user, chat, updateId);
      const awaitingCity = ob.state(user.id).await === 'city';
      const valid = !!tz && isValidTz(tz);
      if (valid && (user.tzSource === 'default' || awaitingCity)) {
        // 05 A6: a shared location confirms the zone silently (an explicit "change my zone" flow gets one line).
        await ob.setTimezone(user, tz!, 'location');
        if (awaitingCity) {
          const offset = utcOffsetLabel(offsetMinutes(s.clock.now(), tz!));
          await sendRich(surf, to, st('tz_set', lang, { tz: tz!, offset }), { idem: `loctz:${updateId}` });
          return;
        }
      } else if (valid && tz !== user.tz) {
        // A confirmed zone that differs (travel): ask, never switch silently.
        await ob.proposeTz(user, { tz: tz!, source: 'location' }, chat, `loctz:${updateId}`);
      } else if (!valid && awaitingCity) {
        await sendRich(surf, to, st('tz_unknown_point', lang), { idem: `loctz:${updateId}` });
        return;
      }
      // The share is an answer (e.g. to location_request): it becomes an owner input.
      const conv = dmConversation(surf, user, chat.threadId);
      const acc = loc.horizontal_accuracy ? ` ±${Math.round(loc.horizontal_accuracy)} m` : '';
      const live = loc.live_period ? ' (live)' : '';
      s.repos.inputs.add({
        conversationId: conv.id, kind: 'location', author: 'owner', untrusted: false,
        content: [{ type: 'text', text: `[location shared${live}: ${round3(loc.latitude)}, ${round3(loc.longitude)}${acc}]` }],
        tgUpdateId: updateId, tgChatId: chat.chatId, tgMessageId: chat.messageId, fromTgUserId: user.tgUserId, replyToCardId: null,
      });
      s.runner.kick(conv.id);
    },
    onLiveEdit(user, loc) {
      store(user, loc);
    },
    onPlace(user, p, chat, updateId) {
      const conv = dmConversation(surf, user, chat.threadId);
      const clean = (x: string | undefined, n: number) => (x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
      const where = `${round3(p.location.latitude)}, ${round3(p.location.longitude)}`;
      const place = p.venue ? `${clean(p.venue.title, 128)}${p.venue.address ? ` — ${clean(p.venue.address, 200)}` : ''} (${where})` : where;
      const forwarded = p.forwardedFrom !== null;
      const text = forwarded ? `[${p.forwardedFrom}]\n[${p.venue ? 'place' : 'location'}: ${place}]` : `[place shared: ${place}]`;
      s.repos.inputs.add({
        conversationId: conv.id, kind: forwarded ? 'forward' : 'location', author: 'owner', untrusted: forwarded, content: [{ type: 'text', text }],
        tgUpdateId: updateId, tgChatId: chat.chatId, tgMessageId: chat.messageId, fromTgUserId: user.tgUserId, replyToCardId: null,
      });
      s.runner.kick(conv.id);
    },
  };
}
