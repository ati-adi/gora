// telegram/lanes.ts (WP2) — the lane of each update (01 §4.1, §10.1). The control lane `ctl` runs immediately and
// concurrently; every other lane is serial per key.
import type { Update } from 'grammy/types';

export const CONTROL_LANE = 'ctl';
/** pre_checkout_query never enters the inbox: it is answered inline in the webhook handler (§10.1). */
export const INLINE_KINDS: ReadonlySet<string> = new Set(['pre_checkout_query']);
const CONTROL_KINDS: ReadonlySet<string> = new Set([
  'callback_query', 'stopped_message_generation', 'pre_checkout_query', 'subscription', 'message_reaction', 'my_chat_member', 'business_connection',
  'chat_member', 'message_reaction_count', 'inline_query', 'chosen_inline_result', 'poll', 'poll_answer', 'managed_bot',
]);

/** The update's kind: its single payload key (e.g. 'message', 'callback_query'). */
export function kindOf(u: Update): string {
  for (const k of Object.keys(u)) if (k !== 'update_id') return k;
  return 'unknown';
}

interface MsgLike { chat?: { id: number; type?: string }; message_thread_id?: number; ephemeral_message_id?: number; business_connection_id?: string; guest_query_id?: string }

export function laneOf(u: Update): { kind: string; lane: string } {
  const kind = kindOf(u);
  if (CONTROL_KINDS.has(kind)) return { kind, lane: CONTROL_LANE };
  const rec = u as unknown as Record<string, unknown>;
  const m = rec[kind] as MsgLike | undefined;
  switch (kind) {
    case 'message':
    case 'edited_message': {
      const chat = m?.chat;
      if (!chat) return { kind, lane: CONTROL_LANE };
      // group /me with an ephemeral message: the acknowledgement runs on the control lane (§10.1)
      if (m?.ephemeral_message_id !== undefined) return { kind, lane: CONTROL_LANE };
      const thread = m?.message_thread_id ?? 0;
      if (chat.type === 'private') return { kind, lane: `dm:${chat.id}:${thread}` };
      return { kind, lane: `grp:${chat.id}:${thread}` };
    }
    case 'guest_message':
      return { kind, lane: `guest:${m?.guest_query_id ?? 'x'}` };
    case 'business_message':
    case 'edited_business_message':
      return { kind, lane: `biz:${m?.business_connection_id ?? 'x'}:${m?.chat?.id ?? 0}` };
    case 'deleted_business_messages': {
      const d = rec[kind] as { business_connection_id?: string; chat?: { id: number } } | undefined;
      return { kind, lane: `biz:${d?.business_connection_id ?? 'x'}:${d?.chat?.id ?? 0}` };
    }
    default:
      return { kind, lane: CONTROL_LANE };
  }
}
