// http/routes/memory.ts (WP8) — Memory screen (01 §12, F5, §9):
//   GET    /api/memory?q&kind&cursor                   read   the user's facts (grouped by kind in the client) + the
//                                                             profile card (spec 05 B5) + memory state (on/off/incognito)
//   PATCH  /api/memory/profile {op, field, index?, text?}  write  delete / correct one profile-card field (B5)
//   PATCH  /api/memory/:id {text?, pinned?}            write
//   DELETE /api/memory/:id                             write  → memory.forget (fingerprints + rotation, WP6)
//   GET    /api/memory/conversations                   read   for "Forget everything from a chat"
//   POST   /api/memory/forget-conversation {conversationId}   write
//   POST   /api/memory/import {text}                   write  → pending_confirm candidates
//   POST   /api/memory/confirm {ids, accept}           write
//   PATCH  /api/memory/consent {on}                    write  memory on/off (consent row + users.memory_consent)
//   POST   /api/memory/incognito {on, minutes?}        write  Incognito (also the Home toggle)
// Only the user scope is served: group memory belongs to the group and is managed from the group.
import { z } from 'zod';
import type { FactKind, ProfileEdit, Services, UserRow } from '../../contracts/index.ts';
import { memoryState } from '../../contracts/index.ts';
import { auth, body, err, errName, fresh, ledger, query, safely, userScope, type Api } from '../util.ts';

/** Consent text versions shared with surfaces/onboarding.ts: friend mode's notice is the bot description (05 A1). */
export const MEMORY_TEXT_VERSION = 'desc-v1';
export const IMPORT_TEXT_VERSION = 'imp-v1';
const INCOGNITO_DEFAULT_MIN = 60;
const INCOGNITO_MAX_MIN = 24 * 60;

const FACT_KINDS = ['profile', 'preference', 'person', 'relationship', 'goal', 'routine', 'date', 'fact', 'group_decision'] as const satisfies readonly FactKind[];
const Q = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(FACT_KINDS).optional(),
  scope: z.enum(['user']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).optional(),
});
const Edit = z.object({ text: z.string().trim().min(1).max(1000).optional(), pinned: z.boolean().optional() }).refine((v) => v.text !== undefined || v.pinned !== undefined, 'nothing to change');
const ForgetConv = z.object({ conversationId: z.string().min(1).max(128) });
const Import = z.object({ text: z.string().trim().min(1).max(50_000) });
const Confirm = z.object({ ids: z.array(z.string().min(1).max(128)).min(1).max(200), accept: z.boolean() });
const Consent = z.object({ on: z.boolean() });
const Incognito = z.object({ on: z.boolean(), minutes: z.number().int().min(5).max(INCOGNITO_MAX_MIN).optional() });
const LIST_FIELDS = ['people', 'goals', 'preferences', 'current_context', 'open_threads'] as const;
const ProfilePatch = z.union([
  z.object({ op: z.literal('delete'), field: z.literal('summary') }).strict(),
  z.object({ op: z.literal('delete'), field: z.enum(LIST_FIELDS), index: z.number().int().min(0).max(50) }).strict(),
  z.object({ op: z.literal('correct'), field: z.literal('summary'), text: z.string().trim().min(1).max(600) }).strict(),
  z.object({ op: z.literal('correct'), field: z.enum(LIST_FIELDS), index: z.number().int().min(0).max(50), text: z.string().trim().min(1).max(300) }).strict(),
]);

const idOk = (id: string) => /^[A-Za-z0-9_:-]{1,128}$/.test(id);

/** Turns Incognito on/off exactly like `/incognito` (WP7a): users.incognito_until, the incognito_end job, DM rotation. */
export function setIncognito(s: Services, u: UserRow, on: boolean, minutes = INCOGNITO_DEFAULT_MIN): number | null {
  const now = s.clock.now();
  const wasOn = u.incognitoUntil !== null && u.incognitoUntil > now;
  const dmKey = safely(s, 'conversations.scopeKeyOf', () => s.conversations.scopeKeyOf({ kind: 'dm', tgUserId: u.tgUserId }), null);
  const dm = dmKey ? safely(s, 'conversations.byScopeKey', () => s.repos.conversations.byScopeKey(dmKey), undefined) : undefined;
  if (!on) {
    if (!wasOn && u.incognitoUntil === null) return null;
    s.repos.users.update(u.id, { incognitoUntil: null });
    // The incognito_end handler (WP6a) rotates every conversation whose current epoch is an incognito epoch.
    s.scheduler.schedule({ kind: 'incognito_end', runAt: now, userId: u.id, refId: u.id, dedupeKey: `incog:${u.id}` });
    ledger(s, { userId: u.id, actor: 'user', kind: 'settings', summary: 'Incognito off (Mini App)', detail: { incognito: false } });
    return null;
  }
  const until = now + minutes * 60_000;
  s.repos.users.update(u.id, { incognitoUntil: until });
  s.scheduler.schedule({ kind: 'incognito_end', runAt: until, userId: u.id, refId: u.id, dedupeKey: `incog:${u.id}` });
  if (!wasOn && dm) {
    try {
      s.runner.requestRotation(dm.id, 'incognito_start');
    } catch (x) {
      s.log.warn({ mod: 'http', err: errName(x) }, 'miniapp: incognito rotation request failed');
    }
  }
  ledger(s, { userId: u.id, actor: 'user', kind: 'settings', summary: 'Incognito on (Mini App)', detail: { incognito: true, minutes } });
  return until;
}

/** Per-user import rate (the DM import path shares the 20/min chat limiter; one import is ~6k tokens). */
export const IMPORT_RATE_PER_MIN = 3;

/**
 * Checks (and on success consumes) what an import costs: the refusal cooldown, the daily cost cap, a turn, and the
 * per-user import rate. Returns the refusal to send, or null when the import may call the LLM.
 */
function importGate(s: Services, user: UserRow): { error: string; extra?: Record<string, unknown> } | null {
  const now = s.clock.now();
  const cd = s.quotas.cooldownUntil(user.id);
  if (cd !== null && cd > now) return { error: 'cooldown', extra: { until: cd } };
  const cost = s.quotas.check(user.id, 'cost_micros');
  if (!cost.ok) return { error: 'quota', extra: { kind: 'cost_micros', resetsAt: cost.resetsAt } };
  const turn = s.quotas.check(user.id, 'turn');
  if (!turn.ok) return { error: 'quota', extra: { kind: 'turn', resetsAt: turn.resetsAt } };
  if (!s.quotas.rate(`import:${user.tgUserId}`, IMPORT_RATE_PER_MIN, 60_000)) return { error: 'rate_limited' };
  s.quotas.consume(user.id, 'turn');
  return null;
}

export function registerMemory(api: Api, s: Services): void {
  api.get('/memory', async (c) => {
    const { user } = auth(c);
    const q = query(c, Q);
    if (!q.ok) return q.res;
    const r = await s.memory.list(userScope(user), {
      limit: Math.min(Math.max(q.data.limit ?? 100, 1), 200),
      ...(q.data.kind ? { kind: q.data.kind } : {}),
      ...(q.data.q ? { query: q.data.q } : {}),
      ...(q.data.cursor ? { cursor: q.data.cursor } : {}),
    });
    const now = s.clock.now();
    const profile = safely(s, 'userProfile.get', () => s.userProfile.get(user.id), null);
    return c.json({
      profile: profile ? { version: profile.version, card: profile.card, factCount: profile.factCount, createdAt: profile.createdAt } : null,
      memory: memoryState(user, now),
      items: r.items.map((f) => ({ id: f.id, text: f.text, kind: f.kind, sourceLabel: f.sourceLabel, createdAt: f.createdAt, pinned: f.pinned, status: f.status, sensitivity: f.sensitivity, quote: f.quote, useCount: f.useCount })),
      next: r.next ?? null,
      consent: user.memoryConsent,
      incognitoUntil: user.incognitoUntil !== null && user.incognitoUntil > now ? user.incognitoUntil : null,
    });
  });

  // Registered before '/memory/:id' so "profile" is never taken for a fact id.
  api.patch('/memory/profile', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, ProfilePatch);
    if (!b.ok) return b.res;
    const cur = safely(s, 'userProfile.get', () => s.userProfile.get(user.id), null);
    if (!cur) return err(c, 404, 'not_found');
    const e = b.data as ProfileEdit;
    if ('index' in e && e.index >= cur.card[e.field].length) return err(c, 404, 'not_found');
    const view = s.userProfile.edit(user.id, e);
    // Keys only, never the corrected text (it is personal).
    ledger(s, { userId: user.id, actor: 'user', kind: 'settings', summary: `Profile card ${e.op === 'delete' ? 'item deleted' : 'corrected'} (Mini App): ${e.field}`, detail: { op: e.op, field: e.field } });
    return c.json({ profile: view ? { version: view.version, card: view.card, factCount: view.factCount, createdAt: view.createdAt } : null });
  });

  api.patch('/memory/consent', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Consent);
    if (!b.ok) return b.res;
    if (b.data.on) s.repos.users.grantConsent({ userId: user.id, kind: 'memory', textVersion: MEMORY_TEXT_VERSION, via: 'miniapp' });
    else s.repos.users.revokeConsent(user.id, 'memory');
    s.repos.users.update(user.id, { memoryConsent: b.data.on });
    ledger(s, { userId: user.id, actor: 'user', kind: 'consent', summary: b.data.on ? 'Memory on (Mini App)' : 'Memory off (Mini App)', detail: { kind: 'memory', textVersion: MEMORY_TEXT_VERSION, granted: b.data.on } });
    return c.json({ consent: b.data.on });
  });

  api.post('/memory/incognito', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Incognito);
    if (!b.ok) return b.res;
    const until = setIncognito(s, user, b.data.on, b.data.minutes);
    return c.json({ incognitoUntil: until });
  });

  api.get('/memory/conversations', (c) => {
    const { user } = auth(c);
    const convs = safely(s, 'conversations.listByUser', () => s.repos.conversations.listByUser(user.id, { status: 'active', limit: 50 }), []);
    return c.json({ items: convs.filter((cv) => cv.kind !== 'guest' && cv.kind !== 'biz_draft').map((cv) => ({ id: cv.id, kind: cv.kind, threadId: cv.threadId, lastActivityAt: cv.lastActivityAt, createdAt: cv.createdAt })) });
  });

  api.post('/memory/forget-conversation', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, ForgetConv);
    if (!b.ok) return b.res;
    const conv = s.repos.conversations.get(b.data.conversationId);
    if (!conv || conv.userId !== user.id) return err(c, 404, 'not_found');
    await s.memory.forgetConversation(user.id, conv.id);
    return c.json({ ok: true });
  });

  api.post('/memory/import', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Import);
    if (!b.ok) return b.res;
    // The import is an LLM side call: gate it like a chat turn (01 §11.8 cost cap before any LLM call, the refusal
    // cooldown, the daily turn quota) plus a tight per-user rate, since the generic Mini App bucket is 240/min.
    const gate = importGate(s, user);
    if (gate) return err(c, 429, gate.error, gate.extra);
    if (!s.repos.users.hasConsent(user.id, 'import')) s.repos.users.grantConsent({ userId: user.id, kind: 'import', textVersion: IMPORT_TEXT_VERSION, via: 'miniapp' });
    const facts = await s.memory.importText(user.id, b.data.text);
    return c.json({ candidates: facts.map((f) => ({ id: f.id, text: f.text })) });
  });

  api.post('/memory/confirm', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Confirm);
    if (!b.ok) return b.res;
    await s.memory.confirm(user.id, b.data.ids, b.data.accept);
    return c.json({ ok: true });
  });

  api.patch('/memory/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const b = await body(c, Edit);
    if (!b.ok) return b.res;
    if (s.memory.getMany(userScope(user), [id]).length === 0) return err(c, 404, 'not_found');
    await s.memory.edit(user.id, id, { ...(b.data.text !== undefined ? { text: b.data.text } : {}), ...(b.data.pinned !== undefined ? { pinned: b.data.pinned } : {}) });
    return c.json({ ok: true });
  });

  api.delete('/memory/:id', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const id = c.req.param('id');
    if (!idOk(id)) return err(c, 404, 'not_found');
    const r = await s.memory.forget(userScope(user), { ids: [id] }, { tgUserId: user.tgUserId });
    if (r.forgotten.length === 0) return err(c, 404, 'not_found');
    return c.json({ forgotten: r.forgotten.map((f) => f.id) });
  });
}
