// WP5 — gmail_* (01 §6, F9): two-phase email, renderDiff hashing, reconcile via findSent, undo, untrusted output.
import { describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../../src/contracts/index.ts';
import { GMAIL_TOOLS } from '../../../src/tools/impl/gmail.ts';
import { createToolEnv } from './env.ts';

const T = (n: string) => GMAIL_TOOLS.find((t) => t.name === n) as ToolSpec;

describe('gmail tools', () => {
  it('search and read are read_private, tainted email, untrusted output', async () => {
    const env = createToolEnv();
    const s = T('gmail_search');
    expect(s.classify(s.input.parse({ query: 'x' }), env.ctx())).toMatchObject({ actionClass: 'read_private', integration: 'gmail', requiredLevel: 'read' });
    expect(s.outputTaint).toBe('email');
    const out = await env.run(s, { query: 'contract', newer_than_days: 7 });
    expect(out.untrusted?.source).toBe('email');
    const threads = JSON.parse(out.content).threads;
    expect(threads).toHaveLength(1);
    const read = await env.run(T('gmail_read_thread'), { thread_id: threads[0].thread_id });
    expect(read.untrusted?.source).toBe('email');
    expect(JSON.parse(read.content).messages[0].text).toContain('contract draft');
    expect((await env.run(T('gmail_read_thread'), { thread_id: 'nope' })).isError).toBe(true);
  });

  it('create_draft: write_self (draft level), eager input, idempotent per key, Undo deletes it', async () => {
    const env = createToolEnv();
    const d = T('gmail_create_draft');
    expect(d.eagerInput).toBe(true);
    expect(d.classify(d.input.parse({ to: ['a@example.com'], subject: 's', body: 'b' }), env.ctx())).toMatchObject({ actionClass: 'write_self', risk: 1, requiredLevel: 'draft' });
    expect(() => d.input.parse({ to: ['not an email'], subject: 's', body: 'b' })).toThrow();
    const ctx = env.ctx({ idemKey: 'toolu_same' });
    const a = await env.run(d, { to: ['anna@example.com'], subject: 'Re: contract', body: 'Thursday works.' }, ctx);
    const b = await env.run(d, { to: ['anna@example.com'], subject: 'Re: contract', body: 'Thursday works.' }, ctx);
    expect(JSON.parse(a.content).draft_id).toBe(JSON.parse(b.content).draft_id);
    expect(env.provider.drafts(env.user.id)).toHaveLength(1);
    expect(a.ledger?.[0]?.kind).toBe('draft_created');
    await d.undo!(a.undo!.payload, env.ctx());
    expect(env.provider.drafts(env.user.id)).toHaveLength(0);
  });

  it('send_draft: send_external (act); renderDiff fetches the draft and changes when it changes; bulk warning', async () => {
    const env = createToolEnv();
    const send = T('gmail_send_draft');
    expect(send.classify({ draft_id: 'x' }, env.ctx())).toMatchObject({ actionClass: 'send_external', risk: 2, requiredLevel: 'act' });
    const mail = env.s.integrations.mail(env.user.id)!;
    const { draftId } = await mail.createDraft({ to: ['anna@example.com'], cc: ['b@example.com'], subject: 'Hello', body: 'Body v1' }, 'k1');
    const d1 = await send.renderDiff!({ draft_id: draftId }, env.ctx());
    expect(d1.rows).toEqual(expect.arrayContaining([['To', 'anna@example.com'], ['Cc', 'b@example.com'], ['Subject', 'Hello']]));
    expect(d1.body).toEqual({ label: 'Body', text: 'Body v1' });
    expect(d1.targets.map((t) => t.value)).toEqual(['anna@example.com', 'b@example.com']);
    expect(await send.renderDiff!({ draft_id: draftId }, env.ctx())).toEqual(d1);
    // the draft changes between approval and execution → a different diff (the executor supersedes the card)
    await mail.deleteDraft(draftId);
    const { draftId: id2 } = await mail.createDraft({ to: ['x1@e.com', 'x2@e.com', 'x3@e.com', 'x4@e.com', 'x5@e.com', 'x6@e.com'], cc: [], subject: 'Hello', body: 'Body v2' }, 'k2');
    const d2 = await send.renderDiff!({ draft_id: id2 }, env.ctx());
    expect(d2.rows.find((r) => r[0] === 'Hash')?.[1]).not.toBe(d1.rows.find((r) => r[0] === 'Hash')?.[1]);
    expect(d2.warnings.join(' ')).toMatch(/Bulk/);
  });

  it('send_draft executes once; reconcile finds it in Sent (and never re-sends)', async () => {
    const env = createToolEnv();
    const send = T('gmail_send_draft');
    const mail = env.s.integrations.mail(env.user.id)!;
    const { draftId } = await mail.createDraft({ to: ['anna@example.com'], cc: [], subject: 'Hi Anna', body: 'See you' }, 'k1');
    const ctx = env.ctx({ idemKey: 'pa:QWE123' });
    expect(await send.reconcile!({ draft_id: draftId }, ctx)).toBe('not_done');
    const out = await env.run(send, { draft_id: draftId }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.ledger?.[0]?.kind).toBe('email_sent');
    expect(env.provider.sentMail(env.user.id)).toHaveLength(1);
    expect(await send.reconcile!({ draft_id: draftId }, ctx)).toBe('done');
    const again = await env.run(send, { draft_id: draftId }, ctx);
    expect(again.isError).toBe(true);
    expect(env.provider.sentMail(env.user.id)).toHaveLength(1);
    expect(await send.reconcile!({ draft_id: 'unknown' }, env.ctx({ idemKey: 'pa:ZZZ999' }))).toBe('unknown');
  });

  it('not connected → NOT_CONNECTED', async () => {
    const env = createToolEnv({ connected: { gmail: false } });
    const out = await env.run(T('gmail_search'), { query: 'x' });
    expect(out.content).toContain('NOT_CONNECTED');
  });
});
