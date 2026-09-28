// ── contracts/business.ts (WP0, frozen) — 01 §4.4
import type { BusinessConnection, BusinessMessagesDeleted, Message } from 'grammy/types';
import type { Ms, UserId } from './common.ts';

/** `priority` (WP0 addition): business_chats.priority (triage urgency 0..3, drives the unanswered_business signal, §8.4). */
export interface BizChatView { ref: string /* 'bc:<connId>:<chatId>' */; title: string; aiEnabled: boolean; mode: 'triage' | 'draft'; lastIncomingAt: Ms | null; unansweredSince: Ms | null; windowExpiresAt: Ms | null; priority: number }
export interface BusinessService {
  onConnection(bc: BusinessConnection): Promise<void>;
  onMessage(msg: Message, edited: boolean): Promise<void>;
  onDeleted(ev: BusinessMessagesDeleted): Promise<void>;
  setChatAi(userId: UserId, chatRef: string, enabled: boolean, via: 'callback' | 'miniapp'): Promise<void>;
  setDefault(userId: UserId, aiDefault: 'off' | 'new_chats', via: 'callback' | 'miniapp'): Promise<void>;
  listChats(userId: UserId, filter: 'unanswered' | 'all', limit: number): BizChatView[];
  readChat(userId: UserId, chatRef: string, limit: number): { transcript: string; peerName: string } | { error: 'not_consented' | 'not_found' };
  send(userId: UserId, chatRef: string, text: string, idemKey: string): Promise<{ messageId: number } | { error: 'window_closed' | 'no_rights' | 'disabled' | 'not_consented' }>;
  context(userId: UserId, chatRef: string): { connectionId: string; chatId: number; consented: boolean; enabled: boolean; canReply: boolean; windowOpen: boolean; windowExpiresAt: Ms | null } | null;
  // ── WP0 additions (Mini App Secretary, §5.5 biz_owner channel)
  connection(userId: UserId): { id: string; enabled: boolean; canReply: boolean; aiDefault: 'off' | 'new_chats'; connectedAt: Ms; consentTextVersion: string } | null;
  updateChat(userId: UserId, chatRef: string, patch: { mode?: 'triage' | 'draft'; toneNotes?: string | null }, via: 'callback' | 'miniapp'): Promise<void>;
  /** The biz_owner channel calls this when a drafting run ends without business_draft_reply ("no reply suggested" in the digest). */
  noteNoDraft(conversationId: string): Promise<void>;
}
