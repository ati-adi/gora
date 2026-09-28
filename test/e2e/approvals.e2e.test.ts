// WP4 e2e (01 §15.2): approvals through the whole app — card via the outbox and FakeTelegram, taps through the real
// HMAC callback codec (WP2) and the callback registry, approve-once across a restart, TOCTOU supersede, deny/expiry
// events, and a parked mission woken with the approval result. Other WPs are pinned to their fakes (04 §4.1) so this
// file exercises WP4's code, not work in progress elsewhere; the email tool is a Gmail-like fake send tool.
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRow, RunRow, UserRow } from '../../src/contracts/index.ts';
import type { TestApp } from '../harness/testApp.ts';
import { boot, dm, gmailLikeTool, newWorld, owner, sig, tapAs, tu, type World } from '../unit/trust/world.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function propose(w: World, app: TestApp, u: UserRow, c: { conv: ConversationRow; run: RunRow }, id: string, to = 'anna@x.com', seq = 1) {
  const out = await app.s.executor.processRound(c.run, c.conv, seq, tu(id, 'gmail_send_draft', { to, subject: 'Report', body: 'Hi Anna' }), null as never, sig());
  const body = JSON.parse(String(out.results[0]!.content));
  expect(body).toMatchObject({ status: 'pending_approval', performed: false });
  void w;
  void u;
  return body.approval_id as string;
}

describe('approvals e2e (01 §5.6, F7)', () => {
  it('card appears; approve executes exactly once; double tap → Already handled; forged MAC and other users are rejected', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const c = dm(w, u);
    const id = await propose(w, t, u, c, 'toolu_1');
    await t.settle();
    const card = t.lastCard();
    expect(card.markdown).toContain('🔐');
    expect(card.markdown).toContain('Send email');
    const approve = card.buttons.find((b) => b.callback_data?.startsWith(`a1:${id}:y:o:`))!;
    expect(approve).toBeTruthy();
    expect(card.buttons.some((b) => b.callback_data?.startsWith(`a1:${id}:n:o:`))).toBe(true);

    const forged = approve.callback_data!.slice(0, -3) + (approve.callback_data!.endsWith('AAA') ? 'BBB' : 'AAA');
    expect(await tapAs(t, forged, u.tgUserId)).toMatch(/^rejected:/);
    expect(await tapAs(t, approve.callback_data!, 4242)).toMatch(/^rejected:/);
    expect(w.calls).toHaveLength(0);

    await tapAs(t, approve.callback_data!, u.tgUserId);
    expect(await tapAs(t, approve.callback_data!, u.tgUserId)).toBe('already_handled');
    await t.settle();
    expect(w.calls).toEqual([{ to: 'anna@x.com', idemKey: `pa:${id}` }]);
    expect(t.s.approvals.get(id, u.id)?.status).toBe('executed');
    // the card was edited into its outcome
    expect(t.tg.byMethod('editMessageText').length).toBeGreaterThan(0);
  });

  it('typed "yes" does not approve: the card is re-shown instead', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const id = await propose(w, t, u, dm(w, u), 'toolu_1');
    const n = await t.s.approvals.reshowPending(u.id, { chatId: u.tgUserId });
    expect(n).toBe(1);
    await t.settle();
    expect(t.tg.byMethod('sendMessage').some((p) => String((p as { text?: string }).text).includes('tap_the_card'))).toBe(true);
    expect(t.s.approvals.get(id, u.id)?.status).toBe('pending');
    expect(w.calls).toHaveLength(0);
  });

  it('a restart between card and tap still executes once', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const id = await propose(w, t, u, dm(w, u), 'toolu_1');
    await t.settle();
    const data = t.lastCard().buttons.find((b) => b.callback_data?.startsWith(`a1:${id}:y`))!.callback_data!;
    t = await boot(w, [gmailLikeTool(w)], t);
    await tapAs(t, data, u.tgUserId);
    await tapAs(t, data, u.tgUserId);
    expect(w.calls).toEqual([{ to: 'anna@x.com', idemKey: `pa:${id}` }]);
  });

  it('a draft changed after the card is superseded with a new card', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const id = await propose(w, t, u, dm(w, u), 'toolu_1');
    await t.settle();
    const data = t.lastCard().buttons.find((b) => b.callback_data?.startsWith(`a1:${id}:y`))!.callback_data!;
    w.subject.override = 'Changed behind your back';
    await tapAs(t, data, u.tgUserId);
    await t.settle();
    expect(w.calls).toHaveLength(0);
    expect(t.s.approvals.get(id, u.id)?.status).toBe('superseded');
    const next = t.s.approvals.listPending(u.id);
    expect(next).toHaveLength(1);
    expect(next[0]!.warnings.join(' ')).toContain('draft_changed');
    expect(JSON.stringify(t.tg.byMethod('sendRichMessage').at(-1))).toMatch(/draft(\\\\)?_changed/);
  });

  it('deny and expiry produce conv_events', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const c = dm(w, u);
    const id1 = await propose(w, t, u, c, 'toolu_1');
    await t.settle();
    const deny = t.lastCard().buttons.find((b) => b.callback_data?.startsWith(`a1:${id1}:n`))!.callback_data!;
    await tapAs(t, deny, u.tgUserId);
    const id2 = await propose(w, t, u, c, 'toolu_2', 'anna@x.com', 2);
    await t.advance(25 * 3_600_000);
    const events = w.repos.inputs.takeEvents(c.conv.id, 'r').join('\n');
    expect(events).toContain(`${id1} (gmail_send_draft) denied`);
    expect(events).toContain(`${id2} (gmail_send_draft) expired`);
    expect(t.s.approvals.get(id2, u.id)?.status).toBe('expired');
    expect(w.calls).toHaveLength(0);
  });

  it('a mission that waits on the approval is woken with the result', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const c = dm(w, u, 'mission');
    const out = await t.s.executor.processRound(
      c.run, c.conv, 1,
      [...tu('toolu_1', 'gmail_send_draft', { to: 'anna@x.com', subject: 'R', body: 'B' })],
      null as never, sig(),
    );
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    const wait = await t.s.executor.processRound(c.run, c.conv, 2, tu('toolu_w', 'task_wait', { on: [`approval:${id}`], timeout_hours: 48 }), null as never, sig());
    expect(wait.park?.wakeOn).toEqual([`approval:${id}`]);
    expect(wait.park?.wakeAt).toBe(t.clock.now() + 48 * 3_600_000); // missions are not capped at 24 h
    w.repos.runs.park(c.run.id, wait.park!.wakeOn, wait.park!.wakeAt);
    await t.settle();
    const data = t.lastCard().buttons.find((b) => b.callback_data?.startsWith(`a1:${id}:y`))!.callback_data!;
    await tapAs(t, data, u.tgUserId);
    expect(w.runner.wakes).toEqual([`approval:${id}`]);
    expect(w.calls).toHaveLength(1);
  });
});
