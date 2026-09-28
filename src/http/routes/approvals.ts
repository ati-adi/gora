// http/routes/approvals.ts (WP8) — Approvals / ApprovalDetail (01 §12):
//   GET  /api/approvals?status=pending            read   PendingActionView[]
//   GET  /api/approvals/:id                        read   PendingActionView (any status; 404 when missing or not yours)
//   POST /api/approvals/:id {decision, scope, editedFields?}   write → approvals.resolve (the same CAS path as the card)
import { z } from 'zod';
import type { PendingActionView, Services } from '../../contracts/index.ts';
import { auth, body, err, fresh, safely, type Api } from '../util.ts';

const Resolve = z.object({
  decision: z.enum(['approve', 'deny']),
  scope: z.enum(['once', '24h']).default('once'),
  editedFields: z.record(z.string().max(64), z.union([z.string().max(20_000), z.array(z.string().max(320)).max(20)])).optional(),
});

const idOk = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

export function viewOut(v: PendingActionView) {
  return {
    id: v.id, toolName: v.toolName, title: v.title, summary: v.summary, rows: v.rows, body: v.body ?? null, warnings: v.warnings,
    status: v.status, expiresAt: v.expiresAt, grantable: v.grantable, ladderOffer: v.ladderOffer, editableFields: v.editableFields,
    targets: v.targets,
  };
}

/** resolve() status → HTTP status. Success and "already handled" are 200 so the client can show the message. */
function httpStatus(st: string): 200 | 403 | 404 | 422 {
  if (st === 'forbidden') return 403;
  if (st === 'not_found') return 404;
  if (st === 'invalid') return 422;
  return 200;
}

export function registerApprovals(api: Api, s: Services): void {
  api.get('/approvals', (c) => {
    const { user } = auth(c);
    const status = c.req.query('status') ?? 'pending';
    if (status !== 'pending') return err(c, 400, 'unsupported_status');
    const items = safely(s, 'approvals.listPending', () => s.approvals.listPending(user.id), []);
    return c.json({ items: items.map(viewOut) });
  });

  api.get('/approvals/:id', (c) => {
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const v = s.approvals.get(id, user.id);
    if (!v) return err(c, 404, 'not_found');
    return c.json({ item: viewOut(v) });
  });

  api.post('/approvals/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const b = await body(c, Resolve);
    if (!b.ok) return b.res;
    const v = s.approvals.get(id, user.id);
    if (!v) return err(c, 404, 'not_found');
    // Only the fields the card declares editable may change; anything else is dropped (never forwarded to the tool).
    let editedInput: Record<string, unknown> | undefined;
    if (b.data.decision === 'approve' && b.data.editedFields) {
      const allowed = new Set(v.editableFields);
      const picked = Object.entries(b.data.editedFields).filter(([k]) => allowed.has(k));
      if (picked.length > 0) editedInput = Object.fromEntries(picked);
    }
    const r = await s.approvals.resolve(id, {
      decision: b.data.decision, scope: b.data.scope, byTgId: user.tgUserId, via: 'miniapp',
      ...(editedInput ? { editedInput } : {}),
    });
    const after = s.approvals.get(id, user.id);
    return c.json({ status: r.status, message: r.message, item: after ? viewOut(after) : null }, httpStatus(r.status));
  });
}
