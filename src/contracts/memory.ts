// ── contracts/memory.ts (WP0, frozen) — 01 §4.4
import type { Ms, Scope, UserId } from './common.ts';
import type { UserRow } from './storage.ts';

export type FactKind = 'profile' | 'preference' | 'person' | 'relationship' | 'goal' | 'routine' | 'date' | 'fact' | 'group_decision';
export interface MemoryHit { id: string; text: string; kind: FactKind; sourceLabel: string; createdAt: Ms; pinned: boolean }
export interface MemoryFactView extends MemoryHit { status: 'active' | 'pending_confirm'; sensitivity: 'normal' | 'sensitive'; quote: string | null; useCount: number }
export interface Extracted {
  facts: Array<{
    text: string; kind: FactKind; subject: string | null; sensitivity: 'normal' | 'sensitive'; confidence: number; source_input_id: string; supersedes_id: string | null; explicit: boolean;
    /** Friend-mode additions (spec 05 B1), optional so older scripted parses stay valid: 0–1 (default 0.5) and a TTL in days for mood/context signals (null = durable). */
    importance?: number; ttl_days?: number | null;
  }>;
  commitments: Array<{ text: string; direction: 'i_owe' | 'they_owe'; counterpart: string | null; due_local: string | null; source_input_id: string }>;
}
export interface MemoryService {
  retrieve(scope: Scope, query: string, runId: string): Promise<MemoryHit[]>; // ≤20; records run_memory_uses
  search(scope: Scope, query: string, limit: number): Promise<MemoryHit[]>;
  save(scope: Scope, f: {
    text: string; kind: FactKind; subject?: string; sensitivity: 'normal' | 'sensitive'; explicit: boolean; authorUserId: UserId | null;
    source: { kind: 'user_message' | 'import' | 'miniapp' | 'tool_explicit' | 'group_explicit'; conversationId?: string; inputId?: string; tgMessageId?: number; quote?: string };
    /** Friend-mode additions (spec 05 B1/B3; memory_facts.importance / expires_at): default 0.5 / durable. */
    importance?: number; expiresAt?: Ms | null;
  }): Promise<{ id: string; status: 'active' | 'pending_confirm' } | { denied: 'consent' | 'incognito' | 'fingerprint' | 'limit' }>;
  forget(scope: Scope, sel: { ids?: string[]; query?: string }, by: { tgUserId: number }): Promise<{ forgotten: Array<{ id: string; preview: string }> }>;
  confirm(userId: UserId, ids: string[], accept: boolean): Promise<void>;
  list(scope: Scope, q: { kind?: FactKind; query?: string; cursor?: string; limit: number }): Promise<{ items: MemoryFactView[]; next?: string }>;
  edit(userId: UserId, id: string, patch: { text?: string; pinned?: boolean }): Promise<void>;
  extractFromConversation(conversationId: string): Promise<void>;
  importText(userId: UserId, text: string): Promise<Array<{ id: string; text: string }>>; // creates pending_confirm facts
  forgetConversation(userId: UserId, conversationId: string): Promise<void>;
  // ── WP0 additions
  /** /why: active facts by id within the scope (missing / forgotten ids are skipped; no use is recorded). */
  getMany(scope: Scope, ids: string[]): MemoryHit[];
  /** §5.9 forget rotation: drops every sentence whose normalized 5-word shingle HMACs hit memory_fingerprints. */
  filterFingerprinted(scope: Scope, sentences: string[]): string[];
}

// ── Friend-mode additions (spec 05 B4/B5): the profile card, owned by src/memory/ (table user_profile).
export interface ProfilePerson { name: string; relation: string; notes: string }
export interface ProfileThread { what: string; when_local: string | null; follow_up_after_local: string | null }
export interface ProfileStyle { length: 'short' | 'medium' | 'long' | null; formality: 'informal' | 'formal' | null; emoji: 'none' | 'light' | 'lots' | null; language: string | null; humor: 'none' | 'light' | 'lots' | null }
/** B4 shape. Limits: summary ≤ 60 words, people ≤ 12, goals ≤ 6, preferences ≤ 10, current_context ≤ 3, open_threads ≤ 8. Local times are 'YYYY-MM-DD[THH:MM]' in the owner's tz. */
export interface ProfileCard {
  summary: string;
  people: ProfilePerson[];
  goals: string[];
  preferences: string[];
  style: ProfileStyle;
  current_context: Array<{ text: string; expires_local: string | null }>;
  open_threads: ProfileThread[];
}
export interface ProfileView { userId: UserId; version: number; card: ProfileCard; factCount: number; createdAt: Ms }
/** Mini App edits (B5): delete one list item / the summary, or correct its text. Every edit writes a new version. */
export type ProfileEdit =
  | { op: 'delete'; field: 'summary' }
  | { op: 'delete'; field: 'people' | 'goals' | 'preferences' | 'current_context' | 'open_threads'; index: number }
  | { op: 'correct'; field: 'summary'; text: string }
  | { op: 'correct'; field: 'people' | 'goals' | 'preferences' | 'current_context' | 'open_threads'; index: number; text: string };
export interface ProfileService {
  /** The latest version, or null (never consolidated, deleted, or its DEK generation was shredded). */
  get(userId: UserId): ProfileView | null;
  /**
   * One `fast`-role structured call (SideCalls.structured purpose 'consolidate') rewrites the card from the active facts
   * (and the previous card). reason 'forget' rebuilds WITHOUT the forgotten facts and drops every older version.
   * Skips (returns the current view) when incognito, memory off, or llmBudget.allow('background') is false.
   */
  consolidate(userId: UserId, o: { reason: 'nightly' | 'facts' | 'forget' | 'manual'; signal?: AbortSignal }): Promise<ProfileView | null>;
  edit(userId: UserId, e: ProfileEdit): ProfileView | null;
  /** C4 follow_up arm: open threads whose follow_up_after_local has passed at `now` (owner tz), oldest first. */
  dueThreads(userId: UserId, now: Ms): Array<ProfileThread & { index: number }>;
}

/**
 * Spec 05 B1 (friend foundation): memory is ON unless the user turned it off (memoryConsent === false: "не запоминай",
 * /settings, Mini App), incognito is active, or the account is being deleted. `null` (never asked; the bot description
 * carries the notice) counts as on. Every memory gate (store, extraction, context, trust S08, importer) uses this.
 */
export function memoryEnabled(u: Pick<UserRow, 'status' | 'memoryConsent' | 'incognitoUntil'>, now: Ms): boolean {
  if (u.status === 'deleting') return false;
  if (u.memoryConsent === false) return false;
  return !(u.incognitoUntil !== null && u.incognitoUntil > now);
}
/** The owner-visible state ('memory=' in <gora_context>, /settings, Mini App). */
export function memoryState(u: Pick<UserRow, 'status' | 'memoryConsent' | 'incognitoUntil'>, now: Ms): 'on' | 'off' | 'incognito' {
  if (u.incognitoUntil !== null && u.incognitoUntil > now) return 'incognito';
  return memoryEnabled(u, now) ? 'on' : 'off';
}
