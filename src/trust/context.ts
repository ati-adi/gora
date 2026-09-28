// trust/context.ts (WP4) — the "open approvals" context part (01 §5.9: open approvals from the database) and the
// "User is replying to card <ID>" line (§5.6 Revision). Lines are code-built from code-owned fields only (ids, tool names, counts, times), never
// diff summaries: those embed third-party text.
import type { ContextPart, ContextProvider, Services } from '../contracts/index.ts';

export const OPEN_APPROVALS_MAX = 5;

export function createApprovalsContext(s: Services): ContextProvider {
  return {
    name: 'trust.approvals',
    surfaces: ['dm', 'topic', 'mission'],
    async parts(conv, run) {
      if (!conv.userId) return [];
      const lines: string[] = [];
      let replyTo: string | null = null;
      try {
        for (const i of s.repos.inputs.consumedBy(run.id)) if (i.replyToCardId) replyTo = i.replyToCardId;
        if (!replyTo) for (const i of s.repos.inputs.pending(conv.id)) if (i.replyToCardId) replyTo = i.replyToCardId;
      } catch {
        /* inputs unavailable */
      }
      const pending = s.approvals.listPending(conv.userId).slice(0, OPEN_APPROVALS_MAX);
      for (const v of pending) {
        // Code-owned fields only (01 §11.3 item 2): this row carries operator authority into every run of the owner,
        // while summaries embed third-party text (event titles, email subjects). The run that proposed the action
        // already has its summary in its own tool result.
        const exp = new Date(v.expiresAt).toISOString().slice(0, 16).replace('T', ' ');
        const where = v.conversationId === conv.id ? 'proposed in this conversation' : 'proposed in another conversation';
        const n = v.targets.length;
        const who = n > 0 ? `, ${n} recipient${n === 1 ? '' : 's'}` : '';
        lines.push(`Pending approval ${v.id} (${v.toolName}${who}), ${where} — waiting for the owner's tap, expires ${exp} UTC`);
      }
      if (replyTo && /^[A-Z0-9]{6}$/.test(replyTo)) lines.push(`User is replying to card ${replyTo}. If they ask for changes, call revise_pending_action with approval_id "${replyTo}".`);
      if (lines.length === 0) return [];
      const part: ContextPart = { key: 'open', lines };
      return [part];
    },
  };
}
