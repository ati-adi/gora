// agent/inputs.ts (WP3) — input → content blocks (01 §5.3, §5.10, §11.3): owner text is tag-neutralized, untrusted inputs
// and event parts go through s.untrusted.wrap() (WP4), steering input becomes trailing '[Owner, HH:MM]: …' blocks, events
// become <gora_event> blocks, seeds <previous_epoch_summary>. Media blocks keep their '@blob:<id>' sources (hydrated only
// when a request is built).
import type { BetaContentBlockParam, ConversationRow, GoraEvent, InputRow, Priority, RunRow, Services, TaintSource, UntrustedSource } from '../contracts/index.ts';
import { escapeAttr, neutralizeReservedTags } from '../kernel/tags.ts';
import { wallTimeOf } from '../kernel/timeMath.ts';

type Block = Record<string, unknown>;

export const text = (t: string): BetaContentBlockParam => ({ type: 'text', text: t });

/** The untrusted source + label of a raw third-party input (01 §11.2 taint sources). */
export function untrustedSourceOf(i: InputRow, conv: ConversationRow): { source: UntrustedSource; label: string; taint: TaintSource } {
  if (i.kind === 'forward') return { source: 'forward', label: 'forwarded message', taint: 'forward' };
  if (i.kind === 'guest') return { source: 'guest_reply', label: 'replied-to message', taint: 'guest' };
  if (i.author === 'member' || i.kind === 'member' || conv.kind === 'group') return { source: 'group_member', label: 'group member', taint: 'group_member' };
  if (i.author === 'peer' || conv.kind === 'biz_draft') return { source: 'business_peer', label: 'chat participant', taint: 'business_peer' };
  if (i.kind === 'document') return { source: 'file', label: 'file', taint: 'file' };
  return { source: 'forward', label: 'quoted message', taint: 'forward' };
}

export function taintOfSource(src: UntrustedSource): TaintSource {
  return src === 'guest_reply' ? 'guest' : src;
}

function ownerBlock(b: BetaContentBlockParam): BetaContentBlockParam {
  const x = b as unknown as Block;
  if (x['type'] === 'text' && typeof x['text'] === 'string') return { ...(b as object), text: neutralizeReservedTags(x['text'] as string) } as BetaContentBlockParam;
  return b;
}

/** Blocks for a set of inputs, in arrival order, plus the taint they add. */
export async function inputBlocks(s: Services, conv: ConversationRow, run: Pick<RunRow, 'id' | 'userId' | 'priority'>, inputs: readonly InputRow[]): Promise<{ blocks: BetaContentBlockParam[]; taint: TaintSource[] }> {
  const blocks: BetaContentBlockParam[] = [];
  const taint = new Set<TaintSource>();
  for (const i of inputs) {
    if (!i.untrusted) {
      for (const b of i.content) blocks.push(ownerBlock(b));
      continue;
    }
    const u = untrustedSourceOf(i, conv);
    taint.add(u.taint);
    const raw = i.content.map((b) => b as unknown as Block).filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('\n');
    if (raw) {
      const w = await s.untrusted.wrap({ source: u.source, label: u.label, text: raw, userId: run.userId, runId: run.id, priority: run.priority });
      blocks.push(text(w.text));
    }
    for (const b of i.content) if ((b as unknown as Block)['type'] !== 'text') blocks.push(b);
  }
  return { blocks, taint: [...taint] };
}

/** Steering input (arrived during a tool round): '[Owner, 14:05]: …' trailing text blocks (01 §5.10). */
export async function steeringBlocks(s: Services, conv: ConversationRow, run: Pick<RunRow, 'id' | 'userId' | 'priority'>, inputs: readonly InputRow[], tz: string): Promise<{ blocks: BetaContentBlockParam[]; taint: TaintSource[] }> {
  const out: BetaContentBlockParam[] = [];
  const taint = new Set<TaintSource>();
  for (const i of inputs) {
    const w = wallTimeOf(i.createdAt, tz);
    const hhmm = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
    const r = await inputBlocks(s, conv, run, [i]);
    r.taint.forEach((t) => taint.add(t));
    const who = i.untrusted ? 'Forwarded' : 'Owner';
    const texts = r.blocks.filter((b) => (b as unknown as Block)['type'] === 'text').map((b) => String((b as unknown as Block)['text']));
    out.push(text(`[${who}, ${hhmm}]: ${texts.join('\n') || '(attachment)'}`));
    for (const b of r.blocks) if ((b as unknown as Block)['type'] !== 'text') out.push(b);
  }
  return { blocks: out, taint: [...taint] };
}

/** <gora_event type="…" ref="…">body</gora_event> plus the wrapped untrusted parts (01 §5.3 'event' rows). */
export async function eventBlocks(s: Services, run: Pick<RunRow, 'id' | 'userId' | 'priority'>, ev: GoraEvent): Promise<{ blocks: BetaContentBlockParam[]; taint: TaintSource[] }> {
  const ref = ev.ref ? ` ref="${escapeAttr(ev.ref)}"` : '';
  const blocks: BetaContentBlockParam[] = [text(`<gora_event type="${escapeAttr(ev.type)}"${ref}>${neutralizeReservedTags(ev.body)}</gora_event>`)];
  const taint = new Set<TaintSource>();
  for (const p of ev.untrusted ?? []) {
    const w = await s.untrusted.wrap({ source: p.source, label: p.label, text: p.text, userId: run.userId, runId: run.id, priority: run.priority as Priority });
    blocks.push(text(w.text));
    taint.add(taintOfSource(p.source));
  }
  return { blocks, taint: [...taint] };
}

export function seedBlock(source: 'handoff' | 'deterministic', body: string): BetaContentBlockParam {
  return text(`<previous_epoch_summary source="${source}">\n${neutralizeReservedTags(body)}\n</previous_epoch_summary>`);
}

/** Plain text of the owner's run input (for toolkit preloads and the context query); never logged. */
export function plainText(blocks: readonly BetaContentBlockParam[]): string {
  return blocks
    .map((b) => b as unknown as Block)
    .filter((b) => b['type'] === 'text')
    .map((b) => String(b['text'] ?? ''))
    .join('\n');
}
