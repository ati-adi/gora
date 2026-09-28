// telegram/channels/bizOwner.ts (WP2) — Secretary drafting runs (01 §5.5): no text surface at all. The only output of a
// business drafting run is the approval card (sent by the executor). When the run ends without business_draft_reply,
// the Inbox digest records "no reply suggested" (BusinessService.noteNoDraft).
import type { ConversationRow, ReplyChannel, RunRow, Services } from '../../contracts/index.ts';

export function createBizOwnerChannel(s: Services, run: RunRow, conv: ConversationRow): ReplyChannel {
  let text = '';
  const noteIfNoDraft = async () => {
    try {
      const drafted = s.repos.runs.toolCallsFor(run.id).some((t) => t.name === 'business_draft_reply');
      if (!drafted) await s.business.noteNoDraft(conv.id);
    } catch (e) {
      s.log.warn({ runId: run.id, err: e instanceof Error ? e.name : 'error' }, 'noteNoDraft failed');
    }
  };
  const ch: ReplyChannel = {
    kind: 'biz_owner',
    get visibleText() {
      return text;
    },
    async begin() {},
    text(d) {
      text += d; // kept only for visibleText (never sent)
    },
    status() {},
    resetIteration() {},
    commitIteration() {},
    blockStart() {},
    async checkpoint() {},
    async finalize() {
      await noteIfNoDraft();
      return [];
    },
    async stopped() {
      await noteIfNoDraft();
    },
    async fail() {
      await noteIfNoDraft();
    },
  };
  return ch;
}
