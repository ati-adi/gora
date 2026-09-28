// http/routes/tasks.ts (WP8) — Tasks screen (01 §12):
//   GET    /api/tasks                                         read   missions, watchers, reminders, to-dos
//   POST   /api/missions/:id/stop                             write
//   POST   /api/missions/:id/budget {usd}                     write
//   PATCH  /api/reminders/:id {atLocal?, cron?, status?}      write  reschedule / pause / resume / cancel
//   DELETE /api/reminders/:id                                 write  cancel
//   PATCH  /api/watchers/:id {action}                         write  pause / resume / cancel
//   PATCH  /api/todos/:id {done}                              write  idempotent (todos.setDone)
// Ownership: missions through missions.list(userId); reminders and to-dos through the user's scope; watchers by userId.
import { z } from 'zod';
import type { Services } from '../../contracts/index.ts';
import { auth, body, err, errName, fresh, isNotFoundish, safely, userScope, type Api, type Ctx } from '../util.ts';

const Budget = z.object({ usd: z.number().positive().max(100) });
const ReminderPatch = z.object({
  // 'YYYY-MM-DDTHH:mm' (seconds, if sent, are dropped: reminders take minute precision)
  atLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).optional(),
  cron: z.string().min(9).max(120).optional(),
  status: z.enum(['paused', 'active', 'cancelled']).optional(),
}).refine((v) => v.atLocal !== undefined || v.cron !== undefined || v.status !== undefined, 'nothing to change');
const WatcherPatch = z.object({ action: z.enum(['pause', 'resume', 'cancel']) });
const TodoPatch = z.object({ done: z.boolean() });

const idOk = (id: string) => /^[A-Za-z0-9_:-]{1,128}$/.test(id);

/** Service error codes that describe a bad request (ReminderError: a past or malformed time, a bad cron, a wrong state). */
const CLIENT_CODES: ReadonlySet<string> = new Set(['past', 'bad_time', 'bad_cron', 'bad_tz', 'bad_input', 'bad_state']);

/** A service error carrying a client-side `code` (duck-typed: the route does not import service internals). */
function clientCode(x: unknown): { status: 409 | 422 | 429; code: string } | null {
  if (!(x instanceof Error)) return null;
  const code = (x as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  if (CLIENT_CODES.has(code)) return { status: 422, code };
  if (code === 'too_many') return { status: 409, code };
  if (code === 'rate_limited') return { status: 429, code };
  return null;
}

/**
 * Runs a mutating service call; a "not found / not yours" failure becomes 404, a coded client error (bad time, past,
 * bad cron, …) 422/409/429 with its code, anything else propagates (→ 500).
 */
async function guarded<T>(s: Services, c: Ctx, what: string, fn: () => T | Promise<T>): Promise<{ ok: true; v: T } | { ok: false; res: Response }> {
  try {
    return { ok: true, v: await fn() };
  } catch (x) {
    const cc = clientCode(x);
    if (cc) return { ok: false, res: err(c, cc.status, cc.code) };
    if (isNotFoundish(x)) return { ok: false, res: err(c, 404, 'not_found') };
    s.log.warn({ mod: 'http', what, err: errName(x) }, 'miniapp: task action failed');
    throw x;
  }
}

export function registerTasks(api: Api, s: Services): void {
  api.get('/tasks', (c) => {
    const { user } = auth(c);
    const scope = userScope(user);
    return c.json({
      missions: safely(s, 'missions.list', () => s.missions.list(user.id), []),
      watchers: safely(s, 'watchers.list', () => s.watchers.list(user.id), []).filter((w) => w.status !== 'cancelled'),
      reminders: safely(s, 'reminders.list', () => s.reminders.list(scope, false), []),
      todos: safely(s, 'todos.list', () => s.todos.apply(scope, user.id, { action: 'list' }), []),
      tz: user.tz,
    });
  });

  const ownsMission = (userId: string, id: string) => safely(s, 'missions.list', () => s.missions.list(userId).some((m) => m.id === id), false);

  api.post('/missions/:id/stop', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id) || !ownsMission(user.id, id)) return err(c, 404, 'not_found');
    const r = await guarded(s, c, 'missions.stop', () => s.missions.stop(id, user.tgUserId));
    if (!r.ok) return r.res;
    return c.json({ ok: true, mission: s.missions.get(id) ?? null });
  });

  api.post('/missions/:id/budget', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id) || !ownsMission(user.id, id)) return err(c, 404, 'not_found');
    const b = await body(c, Budget);
    if (!b.ok) return b.res;
    const r = await guarded(s, c, 'missions.addBudget', () => s.missions.addBudget(id, b.data.usd));
    if (!r.ok) return r.res;
    return c.json({ ok: true, mission: s.missions.get(id) ?? null });
  });

  api.patch('/reminders/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const b = await body(c, ReminderPatch);
    if (!b.ok) return b.res;
    const scope = userScope(user);
    const r = await guarded(s, c, 'reminders.manage', () => {
      let v = undefined as ReturnType<typeof s.reminders.manage> | undefined;
      if (b.data.status === 'cancelled') return s.reminders.manage(id, scope, 'cancel');
      if (b.data.atLocal !== undefined || b.data.cron !== undefined) {
        v = s.reminders.manage(id, scope, 'reschedule', { ...(b.data.atLocal ? { atLocal: b.data.atLocal.replace(' ', 'T').slice(0, 16) } : {}), ...(b.data.cron ? { cron: b.data.cron } : {}) });
      }
      if (b.data.status === 'paused') v = s.reminders.manage(id, scope, 'pause');
      if (b.data.status === 'active') v = s.reminders.manage(id, scope, 'resume');
      return v!;
    });
    if (!r.ok) return r.res;
    return c.json({ reminder: r.v });
  });

  api.delete('/reminders/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const r = await guarded(s, c, 'reminders.manage', () => s.reminders.manage(id, userScope(user), 'cancel'));
    if (!r.ok) return r.res;
    return c.json({ reminder: r.v });
  });

  api.patch('/watchers/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const b = await body(c, WatcherPatch);
    if (!b.ok) return b.res;
    if (!safely(s, 'watchers.list', () => s.watchers.list(user.id).some((w) => w.id === id), false)) return err(c, 404, 'not_found');
    const r = await guarded(s, c, 'watchers.manage', () => s.watchers.manage(id, user.id, b.data.action));
    if (!r.ok) return r.res;
    return c.json({ watcher: s.watchers.list(user.id).find((w) => w.id === id) ?? null });
  });

  api.patch('/todos/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const b = await body(c, TodoPatch);
    if (!b.ok) return b.res;
    const scope = userScope(user);
    if (!safely(s, 'todos.list', () => s.todos.apply(scope, user.id, { action: 'list' }).some((t) => t.id === id), false)) return err(c, 404, 'not_found');
    const r = await guarded(s, c, 'todos.setDone', () => s.todos.setDone(id, scope, b.data.done));
    if (!r.ok) return r.res;
    return c.json({ todos: r.v });
  });
}
