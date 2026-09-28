// http/routes/connections.ts (WP8) — Connections screen (01 §12, F9, §11.2):
//   GET    /api/connections                         read   Gmail/Calendar status + level, grants, trusted contacts
//   POST   /api/connections/:kind/link              write  → {url} (IntegrationService.startConnect; the OAuth return
//                                                          lands in the DM)
//   PATCH  /api/connections/:kind {level}           write  Read only / Read + drafts / Can propose sends
//   DELETE /api/connections/:kind                   write  disconnect (provider revoke)
//   GET    /api/trusted-targets                     read
//   POST   /api/trusted-targets {kind, value}       write  source 'miniapp'
//   DELETE /api/trusted-targets/:hmac               write
import { z } from 'zod';
import type { IntegrationKind, Services } from '../../contracts/index.ts';
import { auth, body, err, fresh, ledger, safely, type Api } from '../util.ts';

const KINDS: readonly IntegrationKind[] = ['gmail', 'gcal'];
const Level = z.object({ level: z.enum(['read', 'draft', 'act']) });
const AddTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), value: z.email().max(320) }),
  z.object({ kind: z.literal('gcal_attendee'), value: z.email().max(320) }),
  z.object({ kind: z.literal('tg_chat'), value: z.string().trim().regex(/^(@[A-Za-z0-9_]{4,32}|-?\d{1,20})$/) }),
]);

const kindOf = (k: string): IntegrationKind | null => (KINDS as readonly string[]).includes(k) ? (k as IntegrationKind) : null;

export function registerConnections(api: Api, s: Services): void {
  const trusted = (userId: string) => safely(s, 'trustedTargets.list', () => s.trustedTargets.list(userId), [])
    .map((t) => ({ hmac: t.hmac, kind: t.kind, value: t.value, source: t.source, createdAt: t.createdAt }));

  api.get('/connections', (c) => {
    const { user } = auth(c);
    const now = s.clock.now();
    const status = safely(s, 'integrations.status', () => s.integrations.status(user.id), null);
    return c.json({
      provider: safely(s, 'integrations.provider', () => s.integrations.provider?.name ?? null, null),
      integrations: KINDS.map((k) => ({ kind: k, connected: status?.[k].connected ?? false, level: status?.[k].level ?? 'none' })),
      grants: safely(s, 'grants.list', () => s.grants.list(user.id), []).filter((g) => g.expiresAt === null || g.expiresAt > now)
        .map((g) => ({ id: g.id, toolName: g.toolName, scope: g.scope, expiresAt: g.expiresAt })),
      trusted: trusted(user.id),
    });
  });

  api.post('/connections/:kind/link', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const kind = kindOf(c.req.param('kind'));
    if (!kind) return err(c, 404, 'not_found');
    if (!s.integrations.provider) return err(c, 503, 'integrations_disabled');
    const r = await s.integrations.startConnect(user.id, kind, { chatId: user.dmChatId ?? user.tgUserId });
    return c.json({ url: r.url });
  });

  api.patch('/connections/:kind', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const kind = kindOf(c.req.param('kind'));
    if (!kind) return err(c, 404, 'not_found');
    const b = await body(c, Level);
    if (!b.ok) return b.res;
    const before = s.repos.users.permissions(user.id)[kind];
    s.repos.users.setPermission(user.id, kind, b.data.level, 'miniapp');
    if (before !== b.data.level) ledger(s, { userId: user.id, actor: 'user', kind: 'permission_change', summary: `${kind === 'gmail' ? 'Gmail' : 'Calendar'} level: ${before} → ${b.data.level}`, detail: { integration: kind, from: before, to: b.data.level, via: 'miniapp' } });
    return c.json({ kind, level: b.data.level });
  });

  api.delete('/connections/:kind', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const kind = kindOf(c.req.param('kind'));
    if (!kind) return err(c, 404, 'not_found');
    await s.integrations.revoke(user.id, kind);
    return c.json({ ok: true });
  });

  api.get('/trusted-targets', (c) => c.json({ items: trusted(auth(c).user.id) }));

  api.post('/trusted-targets', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, AddTarget);
    if (!b.ok) return b.res;
    const value = b.data.kind === 'tg_chat' ? b.data.value : b.data.value.trim().toLowerCase();
    s.trustedTargets.add(user.id, { kind: b.data.kind, value, source: 'miniapp' });
    ledger(s, { userId: user.id, actor: 'user', kind: 'settings', summary: 'Trusted contact added (Mini App)', detail: { kind: b.data.kind } });
    return c.json({ items: trusted(user.id) });
  });

  api.delete('/trusted-targets/:hmac', (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const h = c.req.param('hmac');
    if (!/^[0-9a-f]{16,128}$/i.test(h)) return err(c, 404, 'not_found');
    if (!s.trustedTargets.remove(user.id, h)) return err(c, 404, 'not_found');
    ledger(s, { userId: user.id, actor: 'user', kind: 'settings', summary: 'Trusted contact removed (Mini App)' });
    return c.json({ items: trusted(user.id) });
  });
}
