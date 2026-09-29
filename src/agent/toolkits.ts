// agent/toolkits.ts (WP3) — 03 R3 engine side: the ToolkitState over conversation_toolkits + conversation_turns, and the
// active-toolkit selection for a request (core ∪ loaded in the last 6 user turns ∪ kits of tools called in the visible
// history ∪ deterministic preloads). The toolkit DEFINITIONS (membership) come from the registry (WP5 tools/toolkits.ts).
import type { Clock, Db, MainRequest, ToolkitId, ToolkitState } from '../contracts/index.ts';
import { TOOLKIT_IDS } from '../contracts/tools.ts';
import { protectedEstimate, translateRequest } from './groq/map.ts';

/** A kit loaded by use_toolkit stays active for this many further user turns. */
export const TOOLKIT_TTL_TURNS = 6;

export interface ToolkitStateImpl extends ToolkitState {
  /** +1 user turn (a run consumed owner input). Returns the new count. */
  bumpTurn(conversationId: string): number;
}

type LoadableKit = Exclude<ToolkitId, 'core'>;

export function createToolkitState(db: Db, clock: Clock): ToolkitStateImpl {
  const userTurn = (conversationId: string): number =>
    db.prepare('SELECT user_turns FROM conversation_turns WHERE conversation_id = ?').get<{ user_turns: number }>(conversationId)?.user_turns ?? 0;
  return {
    userTurn,
    bumpTurn(conversationId) {
      db.prepare('INSERT INTO conversation_turns (conversation_id, user_turns) VALUES (?, 1) ON CONFLICT(conversation_id) DO UPDATE SET user_turns = user_turns + 1').run(conversationId);
      return userTurn(conversationId);
    },
    load(conversationId, kit: LoadableKit) {
      const expiresAfterTurn = userTurn(conversationId) + TOOLKIT_TTL_TURNS;
      db.prepare(
        'INSERT INTO conversation_toolkits (conversation_id, toolkit, expires_after_turn, loaded_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(conversation_id, toolkit) DO UPDATE SET expires_after_turn = excluded.expires_after_turn, loaded_at = excluded.loaded_at',
      ).run(conversationId, kit, expiresAfterTurn, clock.now());
      return { expiresAfterTurn };
    },
    active(conversationId) {
      const t = userTurn(conversationId);
      const rows = db.prepare('SELECT toolkit FROM conversation_toolkits WHERE conversation_id = ? AND expires_after_turn >= ?').all<{ toolkit: string }>(conversationId, t);
      const kits = new Set(rows.map((r) => r.toolkit));
      return TOOLKIT_IDS.filter((k) => k === 'core' || kits.has(k));
    },
  };
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i;
const WEB_WORDS_RE = /(search|find|price|news|weather|курс|погод|найди)/i;
const CAL_WORDS_RE = /(calendar|meeting|event|календар|встреч|событи)/i;
const MAIL_WORDS_RE = /(\bmail|e-mail|email|inbox|почт|письм|имейл|емейл)/i;
/** s07 (spec 07 A2): acting on a website → the browser toolkit (browse_task). */
const BROWSE_WORDS_RE = /(забронир|бронь|запиши меня|запишись на|оформи заказ|закажи столик|заполни (?:форму|анкету)|\bbook (?:a|me|us)\b|\breserve\b|fill (?:in|out) (?:the|a|this) form|sign me up)/i;

export interface PreloadInput {
  /** Text of the run's input (owner text of the run-start row; may be empty for events). */
  text: string;
  route: string;
  hasPendingApproval: boolean;
  connected: { gmail: boolean; gcal: boolean };
}

/** 03 R3 deterministic preloads. */
export function preloadKits(p: PreloadInput): ToolkitId[] {
  const out = new Set<ToolkitId>();
  if (URL_RE.test(p.text)) out.add('web');
  if (WEB_WORDS_RE.test(p.text)) out.add('web');
  if (p.hasPendingApproval) out.add('account');
  if (p.route === 'mission') out.add('missions');
  // s07 (spec 07 B2): a calendar question preloads the calendar kit even when nothing is connected (its tools answer
  // NOT_CONNECTED and the kit carries integration_connect), so the first reply can be the one-line connect offer.
  if (CAL_WORDS_RE.test(p.text)) out.add('calendar');
  if (BROWSE_WORDS_RE.test(p.text)) out.add('browser');
  if (p.connected.gmail && MAIL_WORDS_RE.test(p.text)) out.add('email');
  return [...out];
}

/** Toolkits containing any of the tool names (from the registry's membership table). */
export function kitsOfTools(membership: Readonly<Record<ToolkitId, readonly string[]>>, names: Iterable<string>): ToolkitId[] {
  const want = new Set(names);
  const out: ToolkitId[] = [];
  for (const k of TOOLKIT_IDS) if ((membership[k] ?? []).some((n) => want.has(n))) out.push(k);
  return out;
}

/** The active set for one request: core ∪ loaded ∪ history kits ∪ preloads, in TOOLKIT_IDS order. */
export function selectActiveKits(o: { loaded: readonly ToolkitId[]; historyKits: readonly ToolkitId[]; preloads: readonly ToolkitId[] }): ToolkitId[] {
  const s = new Set<ToolkitId>(['core', ...o.loaded, ...o.historyKits, ...o.preloads]);
  return TOOLKIT_IDS.filter((k) => s.has(k));
}

/**
 * 03 R2 over R3: the kits the prompt budget may drop, least valuable first. Never `core`, never a kit a tool of the
 * current run belongs to (`runKits`: the model's working set, and history tool_calls stay declared), never a kit the
 * route needs (`required`). History-only kits go first, then preloads, then kits the model loaded with use_toolkit;
 * within a group the reverse TOOLKIT_IDS order (account first, web last). A dropped kit can be re-loaded by use_toolkit.
 */
export function droppableKits(o: { active: readonly ToolkitId[]; loaded: readonly ToolkitId[]; preloads: readonly ToolkitId[]; runKits: readonly ToolkitId[]; required?: readonly ToolkitId[] }): ToolkitId[] {
  const keep = new Set<ToolkitId>(['core', ...o.runKits, ...(o.required ?? [])]);
  const rank = (k: ToolkitId) => (o.loaded.includes(k) ? 2 : o.preloads.includes(k) ? 1 : 0);
  return o.active.filter((k) => !keep.has(k)).sort((a, b) => rank(a) - rank(b) || TOOLKIT_IDS.indexOf(b) - TOOLKIT_IDS.indexOf(a));
}

/**
 * Builds the request with the active kits, dropping kits from `droppable` (in order) while what the hard ceiling can
 * never drop (map.ts protectedEstimate) exceeds `maxPromptTokens`. Returns the request and the kits dropped.
 */
export function fitKitsToBudget(o: { kits: readonly ToolkitId[]; droppable: readonly ToolkitId[]; build: (kits: readonly ToolkitId[]) => MainRequest; maxPromptTokens: number; maxOutputTokens: number }): { req: MainRequest; dropped: ToolkitId[] } {
  let kits = [...o.kits];
  let req = o.build(kits);
  const dropped: ToolkitId[] = [];
  const size = (r: MainRequest) => protectedEstimate(translateRequest(r, { mediaText: () => '[attachment]', maxOutputTokens: o.maxOutputTokens }));
  for (const k of o.droppable) {
    if (size(req) <= o.maxPromptTokens) break;
    kits = kits.filter((x) => x !== k);
    dropped.push(k);
    req = o.build(kits);
  }
  return { req, dropped };
}
