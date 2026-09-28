// REVIEW (trust) — TOCTOU supersede (executor.ts supersedeWith, called from executeApproved) builds the new card from
// the FRESH renderDiff but with the OLD stored targets (`fresh = { ...r, targets: storedTargets }`), and with a
// hard-coded decision T01 {warnings: []} that never goes through evaluateRules. Consequences:
//  (a) a recipient that appeared in the remote object after the first card (e.g. a draft/event whose recipients are
//      changed by someone else) is never provenance-checked: no S13 warning, not in the row's targets, and after the
//      owner approves the new card the send goes to it while trusted_targets/ladder history record only the old ones;
//  (b) every warning of the original card (S13 "recipient came from an email", L01 safety check) is dropped from the
//      superseding card, which only says "draft changed".
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalDiff, BetaToolUseBlock, Classification, Target, ToolCtx, ToolOutput, ToolSpec } from '../../../src/contracts/index.ts';
import { makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

/** gmail_send_draft-like tool: recipients and subject live in a remote draft that can change after the card. */
function remoteDraftTool() {
  const remote = { to: ['boss@acme.com'], subject: 'Report' };
  const sentTo: string[][] = [];
  const spec: ToolSpec = {
    name: 'send_draft', description: 'test', input: z.object({ draft_id: z.string() }), surfaces: ['dm', 'topic', 'mission'], parallelSafe: false,
    classify: (): Classification => ({ actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act' }),
    targets: async (): Promise<Target[]> => remote.to.map((v) => ({ kind: 'email', value: v, hmac: 'x', provenance: 'user' })),
    renderDiff: async (): Promise<ApprovalDiff> => ({
      title: 'Send email', summary: `To ${remote.to.join(', ')}`, rows: [['To', remote.to.join(', ')], ['Subject', remote.subject]], warnings: [],
      targets: remote.to.map((v) => ({ kind: 'email', value: v, hmac: 'x', provenance: 'user' })),
    }),
    statusLabel: () => 'Sending',
    async execute(_i: unknown, _ctx: ToolCtx): Promise<ToolOutput> {
      sentTo.push([...remote.to]);
      return { content: '{"sent":true}' };
    },
  };
  return { spec, remote, sentTo };
}

async function setup(e: Env, ownerText: string) {
  const u = e.addUser();
  const { conv, run } = e.addConv(u);
  await e.clock.advance(1_000);
  e.repos.inputs.add({ conversationId: conv.id, kind: 'text', author: 'owner', untrusted: false, content: [{ type: 'text', text: ownerText }], tgUpdateId: 1, tgChatId: u.tgUserId, tgMessageId: 1, fromTgUserId: u.tgUserId, replyToCardId: null });
  const out = await e.s.executor.processRound(run, conv, 1, [use('t1', 'send_draft', { draft_id: 'd1' })] as BetaToolUseBlock[], null as never, signal());
  return { u, conv, run, id: JSON.parse(String(out.results[0]!.content)).approval_id as string };
}

describe('TOCTOU supersede re-uses stale targets and drops warnings', () => {
  it('(a) a recipient added to the remote draft after the card is provenance-checked on the superseding card', async () => {
    const t = remoteDraftTool();
    env = makeEnv([t.spec]);
    const { u, id } = await setup(env, 'send the report draft to boss@acme.com');
    expect(env.s.approvals.get(id, u.id)!.targets.map((x) => x.provenance)).toEqual(['user']);
    t.remote.to = ['boss@acme.com', 'x@evil.com']; // changed remotely before the tap
    const r = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(r.status).toBe('superseded');
    const next = env.s.approvals.listPending(u.id)[0]!;
    // The new card must know about x@evil.com and flag it (S13: not from the owner).
    expect(next.targets.map((x) => x.display)).toContain('x@evil.com');
    expect(next.warnings.join(' ')).toMatch(/not from you/);
  });

  it('(b) the superseding card keeps the S13 provenance warning of the original card', async () => {
    const t = remoteDraftTool();
    t.remote.to = ['stranger@elsewhere.com']; // never typed by the owner → 'unknown' → S13 warning
    env = makeEnv([t.spec]);
    const { u, id } = await setup(env, 'send the report draft');
    const first = env.s.approvals.get(id, u.id)!;
    expect(first.warnings.join(' ')).toMatch(/not from you/);
    t.remote.subject = 'Report v2'; // any change → supersede
    await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    const next = env.s.approvals.listPending(u.id)[0]!;
    expect(next.warnings.join(' ')).toMatch(/not from you/);
  });
});
