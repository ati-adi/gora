// ── contracts/tools.ts (WP0, frozen) — 01 §4.4 + 03 R3
import type { InlineKeyboardButton } from 'grammy/types';
import type { ZodType } from 'zod';
import type { Logger, Ms, Scope, Surface, TaintSource, ToolsetId, UserId } from './common.ts';
import type { BetaToolUnion, Priority } from './llm.ts';
import type { QuotaKind } from './billing.ts';
import type { LedgerEntry } from './ledger.ts';
import type { Services } from './services.ts';

export type ActionClass = 'read_public' | 'read_private' | 'write_self' | 'send_external' | 'destructive' | 'spend' | 'account_admin' | 'ui' | 'control' | 'compute' | 'memory';
export interface Target { kind: 'email' | 'gcal_attendee' | 'tg_chat' | 'biz_chat'; value: string; hmac: string; provenance: 'user' | 'memory' | 'approved' | 'business_chat' | 'untrusted' | 'unknown'; sourceLabel?: string }
export interface Classification {
  actionClass: ActionClass; risk: 0 | 1 | 2 | 3 | 4; integration?: 'gmail' | 'gcal' | 'business'; requiredLevel?: 'read' | 'draft' | 'act';
  quotaKind?: QuotaKind; bulkCount?: number; grantable?: boolean; businessRef?: { connectionId: string; chatId: number };
}
export interface ApprovalDiff { title: string; summary: string; rows: Array<[string, string]>; body?: { label: string; text: string }; warnings: string[]; targets: Target[] }
export type Effect =
  | { kind: 'line'; markdown: string; undoId?: string } // DB-rendered footer line (+ optional Undo)
  | { kind: 'buttons'; rows: InlineKeyboardButton[][] }
  | { kind: 'venue'; lat: number; lon: number; title: string; address: string }
  | { kind: 'document'; bytes: Uint8Array; filename: string; mime: string }
  | { kind: 'photo'; bytes: Uint8Array; filename: string }
  | { kind: 'todo_list'; scope: Scope }
  | { kind: 'location_request'; text: string };
export interface ToolCtx {
  toolUseId: string; runId: string; conversationId: string; epoch: number; userId: UserId | null; tgUserId: number | null;
  surface: Surface; scope: Scope | null; tz: string; lang: string; now: Ms;
  chat: { chatId: number; threadId?: number; triggerMessageId?: number; businessConnectionId?: string };
  missionId?: string; taint: ReadonlySet<TaintSource>; signal: AbortSignal; effects: { push(e: Effect): void };
  services: Services; log: Logger;
  idemKey: string; /* toolUseId, or 'pa:<id>' when executing an approval */
  /**
   * s07 lead addition: set ONLY by the executor's approval path (executeApproved) — the owner approved this very call.
   * Tools must use this, never `idemKey.startsWith('pa:')` (the idemKey of a normal call is the provider's tool_use id).
   */
  approvedAction?: { pendingActionId: string };
  /** 03 R6 (WP0 addition): priority for capability calls made by this tool ('interactive' for user-input runs, 'approval' when executing an approval, else 'background'). */
  priority: Priority;
}
export interface ToolOutput<O = unknown> {
  content: string; data?: O; isError?: boolean; untrusted?: { source: TaintSource; label: string };
  undo?: { payload: unknown; line: string }; effects?: Effect[]; ledger?: Array<Omit<LedgerEntry, 'userId' | 'actor'>>;
}
export interface ToolSpec<I = any, O = unknown> {
  name: string; description: string /* says WHEN to call */; input: ZodType<I>; surfaces: readonly Surface[];
  eagerInput?: boolean; parallelSafe: boolean; outputTaint?: TaintSource;
  classify(input: I, ctx: ToolCtx): Classification;
  targets?(input: I, ctx: ToolCtx): Promise<Target[]>;
  renderDiff?(input: I, ctx: ToolCtx): Promise<ApprovalDiff>; // REQUIRED if the tool can be asked; recomputed at execution (TOCTOU)
  statusLabel(input: I, lang: string): string;
  execute(input: I, ctx: ToolCtx): Promise<ToolOutput<O>>; // MUST be idempotent per ctx.idemKey
  reconcile?(input: I, ctx: ToolCtx): Promise<'done' | 'not_done' | 'unknown'>;
  undo?(payload: unknown, ctx: ToolCtx): Promise<void>;
  /**
   * WP0 addition (§5.6, §10.2): approval placement for tools that can be asked. The executor (WP4) calls it before
   * `approvals.create` and uses each returned field instead of its default:
   *  - `card`: where the card goes (default: the run's chat/thread; business_draft_reply → the owner's 📥 Inbox topic);
   *  - `expiresAt`: card expiry (default: DM `approval_expiry_min`, missions min(deadline, 7 d); business → window_expires_at);
   *  - `sourceRefs`: stored in pending_actions.source_refs_json for `approvals.voidBySourceRef` (e.g. 'bizmsg:<conn>:<chat>:<ids>').
   */
  approvalMeta?(input: I, ctx: ToolCtx): Promise<{ card?: { chatId: number; threadId?: number }; expiresAt?: Ms; sourceRefs?: string[] }>;
  /**
   * s07 addition (spec 07 A4, BR): a picture shown with the approval card — the browser submit card carries a screenshot
   * of the page. The executor (trust/executor.ts, edited by BR) calls it after `approvals.create` and sends the photo
   * into the card's chat/thread right before the card (outbox sendPhoto via a user-owned blob, idempotency
   * 'pa_photo:<pendingActionId>'). It is NOT part of the ApprovalDiff (the diff is sealed and HMAC-compared at execution;
   * a screenshot is never stable). Errors are logged and the card is sent without the picture.
   */
  approvalAttachment?(input: I, ctx: ToolCtx): Promise<{ kind: 'photo'; bytes: Uint8Array; caption?: string } | null>;
}

/** 03 R3: named toolkits over FULL (request building only; `core` is always loaded). */
/** s07 addition: 'browser' (spec 07 A2: browse_task for the chat run + the browser_* tools of a browse mission). */
export type ToolkitId = 'core' | 'web' | 'calendar' | 'email' | 'missions' | 'secretary' | 'files' | 'account' | 'browser';
export const TOOLKIT_IDS: readonly ToolkitId[] = ['core', 'web', 'calendar', 'email', 'missions', 'secretary', 'files', 'account', 'browser'];
export interface ToolDefinitions { definitions: readonly BetaToolUnion[]; hash: string; names: ReadonlySet<string> }
/**
 * The registry (WP5, tools/registry.ts) is built by `createToolRegistry(profile, external)`:
 *  - WP5's own specs (tools/impl/*, plus the profile-dependent web tools of 03 R4) are imported by tools/index.ts;
 *  - every other WP exports `TOOLS: readonly ToolSpec[]` from its tools.ts (see TOOL_FILES), and app.ts passes their
 *    concatenation as `external`;
 *  - a duplicate name (internal or external) throws at build time.
 */
export interface ToolRegistry {
  get(name: string): ToolSpec | undefined;
  all(): readonly ToolSpec[];
  toolset(id: ToolsetId): ToolDefinitions;
  /** 03 R3 (WP0 addition): toolkit membership (tool names per toolkit, over FULL). */
  toolkits(): Readonly<Record<ToolkitId, readonly string[]>>;
  /** 03 R3 (WP0 addition): definitions for `toolset` restricted to the union of `kits` (always including core), name-sorted, hashed.
   *  For GROUP/GUEST/BIZ the whole toolset is returned regardless of `kits`. */
  subset(id: ToolsetId, kits: readonly ToolkitId[]): ToolDefinitions;
}

/** WP0 addition: which work package implements each tool of the 01 §6 catalog (+ `use_toolkit`, 03 R3). */
/** s07 additions: 'BR' (src/browser/tools.ts) and 'GR' (src/groups/tools.ts), the spec 07 builder sets (docs/spec/08-s07-plan.md). */
export type ToolOwner = 'WP4' | 'WP5' | 'WP6a' | 'WP6b' | 'WP7a' | 'WP7b' | 'BR' | 'GR';
export const TOOL_OWNERS: Readonly<Record<string, ToolOwner>> = Object.freeze({
  // WP4 — src/trust/tools.ts (task_wait lives with the executor, which owns its park semantics, §5.6)
  revise_pending_action: 'WP4', task_wait: 'WP4',
  // WP5 — src/tools/impl/* (web_search/web_fetch: server tools on anthropic via tools/serverTools.ts, client tools on groq via tools/impl/web.ts)
  web_search: 'WP5', web_fetch: 'WP5',
  calendar_create_event: 'WP5', calendar_delete_event: 'WP5', calendar_find_free_slots: 'WP5', calendar_list_events: 'WP5', calendar_respond_invite: 'WP5', calendar_update_event: 'WP5',
  gmail_create_draft: 'WP5', gmail_read_thread: 'WP5', gmail_search: 'WP5', gmail_send_draft: 'WP5',
  fx_convert: 'WP5', integration_connect: 'WP5', ledger_query: 'WP5', location_request: 'WP5', make_file: 'WP5', offer_choices: 'WP5',
  react: 'WP5', settings_update: 'WP5', share_place: 'WP5', time_resolve: 'WP5', weather_get: 'WP5', use_toolkit: 'WP5',
  // WP6a — src/memory/tools.ts, src/reminders/tools.ts
  memory_forget: 'WP6a', memory_save: 'WP6a', memory_search: 'WP6a',
  reminder_create: 'WP6a', reminder_list: 'WP6a', reminder_manage: 'WP6a', todo_manage: 'WP6a',
  // WP6b — src/missions/tools.ts
  mission_finish: 'WP6b', mission_report: 'WP6b', mission_start: 'WP6b', watcher_create: 'WP6b', watcher_manage: 'WP6b',
  // WP7a — src/surfaces/tools.ts · WP7b — src/surfaces/business/tools.ts
  poll_create: 'WP7a', business_draft_reply: 'WP7b', business_list_chats: 'WP7b', business_read_chat: 'WP7b',
  // s07 BR — src/browser/tools.ts: browse_task (dm/topic: starts the browse mission) + the in-mission browser toolkit (surface 'mission' only)
  browse_task: 'BR', browser_open: 'BR', browser_snapshot: 'BR', browser_click: 'BR', browser_type: 'BR', browser_select: 'BR', browser_press: 'BR',
  browser_scroll: 'BR', browser_back: 'BR', browser_show: 'BR', browser_done: 'BR',
  // s07 GR — src/groups/tools.ts: the add-to-group link (dm/topic)
  group_invite_link: 'GR',
});

/** WP0 addition: the module that exports each tool's spec (WP5's registry imports its own; the rest arrive as `external`). */
export const TOOL_FILES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.keys(TOOL_OWNERS).map((name): [string, string] => {
      if (name === 'revise_pending_action' || name === 'task_wait') return [name, 'src/trust/tools.ts'];
      if (name.startsWith('memory_')) return [name, 'src/memory/tools.ts'];
      if (name.startsWith('reminder_') || name === 'todo_manage') return [name, 'src/reminders/tools.ts'];
      if (name.startsWith('mission_') || name.startsWith('watcher_')) return [name, 'src/missions/tools.ts'];
      if (name === 'poll_create') return [name, 'src/surfaces/tools.ts'];
      if (name.startsWith('business_')) return [name, 'src/surfaces/business/tools.ts'];
      if (name === 'browse_task' || name.startsWith('browser_')) return [name, 'src/browser/tools.ts'];
      if (name === 'group_invite_link') return [name, 'src/groups/tools.ts'];
      const impl: Record<string, string> = {
        web_search: 'web', web_fetch: 'web', fx_convert: 'fx', integration_connect: 'connect', ledger_query: 'ledger', location_request: 'location',
        make_file: 'makeFile', offer_choices: 'choices', react: 'react', settings_update: 'settings', share_place: 'place', time_resolve: 'time',
        weather_get: 'weather', use_toolkit: 'useToolkit',
      };
      return [name, `src/tools/impl/${impl[name] ?? name.split('_')[0]}.ts`];
    }),
  ),
);
