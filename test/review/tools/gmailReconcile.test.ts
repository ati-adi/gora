// REVIEW (tools): gmail_send_draft.reconcile() declares "done" for a draft that was never sent whenever the owner sent
// any earlier mail with the same To + Subject in the last 7 days (e.g. a weekly report, or "Re: …" follow-ups).
// It searches Sent with afterMs = ctx.now - 7 days instead of the moment the send was attempted, and it ignores the
// strongest evidence it already fetched: the draft still exists (Gmail deletes a draft once it is sent).
// Consequence: after a crash/throw between rememberSend() and sendDraft(), the executor records the approved send as
// 'executed' (or "Done (completed before a restart)") and the email is silently never sent.
import { describe, expect, it } from 'vitest';
import { GMAIL_TOOLS } from '../../../src/tools/impl/gmail.ts';
import { createToolEnv } from '../../unit/tools/env.ts';

const send = GMAIL_TOOLS.find((t) => t.name === 'gmail_send_draft')!;
const draft = GMAIL_TOOLS.find((t) => t.name === 'gmail_create_draft')!;

describe('gmail_send_draft reconcile', () => {
  it('does not report an unsent draft as sent just because an older mail had the same To+Subject', async () => {
    const env = createToolEnv();
    const mail = env.provider.mail(env.user.id, 'ref');
    // Last week's report, really sent.
    const old = await mail.createDraft({ to: ['boss@example.com'], cc: [], subject: 'Weekly report', body: 'week 38' }, 'k-old');
    await mail.sendDraft(old.draftId);
    env.clock.advance(3 * 86_400_000);
    // This week's report: drafted and approved, but the process died before sendDraft reached Gmail.
    const out = await env.run(draft, { to: ['boss@example.com'], subject: 'Weekly report', body: 'week 39' });
    const draftId = (out.data as { draftId: string }).draftId;
    const ctx = env.ctx({ idemKey: 'pa:crash' });
    const verdict = await send.reconcile!({ draft_id: draftId }, ctx);
    // The draft still exists and nothing new is in Sent, so this must not be 'done'.
    expect(env.provider.sentMail(env.user.id)).toHaveLength(1);
    expect(env.provider.drafts(env.user.id).some((d) => d.draftId === draftId)).toBe(true);
    expect(verdict).not.toBe('done');
  });
});
