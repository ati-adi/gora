// http/routes/ledger.ts (WP8) — Ledger screen (01 §12, §11.8):
//   GET /api/ledger?cursor&kinds&from&to&limit     read  newest first; `next` is the cursor for the following page
//   GET /api/ledger/planned                         read  jobs, reminders, watchers, missions, pending approvals
//   GET /api/ledger/verify                          read  the hash-chain check ("Ledger verified ✓")
import { z } from 'zod';
import type { LedgerKind, Services, UserId } from '../../contracts/index.ts';
import { ledgerHead, ledgerRowHmac, verifyLedgerChain, type LedgerCheckpoint } from '../../ledger/ledger.ts';
import { yieldToEventLoop } from '../../kernel/clock.ts';
import { auth, err, query, safely, userScope, type Api } from '../util.ts';
import { viewOut } from './approvals.ts';

const KINDS: readonly LedgerKind[] = ['tool_call', 'data_read', 'approval_requested', 'approval_resolved', 'message_sent', 'email_sent', 'draft_created', 'calendar_changed', 'memory_saved', 'memory_forgotten', 'connection', 'permission_change', 'grant_change', 'business_event', 'nudge_sent', 'mission', 'payment', 'export', 'deletion', 'consent', 'pause', 'refusal', 'fallback_served', 'undo', 'settings', 'guard_block'];
const KIND_SET = new Set<string>(KINDS);

/** The Mini App's filter chips (All, Actions, Reads, Memory, Messages, Payments) → ledger kinds. */
export const LEDGER_FILTERS: Readonly<Record<string, readonly LedgerKind[]>> = Object.freeze({
  actions: ['tool_call', 'approval_requested', 'approval_resolved', 'email_sent', 'draft_created', 'calendar_changed', 'grant_change', 'permission_change', 'connection', 'undo', 'mission', 'settings', 'pause', 'consent', 'deletion', 'export', 'guard_block', 'refusal', 'fallback_served'],
  reads: ['data_read'],
  memory: ['memory_saved', 'memory_forgotten'],
  messages: ['message_sent', 'nudge_sent', 'business_event'],
  payments: ['payment'],
});

const int = z.string().regex(/^\d{1,16}$/).transform(Number);
const Q = z.object({
  cursor: int.optional(),
  kinds: z.string().max(600).optional(),
  filter: z.enum(['all', 'actions', 'reads', 'memory', 'messages', 'payments']).optional(),
  from: int.optional(),
  to: int.optional(),
  limit: int.optional(),
});

/**
 * /ledger/verify cost bounds (a user can grow their own ledger cheaply, and a full check decrypts and re-HMACs every
 * row): the chain is walked in batches that yield to the event loop; a verified checkpoint per user lets later calls
 * check only the rows appended since (the full chain is re-walked at most once per VERIFY_FULL_EVERY_MS); concurrent
 * calls share one walk; and the route has its own per-user rate.
 */
export const VERIFY_BATCH = 500;
export const VERIFY_FULL_EVERY_MS = 60 * 60_000;
export const VERIFY_RATE_PER_MIN = 6;
const VERIFY_CACHE_MAX = 10_000;

interface VerifyMemo { fullAt: number; head: LedgerCheckpoint | null; broken: number | null }
type VerifyOut = { ok: true } | { ok: false; brokenAtSeq: number };

export function createLedgerVerifier(s: Services, opts: { batch?: number; fullEveryMs?: number } = {}): (userId: UserId) => Promise<VerifyOut> {
  const batch = opts.batch ?? VERIFY_BATCH;
  const fullEvery = opts.fullEveryMs ?? VERIFY_FULL_EVERY_MS;
  const memo = new Map<UserId, VerifyMemo>();
  const inflight = new Map<UserId, Promise<VerifyOut>>();
  const remember = (userId: UserId, m: VerifyMemo) => {
    memo.delete(userId);
    memo.set(userId, m);
    if (memo.size > VERIFY_CACHE_MAX) memo.delete(memo.keys().next().value!);
  };

  async function walk(userId: UserId): Promise<VerifyOut> {
    const now = s.clock.now();
    const m = memo.get(userId);
    let from: LedgerCheckpoint | null = null;
    let fullAt = now;
    if (m && now - m.fullAt < fullEvery) {
      if (m.broken !== null) {
        // A broken chain stays broken (append-only): answer from the memo until the next full walk.
        return { ok: false, brokenAtSeq: m.broken };
      }
      if (m.head && ledgerRowHmac(s.db, userId, m.head.seq) === m.head.rowHmac) {
        const h = ledgerHead(s.db, userId);
        if (h && h.seq === m.head.seq && h.rowHmac === m.head.rowHmac) return { ok: true };
        from = m.head;
        fullAt = m.fullAt;
      }
    }
    let cur = from;
    for (;;) {
      const r = verifyLedgerChain(s.db, s.crypto, userId, cur, batch);
      if (!r.ok) {
        remember(userId, { fullAt: now, head: null, broken: r.brokenAtSeq });
        return { ok: false, brokenAtSeq: r.brokenAtSeq };
      }
      cur = r.head;
      if (r.done) break;
      await yieldToEventLoop();
    }
    remember(userId, { fullAt, head: cur, broken: null });
    return { ok: true };
  }

  return (userId) => {
    const running = inflight.get(userId);
    if (running) return running;
    const p = walk(userId).finally(() => inflight.delete(userId));
    inflight.set(userId, p);
    return p;
  };
}

export function registerLedger(api: Api, s: Services): void {
  const verify = createLedgerVerifier(s);

  api.get('/ledger', (c) => {
    const { user } = auth(c);
    const q = query(c, Q);
    if (!q.ok) return q.res;
    let kinds: LedgerKind[] | undefined;
    if (q.data.kinds) kinds = q.data.kinds.split(',').map((k) => k.trim()).filter((k): k is LedgerKind => KIND_SET.has(k));
    else if (q.data.filter && q.data.filter !== 'all') kinds = [...LEDGER_FILTERS[q.data.filter]!];
    const limit = Math.min(Math.max(q.data.limit ?? 50, 1), 100);
    const rows = s.ledger.list(user.id, {
      limit,
      ...(q.data.cursor !== undefined ? { cursor: q.data.cursor } : {}),
      ...(kinds && kinds.length ? { kinds } : {}),
      ...(q.data.from !== undefined ? { fromMs: q.data.from } : {}),
      ...(q.data.to !== undefined ? { toMs: q.data.to } : {}),
    });
    const items = rows.map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, kind: e.kind, summary: e.summary, runId: e.runId ?? null, pendingActionId: e.pendingActionId ?? null }));
    return c.json({ items, next: rows.length === limit ? rows[rows.length - 1]!.seq : null });
  });

  api.get('/ledger/planned', (c) => {
    const { user } = auth(c);
    const scope = userScope(user);
    const jobs = safely(s, 'scheduler.list', () => s.scheduler.list({ userId: user.id, limit: 50 }), []);
    return c.json({
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, runAt: j.runAt, recurring: j.cron !== null })),
      reminders: safely(s, 'reminders.list', () => s.reminders.list(scope, false), []),
      watchers: safely(s, 'watchers.list', () => s.watchers.list(user.id), []).filter((w) => w.status === 'active' || w.status === 'paused'),
      missions: safely(s, 'missions.list', () => s.missions.list(user.id, { active: true }), []),
      approvals: safely(s, 'approvals.listPending', () => s.approvals.listPending(user.id), []).map(viewOut),
    });
  });

  api.get('/ledger/verify', async (c) => {
    const { user } = auth(c);
    if (!s.quotas.rate(`ledgerverify:${user.tgUserId}`, VERIFY_RATE_PER_MIN, 60_000)) return err(c, 429, 'rate_limited');
    const r = await verify(user.id);
    return c.json({ ok: r.ok, brokenAtSeq: r.ok ? null : r.brokenAtSeq });
  });
}
