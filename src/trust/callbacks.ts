// trust/callbacks.ts (WP4) — the a1: (approval) and ud: (undo) callbacks, and the approval_expire job.
// The codec (WP2) has already verified the MAC and that from.id is the owner before dispatch; the dispatcher calls
// answerCallbackQuery exactly once with the returned answer. approvals.resolve re-checks ownership against the row.
import type { CallbackAnswer, CallbackCtx, Services } from '../contracts/index.ts';
import type { ApprovalsImpl } from './approvals.ts';

export const EXPIRE_SWEEP_CRON = '*/5 * * * *';

export async function handleApprovalCallback(s: Services, c: CallbackCtx): Promise<CallbackAnswer> {
  const [id, yn, od] = c.parts;
  if (!id || (yn !== 'y' && yn !== 'n')) return { text: 'Malformed button' };
  const r = await s.approvals.resolve(id, { decision: yn === 'y' ? 'approve' : 'deny', scope: yn === 'y' && od === 'd' ? '24h' : 'once', byTgId: c.fromTgId, via: 'callback' });
  return { text: r.message.slice(0, 190), ...(r.status === 'forbidden' ? { alert: true } : {}) };
}

export async function handleUndoCallback(s: Services, c: CallbackCtx): Promise<CallbackAnswer> {
  const [id] = c.parts;
  if (!id) return { text: 'Malformed button' };
  const r = await s.undo.undo(id, c.fromTgId);
  if (r.ok && c.message) {
    try {
      s.telegram.outbox.enqueue({ idempotencyKey: `ud:markup:${id}`, chatId: c.message.chatId, method: 'editMessageReplyMarkup', payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: [] } } });
    } catch {
      /* the button stays; a second tap answers "Undone" again */
    }
  }
  return { text: r.message.slice(0, 190) };
}

/** Factory-time registrations (04 §3 timing rule). */
export function registerTrustHandlers(s: Services, approvals: () => ApprovalsImpl): void {
  s.telegram.callbacks.register('a1', (c) => handleApprovalCallback(s, c));
  s.telegram.callbacks.register('ud', (c) => handleUndoCallback(s, c));
  s.scheduler.register('approval_expire', async (_job, ctx) => {
    await approvals().service.expireDue(ctx.now);
    return { status: 'done' };
  });
  s.scheduler.schedule({ kind: 'approval_expire', runAt: s.clock.now() + 60_000, cron: EXPIRE_SWEEP_CRON, tz: 'UTC', dedupeKey: 'sys:approval_expire', maxAttempts: 3 });
}
