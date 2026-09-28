// WP7b tools (01 §6): business_draft_reply (send_external · 2, integration business, never grantable, Inbox card,
// expiry = window end, source refs for voidBySourceRef), business_list_chats (consented only) and business_read_chat
// (consented only, taints business_peer, ledger data_read).
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCtx, ToolSpec, UserRow } from '../../../src/contracts/index.ts';
import { TOOL_OWNERS } from '../../../src/contracts/index.ts';
import { TOOLS } from '../../../src/surfaces/business/tools.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER, U } from '../../harness/updates.ts';

const REF = 'bc:bc_1:1002';
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const tool = (name: string): ToolSpec => TOOLS.find((x) => x.name === name)!;

function ctx(a: TestApp, u: UserRow, o: Partial<ToolCtx> = {}): ToolCtx {
  return {
    toolUseId: 'toolu_x', runId: 'run_x', conversationId: 'conv_x', epoch: 1, userId: u.id, tgUserId: u.tgUserId, surface: 'dm',
    scope: { kind: 'user', userId: u.id }, tz: 'UTC', lang: 'en', now: a.clock.now(), chat: { chatId: u.tgUserId }, taint: new Set(),
    signal: new AbortController().signal, effects: { push() {} }, services: a.s, log: a.s.log, idemKey: 'toolu_x', priority: 'interactive', ...o,
  };
}

async function world(): Promise<{ t: TestApp; u: UserRow }> {
  t = await createTestApp();
  await t.send(U.businessConnection());
  const u = t.s.repos.users.getByTg(TEST_USER.id)!;
  await t.send(U.businessMessage('not consented chat', { chatId: 2000 }));
  await t.s.business.setChatAi(u.id, REF, true, 'miniapp');
  await t.send(U.businessMessage('Can we meet at 5?', { messageId: 71 }));
  await t.send(U.businessMessage('Sure, let me check', { messageId: 72, from: 'owner' }));
  await t.send(U.businessMessage('Waiting for your answer', { messageId: 73 }));
  return { t, u };
}

describe('business tools', () => {
  it('exports exactly the WP7b tools of TOOL_OWNERS', () => {
    const mine = Object.entries(TOOL_OWNERS).filter(([, o]) => o === 'WP7b').map(([n]) => n).sort();
    expect(TOOLS.map((x) => x.name).sort()).toEqual(mine);
    for (const s of TOOLS) expect(s.surfaces).not.toContain('group');
    for (const s of TOOLS) expect(s.surfaces).not.toContain('guest');
    expect(tool('business_draft_reply').surfaces).toContain('biz_draft');
    expect(tool('business_draft_reply').eagerInput).toBe(true);
    expect(tool('business_draft_reply').renderDiff).toBeTypeOf('function');
  });

  it('business_draft_reply: classification, diff, card placement, expiry and source refs', async () => {
    const { t, u } = await world();
    const spec = tool('business_draft_reply');
    const c = ctx(t, u);
    const input = spec.input.parse({ chat_ref: REF, text: 'Yes, 5 works!' });
    expect(spec.classify(input, c)).toEqual({ actionClass: 'send_external', risk: 2, integration: 'business', grantable: false, businessRef: { connectionId: 'bc_1', chatId: 1002 } });
    expect(spec.classify({ chat_ref: 'garbage', text: 'x' }, c)).toMatchObject({ integration: 'business', businessRef: { connectionId: '', chatId: 0 } });
    const targets = await spec.targets!(input, c);
    expect(targets).toEqual([expect.objectContaining({ kind: 'biz_chat', value: REF, provenance: 'business_chat', hmac: t.s.crypto.hmac('target', `biz_chat:${REF}`) })]);
    const diff = await spec.renderDiff!(input, c);
    expect(diff.title).toBe('Reply to Anna');
    expect(diff.rows).toEqual([['To', 'Anna'], ['Their last message', 'Waiting for your answer']]);
    expect(diff.body).toEqual({ label: 'Draft', text: 'Yes, 5 works!' });
    const meta = await spec.approvalMeta!(input, c);
    expect(meta.card!.chatId).toBe(TEST_USER.id);
    expect(meta.card!.threadId).toBeTruthy(); // 📥 Inbox
    expect(meta.expiresAt).toBe(t.s.business.context(u.id, REF)!.windowExpiresAt);
    expect(meta.sourceRefs).toEqual(expect.arrayContaining(['bizchat:bc_1:1002', 'bizmsg:bc_1:1002:71', 'bizmsg:bc_1:1002:72', 'bizmsg:bc_1:1002:73']));
    expect(spec.input.safeParse({ chat_ref: REF, text: '' }).success).toBe(false);
    expect(spec.input.safeParse({ chat_ref: REF, text: 'x'.repeat(4097) }).success).toBe(false);
  });

  it('business_draft_reply execute sends through the business connection and maps refusals', async () => {
    const { t, u } = await world();
    const spec = tool('business_draft_reply');
    const out = await spec.execute({ chat_ref: REF, text: 'On my way', reply_to_message_id: 71 }, ctx(t, u, { idemKey: 'pa:ABC123' }));
    expect(out.isError).toBeFalsy();
    const sent = t.tg.byMethod('sendMessage').filter((p) => p.business_connection_id === 'bc_1');
    expect(sent).toEqual([expect.objectContaining({ chat_id: 1002, text: 'On my way', reply_parameters: expect.objectContaining({ message_id: 71 }) })]);
    const denied = await spec.execute({ chat_ref: 'bc:bc_1:2000', text: 'x' }, ctx(t, u, { idemKey: 'pa:ABC124' }));
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('NOT_CONSENTED');
  });

  it('business_list_chats lists consented chats only', async () => {
    const { t, u } = await world();
    const out = await tool('business_list_chats').execute(tool('business_list_chats').input.parse({ filter: 'all' }), ctx(t, u));
    const chats = (out.data as Array<{ chat_ref: string; name: string; reply_window_open: boolean }>);
    expect(chats.map((c) => c.chat_ref)).toEqual([REF]);
    expect(chats[0]).toMatchObject({ name: 'Anna', reply_window_open: true });
    expect(out.content).not.toContain('2000');
  });

  it('business_read_chat: denied when not consented; otherwise owner lines marked, output tainted business_peer, ledger data_read', async () => {
    const { t, u } = await world();
    const spec = tool('business_read_chat');
    expect(spec.outputTaint).toBe('business_peer');
    expect(spec.classify(spec.input.parse({ chat_ref: 'bc:bc_1:2000' }), ctx(t, u))).toMatchObject({ actionClass: 'read_private', integration: 'business', businessRef: { connectionId: 'bc_1', chatId: 2000 } });
    const no = await spec.execute(spec.input.parse({ chat_ref: 'bc:bc_1:2000' }), ctx(t, u));
    expect(no.isError).toBe(true);
    expect(no.content).not.toContain('not consented chat');
    const ok = await spec.execute(spec.input.parse({ chat_ref: REF, limit: 30 }), ctx(t, u));
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain('[owner] Sure, let me check');
    expect(ok.content).toContain('[Anna] Can we meet at 5?');
    expect(ok.untrusted).toEqual({ source: 'business_peer', label: 'business chat' });
    expect(ok.ledger).toEqual([expect.objectContaining({ kind: 'data_read' })]);
  });
});
