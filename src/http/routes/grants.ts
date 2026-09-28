// http/routes/grants.ts (WP8) — grants (01 §11.1, §12):
//   GET    /api/grants                               read
//   DELETE /api/grants/:id                           write
//   POST   /api/grants {pendingActionId, stepupGrantId}   high → an `always` grant (S16 eligibility re-checked by WP4;
//          the step-up grant is consumed there). Only reachable after /api/stepup/verify or /api/stepup/phrase.
import { z } from 'zod';
import type { Services } from '../../contracts/index.ts';
import { auth, body, err, fresh, safely, type Api } from '../util.ts';

const CreateAlways = z.object({ pendingActionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), stepupGrantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export function registerGrants(api: Api, s: Services): void {
  api.get('/grants', (c) => {
    const { user } = auth(c);
    const now = s.clock.now();
    const items = safely(s, 'grants.list', () => s.grants.list(user.id), [])
      .filter((g) => g.expiresAt === null || g.expiresAt > now)
      .map((g) => ({ id: g.id, toolName: g.toolName, scope: g.scope, expiresAt: g.expiresAt, target: g.targetHmac.slice(0, 8) }));
    return c.json({ items });
  });

  api.delete('/grants/:id', (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return err(c, 404, 'not_found');
    if (!s.grants.revoke(user.id, id)) return err(c, 404, 'not_found');
    return c.json({ ok: true });
  });

  api.post('/grants', async (c) => {
    const stale = fresh(s, c, 'high');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, CreateAlways);
    if (!b.ok) return b.res;
    const r = await s.grants.createAlways(user.id, b.data.pendingActionId, b.data.stepupGrantId);
    if ('error' in r) {
      if (r.error === 'not_found') return err(c, 404, 'not_found');
      if (r.error === 'stepup_invalid') return err(c, 403, 'stepup_invalid');
      return err(c, 409, 'not_eligible');
    }
    return c.json({ id: r.id });
  });
}
