// ── contracts/groups.ts (s07 foundation, spec 07 §C) — Gora as a real participant in group chats.
// Owned by src/groups/ (the GR set; tables group_messages, group_summaries, group_policy). The Telegram group surface
// (src/surfaces/group.ts, edited by GR) feeds every group message into `observe`; the always-answer path (mention,
// reply, name-address, command) keeps using the group conversation (GROUP toolset). Unprompted chime-ins go through the
// local heuristic → fast judge → main compose pipeline and the per-group Thompson bandit.
//
// Isolation (C3, canary): group data never enters a DM/topic/mission request and DM data never enters a group request.
// Group text is always untrusted (`group_member` taint) and stored only encrypted under the group DEK 'g:<chatId>'
// (owner 'grp:<chatId>', so destroyOwner covers it).
import type { Ms } from './common.ts';

/** C4 judge output kinds = bandit arms. */
export type GroupChimeKind = 'answer' | 'fact_check' | 'plan_help' | 'summary' | 'fun';
export const GROUP_CHIME_KINDS: readonly GroupChimeKind[] = ['answer', 'fact_check', 'plan_help', 'summary', 'fun'];

/** C4 per-group chattiness, set by words ("Гора, тише" → less/quiet; "можешь чаще" → more). 'quiet' = mention-only. */
export type GroupChattiness = 'quiet' | 'less' | 'normal' | 'more';
export const GROUP_CHATTINESS: readonly GroupChattiness[] = ['quiet', 'less', 'normal', 'more'];

/** How a message addressed Gora (null = not addressed; it is stored but never answered directly). */
export type GroupAddress = 'mention' | 'reply' | 'name' | 'command' | null;

/** One group message as the surface hands it to GroupParticipation.observe. `text` is member-authored (untrusted). */
export interface GroupObservedMessage {
  chatId: number;
  threadId: number | null;
  tgMessageId: number;
  fromTgId: number;
  fromName: string;
  fromLang?: string;
  /** Text, caption, or a voice-note transcript (GR decides whether to transcribe; STT counts as background work). */
  text: string;
  kind: 'text' | 'caption' | 'voice';
  at: Ms;
  replyToTgMessageId: number | null;
  /** The replied-to message is Gora's own (a reply engaging Gora: C4 reward signal). */
  replyToBot: boolean;
  addressed: GroupAddress;
}

export interface GroupPolicyView {
  chatId: number;
  chattiness: GroupChattiness;
  /** Heuristic score threshold currently in force (derived from chattiness + learning). */
  threshold: number;
  /** Beta posterior per kind. */
  arms: Record<GroupChimeKind, { alpha: number; beta: number }>;
  lastChimeAt: Ms | null;
  chimesToday: number;
  /** Inferred IANA zone of the group (majority of members' tz, or group memory), null = unknown (then no chime-ins at 22–09 UTC+member-default). */
  tz: string | null;
  /** C1: whether the bot can read all group messages (privacy mode OFF), as last observed. */
  readsAll: boolean;
}

/**
 * `s.groupAgent` (src/groups/index.ts createGroupModule). Every method is safe to call when the feature is off or the
 * bot cannot read all messages: it degrades to the 01 F14 mention-only behaviour and does nothing.
 */
export interface GroupParticipation {
  /**
   * C1: `s.telegram.botInfo.can_read_all_group_messages && config.features.groupParticipant`. When false the surface
   * keeps mention-only behaviour and nothing is stored; the BotFather step (/setprivacy → Disable, then re-add the
   * bot) is logged once at boot.
   */
  readsAll(): boolean;
  /** C2: the ONE join line in the group's language (no buttons), idempotent per (chat, join update). */
  onJoin(chatId: number, o: { lang?: string; idem: string }): Promise<void>;
  /** C3/C4: store encrypted (14-day rolling retention), bump the summary batch, (re)schedule the 45 s lull check. Never throws. */
  observe(m: GroupObservedMessage): Promise<void>;
  /**
   * s07 lead addition (red team "group edits ignored"): a member edited a stored message (reads-all mode). The stored
   * text is replaced (deleted when the edit leaves nothing); a summary that already folded the old text is dropped (the
   * next batch rebuilds it from newer lines). Never throws.
   */
  onEdited(p: { chatId: number; tgMessageId: number; fromTgId: number; text: string; at: Ms }): Promise<void>;
  /** C4 learning: a member's reaction on a group message (reward when it is on Gora's chime-in, penalty when negative). */
  onReaction(p: { chatId: number; tgMessageId: number; fromTgId: number; emoji: readonly string[]; at: Ms }): void;
  /** Called after Gora's own message was sent in the group (store as kind 'bot'; open the 10-min reward window for chime-ins). */
  onBotMessage(p: { chatId: number; threadId: number | null; tgMessageId: number; text: string; at: Ms; chime?: { kind: GroupChimeKind } }): void;
  /** C4 by words: "Гора, тише" / "можешь чаще". Returns the new level. */
  setChattiness(chatId: number, level: GroupChattiness, o?: { reason?: 'words' | 'settings' }): GroupChattiness;
  /** Name-address detection ("Гора, …", "Gora, …", "гора ты тут?"): the surface treats it like a mention. Pure, cheap. */
  addressedByName(text: string): boolean;
  /** Parses a chattiness command addressed to Gora ("тише", "не лезь", "замолчи", "можешь чаще", "активнее"), else null. */
  chattinessFromWords(text: string): GroupChattiness | 'quieter' | 'louder' | null;
  /**
   * C5: "что я пропустил?" / /catchup — a short summary of what happened since `forTgId`'s last message in this chat
   * (stored messages + the rolling summary). null = nothing to report. Uses a fast side call at priority 'interactive'.
   */
  catchup(chatId: number, forTgId: number, o: { lang?: string; threadId?: number | null }): Promise<string | null>;
  policy(chatId: number): GroupPolicyView;
  /**
   * C3 deletion: 'forget' (/forget all|всё in the group: messages + summary + policy counters; facts via memory.forget),
   * 'left' (the 7-day grace after the bot left has passed). Iterates GROUP_DATA_TABLES.
   */
  purge(chatId: number, reason: 'forget' | 'left'): Promise<void>;
  /**
   * s07 lead addition (GR-1): the recent group lines (+ the rolling summary) for an addressed reply, as ONE raw text the
   * surface hands to the run as untrusted member content (never system context). null when nothing is stored or reading
   * is off. The surface never persists it beyond the run's retention (see surfaces/group.ts).
   */
  recentContext(chatId: number, o: { excludeTgMessageId?: number; threadId?: number | null }): string | null;
}

/** Factory return shape (src/groups/index.ts). */
export interface GroupModule { participation: GroupParticipation }
