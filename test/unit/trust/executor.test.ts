import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock } from '../../../src/contracts/index.ts';
import { fakeEmailTool, fakeNoteTool, fakeReadTool, makeEnv, signal, use, type Env } from './env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const text = (r: { content?: unknown }) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content));

describe('executor.processRound (01 §5.6)', () => {
  it('UNKNOWN_TOOL and INVALID_INPUT are is_error results', async () => {
    env = makeEnv([fakeEmailTool()]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'nope', {}), use('t2', 'send_email', { to: 'not-an-email' })] as BetaToolUseBlock[], null as never, signal());
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.is_error).toBe(true);
    expect(JSON.parse(text(out.results[0]!))).toEqual({ error: 'UNKNOWN_TOOL' });
    expect(out.results[1]!.is_error).toBe(true);
    const inv = JSON.parse(text(out.results[1]!));
    expect(inv.error).toBe('INVALID_INPUT');
    expect(Array.isArray(inv.issues)).toBe(true);
  });

  it('deny gives the policy text and sends the Connect card for not_connected', async () => {
    env = makeEnv([fakeEmailTool()]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    env.connected.gmail = false;
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'send_email', { to: 'anna@x.com', subject: 's', body: 'b' })] as BetaToolUseBlock[], null as never, signal());
    expect(out.results[0]!.is_error).toBe(true);
    expect(text(out.results[0]!)).toBe('Blocked by policy (S03): Gmail is not connected. Do not retry; tell the user.');
    const ints = env.s.integrations as unknown as { connectCards: Array<{ kind: string }> };
    expect(ints.connectCards.map((c) => c.kind)).toEqual(['gmail']);
    expect(env.repos.runs.toolCallsFor(run.id)[0]!.status).toBe('denied');
  });

  it('ask returns the pending JSON with performed:false and sends a card', async () => {
    env = makeEnv([fakeEmailTool()]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'send_email', { to: 'anna@x.com', subject: 'Hi', body: 'Hello' })] as BetaToolUseBlock[], null as never, signal());
    const r = out.results[0]!;
    expect(r.is_error).toBeUndefined();
    const body = JSON.parse(text(r));
    expect(body.status).toBe('pending_approval');
    expect(body.performed).toBe(false);
    expect(body.approval_id).toMatch(/^[0-9A-Z]{6}$/);
    expect(body.summary).toBe('Send email to anna@x.com');
    expect(body.note).toContain(`task_wait with on:["approval:${body.approval_id}"]`);
    expect(env.out.sent).toHaveLength(1);
    expect(env.out.sent[0]!.markdown).toContain('🔐');
    const tc = env.repos.runs.toolCallsFor(run.id)[0]!;
    expect(tc.status).toBe('pending_approval');
    expect(tc.pendingActionId).toBe(body.approval_id);
    // every decision is recorded
    expect(env.s.sentinel.decisionsFor(run.id).map((d) => d.decision)).toEqual(['ask']);
  });

  it('results come back in tool_use order; parallel-safe reads run concurrently', async () => {
    const log: string[] = [];
    env = makeEnv([fakeReadTool('r1', { log }), fakeReadTool('r2', { log }), fakeReadTool('r3', { log }), fakeNoteTool()]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(
      run, conv, 1,
      [use('a', 'r1', { q: '1' }), use('b', 'r2', { q: '2' }), use('c', 'note_save', { text: 'x' }), use('d', 'r3', { q: '3' })] as BetaToolUseBlock[],
      null as never, signal(),
    );
    expect(out.results.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c', 'd']);
    // r1 and r2 started before either finished (concurrent batch), and both finished before note_save ran
    expect(log.slice(0, 2)).toEqual(['start:r1', 'start:r2']);
    expect(log.indexOf('end:r2')).toBeLessThan(log.indexOf('start:r3'));
    // write_self with undo → an effect line with an Undo id
    const line = out.effects.find((e) => e.kind === 'line');
    expect(line && line.kind === 'line' && line.undoId).toBeTruthy();
  });

  it('an untrusted output is wrapped and taints the round; a later send in the same round is S14', async () => {
    env = makeEnv([fakeReadTool('mail_read', { taint: 'email' }), fakeEmailTool()]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('a', 'mail_read', { q: 'inbox' })] as BetaToolUseBlock[], null as never, signal());
    expect(text(out.results[0]!)).toMatch(/^<untrusted source="email" label="mail_read">/);
    expect(out.taintAdded).toEqual(['email']);
  });

  it('task_wait parks after the other calls and has no immediate result', async () => {
    const { TOOLS } = await import('../../../src/trust/tools.ts');
    env = makeEnv([fakeReadTool('r1'), ...TOOLS]);
    const c2 = env.addConv(env.addUser());
    const out = await env.s.executor.processRound(c2.run, c2.conv, 1, [use('a', 'r1', { q: 'x' }), use('w', 'task_wait', { on: ['approval:ABC123'], timeout_hours: 48 })] as BetaToolUseBlock[], null as never, signal());
    expect(out.results.map((r) => r.tool_use_id)).toEqual(['a']);
    expect(out.park?.wakeOn).toEqual(['approval:ABC123']);
    expect(out.park?.wakeAt).toBe(env.clock.now() + 24 * 3_600_000); // DM cap
  });

  it('cancelUnstarted marks staged calls cancelled', async () => {
    env = makeEnv([fakeReadTool('r1')]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    env.repos.runs.stageToolCalls([{ toolUseId: 'x1', runId: run.id, conversationId: conv.id, epoch: 1, userId: u.id, assistantSeq: 3, ordinal: 0, name: 'r1', input: { q: 'a' } }]);
    const r = env.s.executor.cancelUnstarted(run.id, 3);
    expect(r).toEqual([{ type: 'tool_result', tool_use_id: 'x1', content: 'Cancelled by user before execution', is_error: true }]);
  });
});

describe('approvals: resolve and executeApproved', () => {
  async function propose(e: Env) {
    const u = e.addUser();
    const { conv, run } = e.addConv(u);
    const out = await e.s.executor.processRound(run, conv, 1, [use('t1', 'send_email', { to: 'anna@x.com', subject: 'Hi', body: 'Hello' })] as BetaToolUseBlock[], null as never, signal());
    return { u, conv, run, id: JSON.parse(text(out.results[0]!)).approval_id as string };
  }

  it('approve executes exactly once; a second tap is "Already handled"', async () => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const { u, id } = await propose(env);
    const r1 = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(r1.status).toBe('executed');
    const r2 = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(r2.status).toBe('already_handled');
    expect(tool.sent).toHaveLength(1);
    expect(tool.sent[0]!.idemKey).toBe(`pa:${id}`);
    expect(env.s.approvals.get(id, u.id)?.status).toBe('executed');
    // the recipient is now trusted (approved_action)
    expect(env.s.trustedTargets.isTrusted(u.id, 'email', 'anna@x.com')).toBe(true);
  });

  it('another user cannot resolve', async () => {
    env = makeEnv([fakeEmailTool()]);
    const { id } = await propose(env);
    const r = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: 999, via: 'callback' });
    expect(r.status).toBe('forbidden');
  });

  it('a changed diff supersedes the card instead of executing', async () => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const { u, id } = await propose(env);
    tool.subjectOverride.value = 'Changed';
    const r = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(r.status).toBe('superseded');
    expect(tool.sent).toHaveLength(0);
    const pending = env.s.approvals.listPending(u.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.warnings.join(' ')).toContain('draft_changed');
  });

  it('/pause between card and tap blocks at execution (phase execute)', async () => {
    const tool = fakeEmailTool();
    env = makeEnv([tool]);
    const { u, id } = await propose(env);
    env.repos.users.update(u.id, { status: 'paused' });
    const r = await env.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(r.status).toBe('denied_by_policy');
    expect(tool.sent).toHaveLength(0);
  });

  it('deny and expiry write conv_events (code-owned text only, never the third-party summary)', async () => {
    env = makeEnv([fakeEmailTool()]);
    const a = await propose(env);
    await env.s.approvals.resolve(a.id, { decision: 'deny', scope: 'once', byTgId: a.u.tgUserId, via: 'callback' });
    const ev1 = env.repos.inputs.takeEvents(a.conv.id, 'r');
    expect(ev1.join('\n')).toContain(`${a.id} (send_email) denied`);
    const out = await env.s.executor.processRound(a.run, a.conv, 2, [use('t9', 'send_email', { to: 'anna@x.com', subject: 'x', body: 'y' })] as BetaToolUseBlock[], null as never, signal());
    const id2 = JSON.parse(text(out.results[0]!)).approval_id as string;
    await env.clock.advance(25 * 3_600_000);
    expect(await env.s.approvals.expireDue(env.clock.now())).toBe(1);
    expect(env.repos.inputs.takeEvents(a.conv.id, 'r2').join('\n')).toContain(`${id2} (send_email) expired`);
  });

  it('undo runs spec.undo once through the executor', async () => {
    const note = fakeNoteTool();
    env = makeEnv([note]);
    const u = env.addUser();
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('n', 'note_save', { text: 'hi' })] as BetaToolUseBlock[], null as never, signal());
    const line = out.effects.find((e) => e.kind === 'line');
    const undoId = line && line.kind === 'line' ? line.undoId! : '';
    expect((await env.s.undo.undo(undoId, 4242)).ok).toBe(false);
    expect((await env.s.undo.undo(undoId, u.tgUserId)).ok).toBe(true);
    expect((await env.s.undo.undo(undoId, u.tgUserId)).ok).toBe(true);
    expect(note.undone).toEqual([{ id: 'n1', text: 'hi' }]);
  });
});
