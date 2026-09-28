// telegram/dispatcher.ts (WP2) — leases inbox rows and runs them through grammY (01 §4.1):
//   - the control lane `ctl` runs immediately and concurrently (Stop, callbacks, payments, reactions, membership);
//   - every other lane (dm:<chat>:<thread>, grp:…, guest:…, biz:…) is serial, in update_id order;
//   - each pass looks at the due control-lane rows and at the HEAD row of every other lane (one per lane), so a backlog in
//     one busy lane never hides Stop presses, callbacks or other users' updates (review F6);
//   - handlers only ingest; a handler error marks the row failed (logged, never retried: handlers may have side effects);
//     a handler still running after the lease (5 min) is logged, its row marked failed and its lane released.
// Inbound abuse limits (01 §11.8, in memory): private messages 20/min per user with a burst of 10 and one "slow down"
// notice per minute; callbacks 10/s per user. Messages from bots are ignored (Bot-to-Bot mode is off).
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { Clock, Logger, Outbox, Strings } from '../contracts/index.ts';
import type { InboxRepo, InboxRow } from './inboxRepo.ts';
import { CONTROL_LANE } from './lanes.ts';
import { rawOf } from './render/fallback.ts';

export interface Dispatcher {
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  lagMs(): number;
  /** Ingress calls this after inserting a row (starts processing when running). */
  notify(): void;
  /** Runs one pump pass now (tests / drain). */
  pump(): void;
  /** Number of in-flight updates (tests). */
  inflight(): number;
}

interface Bucket { tokens: number; at: number }

export function createDispatcher(d: {
  inbox: InboxRepo; bot: () => Bot; clock: Clock; log: Logger; strings: Strings; outbox: () => Outbox;
  maxLanes?: number; maxControl?: number; leaseMs?: number; tickMs?: number;
}): Dispatcher {
  const maxLanes = d.maxLanes ?? 32;
  const maxControl = d.maxControl ?? 16;
  const leaseMs = d.leaseMs ?? 5 * 60_000;
  const tickMs = d.tickMs ?? 1000;
  const laneTasks = new Map<string, Promise<void>>();
  const ctlTasks = new Set<Promise<void>>();
  const claimed = new Set<number>();
  let running = false;
  let timer: unknown = null;
  let pumpQueued = false;

  // ── inbound limits
  const msgBuckets = new Map<number, Bucket>();
  const cbBuckets = new Map<number, Bucket>();
  const slowNoticeAt = new Map<number, number>();
  const takeToken = (m: Map<number, Bucket>, key: number, cap: number, perMs: number): boolean => {
    const now = d.clock.now();
    const b = m.get(key) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.at) / perMs);
    b.at = now;
    m.set(key, b);
    if (m.size > 100_000) m.delete(m.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  const all = () => [...laneTasks.values(), ...ctlTasks];

  const schedulePump = () => {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      if (running) pump();
    });
  };

  function pump(): void {
    const now = d.clock.now();
    if (ctlTasks.size < maxControl) {
      for (const row of d.inbox.dueInLane(CONTROL_LANE, now, maxControl + claimed.size)) {
        if (ctlTasks.size >= maxControl) break;
        if (claimed.has(row.updateId)) continue;
        start(row, now);
      }
    }
    if (laneTasks.size >= maxLanes) return;
    const busy = new Set<string>(laneTasks.keys());
    for (const row of d.inbox.laneHeads(now, 1000, CONTROL_LANE)) {
      if (laneTasks.size >= maxLanes) break;
      if (claimed.has(row.updateId) || busy.has(row.lane)) continue; // later rows of a lane wait for the running one
      busy.add(row.lane);
      start(row, now);
    }
  }

  function start(row: InboxRow, now: number): void {
    claimed.add(row.updateId);
    if (!d.inbox.claim(row.updateId, now, leaseMs)) {
      claimed.delete(row.updateId);
      return;
    }
    let expired = false;
    const release = () => {
      if (row.lane === CONTROL_LANE) ctlTasks.delete(p);
      else if (laneTasks.get(row.lane) === p) laneTasks.delete(row.lane);
      claimed.delete(row.updateId);
      if (running) schedulePump();
    };
    // a hung handler must not hold its lane until the next restart
    const watchdog = d.clock.setTimeout(() => {
      expired = true;
      d.log.error({ updateId: row.updateId, kind: row.kind, lane: row.lane }, 'update handler exceeded its lease; lane released');
      try {
        d.inbox.finish(row.updateId, 'failed', d.clock.now(), 'lease expired');
      } catch {
        /* best effort */
      }
      release();
    }, leaseMs);
    const p: Promise<void> = process(row, () => expired)
      .catch((e: unknown) => d.log.error({ updateId: row.updateId, err: e instanceof Error ? e.name : 'error' }, 'dispatcher task failed'))
      .finally(() => {
        d.clock.clearTimeout(watchdog);
        if (!expired) release();
      });
    if (row.lane === CONTROL_LANE) ctlTasks.add(p);
    else laneTasks.set(row.lane, p);
  }

  async function process(row: InboxRow, expired: () => boolean): Promise<void> {
    let update: Update | null;
    try {
      update = d.inbox.payload(row.updateId);
    } catch (e) {
      d.inbox.finish(row.updateId, 'failed', d.clock.now(), `payload: ${e instanceof Error ? e.name : 'error'}`);
      return;
    }
    if (!update) {
      d.inbox.finish(row.updateId, 'skipped', d.clock.now(), 'payload expired');
      return;
    }
    const skip = await admission(update, row.kind);
    if (skip) {
      d.inbox.finish(row.updateId, 'skipped', d.clock.now(), skip);
      return;
    }
    try {
      await d.bot().handleUpdate(update);
      if (!expired()) d.inbox.finish(row.updateId, 'done', d.clock.now());
    } catch (e) {
      const inner = (e as { error?: unknown }).error ?? e;
      const name = inner instanceof Error ? inner.name : 'error';
      d.log.error({ updateId: row.updateId, kind: row.kind, lane: row.lane, err: name }, 'update handler failed');
      if (!expired()) d.inbox.finish(row.updateId, 'failed', d.clock.now(), name);
    }
  }

  /** Returns a skip reason, or null to process. */
  async function admission(u: Update, kind: string): Promise<string | null> {
    if (kind === 'message' || kind === 'edited_message') {
      const m = (u.message ?? u.edited_message)!;
      if (m.from?.is_bot) return 'from bot';
      if (kind === 'message' && m.chat.type === 'private' && m.from) {
        if (!takeToken(msgBuckets, m.from.id, 10, 60_000 / 20)) {
          notifySlowDown(m.from.id, m.chat.id, m.message_thread_id, m.from.language_code);
          return 'rate limited';
        }
      }
    }
    if (kind === 'callback_query' && u.callback_query) {
      const cq = u.callback_query;
      if (!takeToken(cbBuckets, cq.from.id, 10, 100)) {
        try {
          await rawOf(d.bot().api)['answerCallbackQuery']!({ callback_query_id: cq.id });
        } catch {
          /* best effort */
        }
        return 'rate limited';
      }
    }
    return null;
  }

  function notifySlowDown(tgId: number, chatId: number, threadId: number | undefined, lang: string | undefined): void {
    const now = d.clock.now();
    const last = slowNoticeAt.get(tgId) ?? 0;
    if (now - last < 60_000) return;
    slowNoticeAt.set(tgId, now);
    try {
      d.outbox().enqueue({
        idempotencyKey: `slow:${tgId}:${Math.floor(now / 60_000)}`, chatId, ...(threadId ? { threadId } : {}),
        method: 'sendMessage', payload: { text: d.strings.t('slow_down', lang) }, priority: 1,
      });
    } catch (e) {
      d.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'slow-down notice failed');
    }
  }

  const tick = () => {
    timer = null;
    if (!running) return;
    pump();
    timer = d.clock.setTimeout(tick, tickMs);
  };

  return {
    start() {
      if (running) return;
      const n = d.inbox.resetProcessing();
      if (n) d.log.info({ n }, 'inbox rows re-queued after restart');
      running = true;
      pump();
      timer = d.clock.setTimeout(tick, tickMs);
    },
    async stop() {
      running = false;
      if (timer !== null) d.clock.clearTimeout(timer);
      timer = null;
      await Promise.allSettled(all());
    },
    async drain() {
      for (let i = 0; i < 1000; i++) {
        pump();
        const tasks = all();
        if (!tasks.length) {
          if (!d.inbox.due(d.clock.now(), 1).length) return;
          // due rows exist but none could start (a lane is busy elsewhere) — let microtasks run once more
          await Promise.resolve();
          if (!all().length && !d.inbox.due(d.clock.now(), 1).some((r) => !claimed.has(r.updateId))) return;
          continue;
        }
        await Promise.allSettled(tasks);
      }
    },
    lagMs() {
      const t = d.inbox.oldestQueuedAt();
      return t === null ? 0 : Math.max(0, d.clock.now() - t);
    },
    notify() {
      if (running) schedulePump();
    },
    pump,
    inflight: () => laneTasks.size + ctlTasks.size,
  };
}
