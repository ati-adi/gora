// http/routes/secretary.ts (WP8) — Secretary screen (01 §12, F12, §10.2):
//   GET   /api/secretary                                          read   connection, rights, AI default, chats, consent version
//   PATCH /api/secretary {aiDefault}                              write; `new_chats` is consent → high
//   PATCH /api/secretary/chats/:ref {aiEnabled?, mode?, toneNotes?}   write; aiEnabled=true is consent → high
// Consent itself (business_llm, per chat) is recorded by WP7b inside setChatAi/setDefault (via 'miniapp').
import { z } from 'zod';
import type { Services } from '../../contracts/index.ts';
import { auth, body, err, fresh, safely, type Api } from '../util.ts';

const DefaultPatch = z.object({ aiDefault: z.enum(['off', 'new_chats']) });
const ChatPatch = z.object({
  aiEnabled: z.boolean().optional(),
  mode: z.enum(['triage', 'draft']).optional(),
  toneNotes: z.string().trim().max(500).nullable().optional(),
}).refine((v) => v.aiEnabled !== undefined || v.mode !== undefined || v.toneNotes !== undefined, 'nothing to change');

const refOk = (r: string) => /^bc:[A-Za-z0-9_-]{1,128}:-?\d{1,20}$/.test(r);

export function registerSecretary(api: Api, s: Services): void {
  const chats = (userId: string) => safely(s, 'business.listChats', () => s.business.listChats(userId, 'all', 200), []);

  api.get('/secretary', (c) => {
    const { user } = auth(c);
    if (!s.config.features.business) return c.json({ enabled: false, connection: null, chats: [] });
    const conn = safely(s, 'business.connection', () => s.business.connection(user.id), null);
    return c.json({
      enabled: true,
      connection: conn ? { enabled: conn.enabled, canReply: conn.canReply, aiDefault: conn.aiDefault, connectedAt: conn.connectedAt, consentTextVersion: conn.consentTextVersion } : null,
      chats: conn ? chats(user.id) : [],
    });
  });

  api.patch('/secretary', async (c) => {
    const { user } = auth(c);
    if (!s.config.features.business) return err(c, 404, 'business_disabled');
    const b = await body(c, DefaultPatch);
    if (!b.ok) return b.res;
    const stale = fresh(s, c, b.data.aiDefault === 'new_chats' ? 'high' : 'write');
    if (stale) return stale;
    if (!s.business.connection(user.id)) return err(c, 404, 'not_connected');
    await s.business.setDefault(user.id, b.data.aiDefault, 'miniapp');
    return c.json({ aiDefault: b.data.aiDefault });
  });

  api.patch('/secretary/chats/:ref', async (c) => {
    const { user } = auth(c);
    if (!s.config.features.business) return err(c, 404, 'business_disabled');
    const ref = c.req.param('ref');
    if (!refOk(ref)) return err(c, 404, 'not_found');
    const b = await body(c, ChatPatch);
    if (!b.ok) return b.res;
    const stale = fresh(s, c, b.data.aiEnabled === true ? 'high' : 'write');
    if (stale) return stale;
    if (!chats(user.id).some((ch) => ch.ref === ref)) return err(c, 404, 'not_found');
    if (b.data.aiEnabled !== undefined) await s.business.setChatAi(user.id, ref, b.data.aiEnabled, 'miniapp');
    if (b.data.mode !== undefined || b.data.toneNotes !== undefined) {
      await s.business.updateChat(user.id, ref, { ...(b.data.mode ? { mode: b.data.mode } : {}), ...(b.data.toneNotes !== undefined ? { toneNotes: b.data.toneNotes || null } : {}) }, 'miniapp');
    }
    return c.json({ chat: chats(user.id).find((ch) => ch.ref === ref) ?? null });
  });
}
