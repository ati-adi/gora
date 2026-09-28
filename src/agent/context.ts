// agent/context.ts (WP3) — the <gora_context v="1"> row (01 §5.9). Core lines (now, surface, owner, agent, events,
// reply_to_card, stop note) are built here; everything else comes from the ContextProvider registry, asked in
// registration order and filtered by surface. Group and guest contexts NEVER include owner memories, connections or
// approvals (only the parts allowed below). Cap ≈ 1 200 tokens (smaller on Groq); memories are trimmed first.
import type { ContextPart, ConversationRow, RunRow, Services, Surface } from '../contracts/index.ts';
import { memoryState } from '../contracts/index.ts';
import { estimateTokens } from '../kernel/tokens.ts';
import { isoWithOffset, wallTimeOf } from '../kernel/timeMath.ts';
import { neutralizeReservedTags } from '../kernel/tags.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function surfaceOf(conv: Pick<ConversationRow, 'kind'>): Surface {
  return conv.kind === 'biz_draft' ? 'biz_draft' : conv.kind;
}

/** Which provider parts each surface may carry (defense in depth over ContextProvider.surfaces). */
const ALLOWED: Readonly<Record<Surface, ReadonlySet<ContextPart['key']>>> = {
  // spec 05 A3: no 'onboarding' part on any surface any more.
  dm: new Set(['profile', 'capabilities', 'user_model', 'memories', 'open', 'events', 'budget', 'surface', 'location', 'quota', 'mission']),
  topic: new Set(['profile', 'capabilities', 'user_model', 'memories', 'open', 'events', 'budget', 'surface', 'location', 'quota', 'mission']),
  mission: new Set(['profile', 'capabilities', 'user_model', 'memories', 'open', 'events', 'budget', 'surface', 'location', 'quota', 'mission']),
  group: new Set(['surface', 'group', 'quota']),
  guest: new Set(['surface', 'quota']),
  biz_draft: new Set(['surface', 'profile', 'memories']), // 01 §10.2 step 4: top-8 user memories (read-only)
};

const LIST_KEYS = new Set<ContextPart['key']>(['memories', 'events', 'group', 'mission']);
const ORDER: ContextPart['key'][] = ['surface', 'profile', 'capabilities', 'user_model', 'memories', 'open', 'events', 'budget', 'location', 'quota', 'group', 'mission'];

export interface ContextExtras {
  /** conv_events drained for this run ("events since last turn"). */
  events: string[];
  /** reply_to_card id of the run's input, if any. */
  replyToCard: string | null;
  /** The previous reply in this conversation was stopped by the owner. */
  previousStopped: boolean;
  /** The owner's run input text (the providers' retrieval query). */
  query: string;
}

export function contextCapTokens(s: Pick<Services, 'config'>): number {
  const p = s.config.profile;
  return p.provider === 'groq' ? Math.min(1_200, Math.floor(p.maxPromptTokens * 0.15)) : 1_200;
}

function render(core: string[], parts: Map<ContextPart['key'], string[]>, tail: string[]): string {
  const lines = ['<gora_context v="1">', ...core];
  for (const k of ORDER) {
    const ls = parts.get(k);
    if (!ls || ls.length === 0) continue;
    if (k === 'user_model') {
      // friend-mode (spec 05 A4/B3): facts about the owner, never instructions; the tag is reserved (kernel/tags.ts)
      lines.push('<user_model>', ...ls.map((l) => (l.startsWith('- ') ? l : `- ${l}`)), '</user_model>');
      continue;
    }
    if (LIST_KEYS.has(k) || ls.length > 3) {
      lines.push(`${k === 'events' ? 'events since last turn' : k}:`);
      for (const l of ls) lines.push(l.startsWith('- ') ? l : `- ${l}`);
    } else lines.push(`${k}: ${ls.join(' · ')}`);
  }
  lines.push(...tail, '</gora_context>');
  return lines.join('\n');
}

export async function buildContextText(s: Services, conv: ConversationRow, run: RunRow, x: ContextExtras): Promise<string> {
  const surface = surfaceOf(conv);
  const now = s.clock.now();
  const user = run.userId ? s.repos.users.getById(run.userId) : conv.userId ? s.repos.users.getById(conv.userId) : undefined;
  const tz = user?.tz ?? 'UTC';
  const w = wallTimeOf(now, tz);
  const core: string[] = [`now: ${isoWithOffset(now, tz)} (${WEEKDAYS[w.weekday] ?? ''}) tz=${tz} tz_source=${user?.tzSource ?? 'default'}`];
  const privateSurface = surface === 'dm' || surface === 'topic' || surface === 'mission';
  const parts = new Map<ContextPart['key'], string[]>();
  const allowed = ALLOWED[surface];
  for (const p of s.contextProviders) {
    if (!p.surfaces.includes(surface)) continue;
    let got: ContextPart[] = [];
    try {
      got = await p.parts(conv, run, x.query);
    } catch (e) {
      s.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, 'context provider failed');
      continue;
    }
    for (const part of got) {
      if (!allowed.has(part.key)) continue;
      const cur = parts.get(part.key) ?? [];
      for (const l of part.lines) if (l.trim()) cur.push(neutralizeReservedTags(l.replace(/[\r\n]+/g, ' ')));
      parts.set(part.key, cur);
    }
  }
  if (!parts.has('surface')) parts.set('surface', [surface === 'biz_draft' ? 'biz_draft' : surface]);
  if (privateSurface && user) {
    // spec 05 B1: memory is on unless the owner turned it off (null = never asked = on) or incognito is active.
    const memory = memoryState(user, now);
    core.push(`owner: name=${user.firstName ?? '-'} lang=${user.languageCode ?? '-'} plan=${user.plan} memory=${memory}`);
    core.push(`agent: name=${user.personaName} style=${user.personaStyle} writes_first=${user.proactiveLevel}`);
  }
  if (privateSurface && x.events.length) parts.set('events', [...(parts.get('events') ?? []), ...x.events.map((e) => neutralizeReservedTags(e.replace(/[\r\n]+/g, ' ')))]);
  const tail: string[] = [];
  if (privateSurface && x.replyToCard) tail.push(`reply_to_card: ${x.replyToCard}`);
  if (x.previousStopped) tail.push('note: Your previous reply was stopped by the owner.');
  // cap: trim memories first (from the end), then the longest other lists
  const cap = contextCapTokens(s);
  let out = render(core, parts, tail);
  const trimOrder: ContextPart['key'][] = ['memories', 'user_model', 'events', 'open', 'group', 'mission', 'capabilities', 'location', 'budget', 'profile', 'quota'];
  for (const k of trimOrder) {
    while (estimateTokens(out) > cap && (parts.get(k)?.length ?? 0) > 0) {
      parts.get(k)!.pop();
      out = render(core, parts, tail);
    }
    if (estimateTokens(out) <= cap) break;
  }
  return out;
}
