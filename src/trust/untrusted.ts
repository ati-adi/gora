// trust/untrusted.ts (WP4) — 01 §11.3 item 1 + 03 R5: the ONLY way third-party text reaches the model.
// Order: redaction (§11.6) → reserved-tag neutralization (kernel/tags.ts) → PromptGuard (guard.ts) → wrapper markup.
import type { Priority, Services, UntrustedSource, UntrustedWrapper, UserId } from '../contracts/index.ts';
import { escapeAttr, neutralizeLookalikeTags, neutralizeReservedTags } from '../kernel/tags.ts';
import { guardText } from './guard.ts';
import { redact } from './redact.ts';

export const UNTRUSTED_SOURCES: readonly UntrustedSource[] = ['web', 'email', 'calendar', 'business_peer', 'forward', 'group_member', 'guest', 'file', 'import', 'derived', 'guest_reply'];

/** Moved to kernel/tags.ts (TRUST-08); neutralizeReservedTags now applies it too. Re-exported for existing importers. */
export { neutralizeLookalikeTags };

export function createUntrustedWrapper(s: Services): UntrustedWrapper {
  const safe = <T,>(f: () => T): T | undefined => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  return {
    redact,
    async wrap(p: { source: UntrustedSource; label: string; text: string; userId?: UserId | null; runId?: string | null; priority?: Priority }) {
      const source = UNTRUSTED_SOURCES.includes(p.source) ? p.source : 'derived';
      const cleaned = neutralizeLookalikeTags(neutralizeReservedTags(redact(p.text ?? '')));
      const g = await guardText(
        {
          guard: safe(() => s.capabilities?.guard ?? s.caps?.guard),
          kv: safe(() => s.repos.kv),
          log: s.log,
          limits: { chunkChars: s.config.limits.guardChunkChars, overlap: s.config.limits.guardChunkOverlap, maxChunks: s.config.limits.guardMaxChunks },
        },
        cleaned,
        { ...(p.priority ? { priority: p.priority } : {}), userId: p.userId ?? null, runId: p.runId ?? null },
      );
      if (g.removedChunks > 0 && p.userId) {
        try {
          s.ledger.append({
            userId: p.userId,
            actor: 'system',
            kind: 'guard_block',
            summary: `Removed likely prompt injection from ${source} content`,
            detail: { source, chunks: g.removedChunks, score: g.maxScore },
            ...(p.runId ? { runId: p.runId } : {}),
          });
        } catch (e) {
          s.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'untrusted: guard_block ledger append failed');
        }
      }
      const attrs = `source="${escapeAttr(source)}" label="${escapeAttr(neutralizeLookalikeTags(neutralizeReservedTags(p.label ?? '')))}"${g.suspicious ? ' suspicious="true"' : ''}`;
      return { text: `<untrusted ${attrs}>${g.text}</untrusted>`, suspicious: g.suspicious, removedChunks: g.removedChunks };
    },
  };
}
