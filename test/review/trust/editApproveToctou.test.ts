// REVIEW (trust) — approvals.resolve with `editedInput` (Mini App "Edit" → Approve, POST /api/approvals/:id) revises the
// action (re-rendering the diff from the CURRENT remote state) and then immediately approves the new version in the same
// call. executeApproved's TOCTOU check then compares against that just-rendered diff, never against the diff the owner
// actually looked at (the v1 card / Mini App screen). Any remote change between viewing and tapping — e.g. attendees
// added to the event by its co-organizer — is executed without the owner ever seeing it, and without the
// "Draft changed since you saw it" re-review that 01 §5.6 step 3.2 requires. New ask-warnings of the revised decision
// (S13 for the new attendee) are likewise never shown.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalDiff, BetaToolUseBlock, Classification, Target, ToolOutput, ToolSpec } from '../../../src/contracts/index.ts';
import { makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

function eventUpdateTool() {
  const remote = { attendees: ['boss@acme.com'] };
  const notified: string[][] = [];
  const t = (): Target[] => remote.attendees.map((v) => ({ kind: 'gcal_attendee', value: v, hmac: 'x', provenance: 'user' }));
  // Named like the real tool so EDIT_PATHS (title → patch.title) applies.
  const spec: ToolSpec = {
    name: 'calendar_update_event', description: 'test', surfaces: ['dm', 'topic', 'mission'], parallelSafe: false,
    input: z.object({ event_id: z.string(), patch: z.object({ title: z.string().optional() }) }),
    classify: (): Classification => ({ actionClass: 'send_external', risk: 2 }),
    targets: async () => t(),
    renderDiff: async (i: unknown): Promise<ApprovalDiff> => {
      const title = (i as { patch: { title?: string } }).patch.title ?? '';
      return { title: 'Update event', summary: `Update to ${title}`, rows: [['Title', title], ['Attendees', remote.attendees.join(', ')]], warnings: [], targets: t() };
    },
    statusLabel: () => 'Updating',
    async execute(): Promise<ToolOutput> {
      notified.push([...remote.attendees]);
      return { content: '{"updated":true}' };
    },
  };
  return { spec, remote, notified };
}

describe('Mini App edit + approve skips the TOCTOU re-review', () => {
  it('attendees added after the owner viewed the card are not notified without a fresh review', async () => {
    const tool = eventUpdateTool();
    env = makeEnv([tool.spec]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    await env.clock.advance(1_000);
    env.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'rename the sync with boss@acme.com' }], tgUpdateId: 1, tgChatId: u.tgUserId, tgMessageId: 1, fromTgUserId: u.tgUserId, replyToCardId: null });
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'calendar_update_event', { event_id: 'e1', patch: { title: 'Sync' } })] as BetaToolUseBlock[], null as never, signal());
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    const seen = env.s.approvals.get(id, u.id)!; // what the Mini App shows the owner
    expect(seen.rows).toContainEqual(['Attendees', 'boss@acme.com']);
    tool.remote.attendees.push('x@evil.com'); // changed remotely while the owner edits
    const r = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'miniapp', editedInput: { title: 'Weekly sync' } });
    // Expected: the owner must re-review a diff they have not seen; nothing reaches x@evil.com.
    expect(tool.notified.flat()).not.toContain('x@evil.com');
    expect(r.status).not.toBe('executed');
  });

  it('an edit with no remote change and no new warning is still approved in one step', async () => {
    const tool = eventUpdateTool();
    env = makeEnv([tool.spec]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    await env.clock.advance(1_000);
    env.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'rename the sync with boss@acme.com' }], tgUpdateId: 1, tgChatId: u.tgUserId, tgMessageId: 1, fromTgUserId: u.tgUserId, replyToCardId: null });
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'calendar_update_event', { event_id: 'e1', patch: { title: 'Sync' } })] as BetaToolUseBlock[], null as never, signal());
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    const r = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'miniapp', editedInput: { title: 'Weekly sync' } });
    expect(r.status).toBe('executed');
    expect(tool.notified).toEqual([['boss@acme.com']]);
  });

  it('after a remote change the revised card waits for review and says it changed', async () => {
    const tool = eventUpdateTool();
    env = makeEnv([tool.spec]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    await env.clock.advance(1_000);
    env.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'rename the sync with boss@acme.com' }], tgUpdateId: 1, tgChatId: u.tgUserId, tgMessageId: 1, fromTgUserId: u.tgUserId, replyToCardId: null });
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'calendar_update_event', { event_id: 'e1', patch: { title: 'Sync' } })] as BetaToolUseBlock[], null as never, signal());
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    tool.remote.attendees.push('x@evil.com');
    await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'miniapp', editedInput: { title: 'Weekly sync' } });
    const next = env.s.approvals.listPending(u.id)[0]!;
    expect(next.targets.map((t) => t.display)).toContain('x@evil.com');
    expect(next.warnings.join(' ')).toMatch(/draft_changed|changed/);
    expect(next.warnings.join(' ')).toMatch(/not from you/);
  });
});
