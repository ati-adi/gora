// telegram/ingress.ts (WP2) — webhook and polling ingress (01 §4.1, §4.5 steps 8 and 10).
// Both paths call accept(update): INSERT OR IGNORE into tg_updates keyed on update_id, then return at once (the webhook
// answers 200 immediately). pre_checkout_query never enters the inbox: it is answered inline through the registered
// grammY handler (WP7 payments), with a safety answer when no handler answered in time (Telegram cancels after 10 s).
import { timingSafeEqual } from 'node:crypto';
import type { Bot, Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import type { Config } from '../config.ts';
import type { Clock, KvRepo, Logger } from '../contracts/index.ts';
import { AbortedError } from '../kernel/errors.ts';
import { allowedUpdatesFor } from './allowedUpdates.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { InboxRepo } from './inboxRepo.ts';
import { laneOf } from './lanes.ts';
import { errInfo, rawOf } from './render/fallback.ts';

export const PCQ_INLINE_BUDGET_MS = 900;

/** Remembers which pre-checkout queries were answered (installed as a transformer on the bot). */
export function createPcqTracker(): { transformer: Transformer; answered(id: string): boolean } {
  const answered = new Set<string>();
  return {
    transformer: async (prev, method, payload, signal) => {
      const res = await prev(method, payload, signal);
      if (method === 'answerPreCheckoutQuery' && res.ok) {
        const id = (payload as { pre_checkout_query_id?: string }).pre_checkout_query_id;
        if (id) {
          answered.add(id);
          if (answered.size > 10_000) answered.delete(answered.values().next().value!);
        }
      }
      return res;
    },
    answered: (id) => answered.has(id),
  };
}

export interface Ingress {
  accept(u: Update): Promise<void>;
  webhookHandler(req: Request): Promise<Response>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createIngress(d: {
  config: Config; clock: Clock; log: Logger; kv: KvRepo; inbox: InboxRepo; dispatcher: Dispatcher; bot: () => Bot;
  pcq: { answered(id: string): boolean };
  /** Run the getUpdates loop in polling mode (default: not under NODE_ENV=test, where the fake returns instantly). */
  poll?: boolean;
}): Ingress {
  const { config, clock, log } = d;
  let closing = false;
  let pollAbort: AbortController | null = null;
  let pollLoop: Promise<void> | null = null;
  const secret = Buffer.from(config.telegram.webhookSecret ?? '', 'utf8');

  async function accept(u: Update): Promise<void> {
    if (!u || typeof u !== 'object' || !Number.isSafeInteger(u.update_id)) throw new Error('not an update');
    const { kind, lane } = laneOf(u);
    if (kind === 'pre_checkout_query') return answerInline(u);
    const fresh = d.inbox.insert(u, kind, lane, clock.now());
    if (fresh) d.dispatcher.notify();
  }

  async function answerInline(u: Update): Promise<void> {
    const q = u.pre_checkout_query!;
    const ctl = new AbortController();
    const timeout = clock.sleep(PCQ_INLINE_BUDGET_MS, ctl.signal).then(
      () => 'timeout' as const,
      () => 'cancelled' as const,
    );
    try {
      const r = await Promise.race([d.bot().handleUpdate(u).then(() => 'handled' as const), timeout]);
      if (r === 'timeout') log.warn({ kind: 'pre_checkout_query' }, 'pre-checkout handler exceeded the inline budget');
    } catch (e) {
      log.error({ kind: 'pre_checkout_query', err: e instanceof Error ? e.name : 'error' }, 'pre-checkout handler failed');
    } finally {
      ctl.abort();
    }
    if (!d.pcq.answered(q.id)) {
      const ru = /^(ru|uk|kk|be)/i.test(q.from.language_code ?? '');
      try {
        await rawOf(d.bot().api)['answerPreCheckoutQuery']!({
          pre_checkout_query_id: q.id, ok: false,
          error_message: ru ? 'Оплата сейчас недоступна. Попробуйте ещё раз через минуту.' : 'Payments are temporarily unavailable. Please try again in a minute.',
        });
      } catch (e) {
        log.error({ err: e instanceof Error ? e.name : 'error' }, 'answerPreCheckoutQuery failed');
      }
    }
  }

  async function webhookHandler(req: Request): Promise<Response> {
    if (closing) return new Response('shutting down', { status: 503, headers: { 'retry-after': '5' } });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const got = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '', 'utf8');
    if (!secret.length || got.length !== secret.length || !timingSafeEqual(got, secret)) return new Response('unauthorized', { status: 401 });
    let u: Update;
    try {
      u = (await req.json()) as Update;
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!u || typeof u !== 'object' || !Number.isSafeInteger((u as { update_id?: unknown }).update_id)) return new Response('bad request', { status: 400 });
    try {
      await accept(u);
    } catch (e) {
      log.error({ err: e instanceof Error ? e.name : 'error' }, 'inbox accept failed');
      return new Response('error', { status: 500 }); // Telegram retries later
    }
    return new Response('ok', { status: 200 });
  }

  async function poll(signal: AbortSignal): Promise<void> {
    let offset = 0;
    try {
      offset = d.kv.get<number>('polling_offset') ?? 0;
    } catch {
      offset = 0;
    }
    let backoff = 1000;
    const allowed = allowedUpdatesFor(config.features);
    while (!signal.aborted) {
      try {
        const updates = (await (d.bot().api.raw.getUpdates as unknown as (p: Record<string, unknown>, s?: AbortSignal) => Promise<Update[]>)(
          { offset, limit: 100, timeout: 30, allowed_updates: allowed },
          signal,
        )) ?? [];
        for (const u of updates) {
          await accept(u);
          offset = u.update_id + 1;
        }
        if (updates.length) d.kv.set('polling_offset', offset);
        backoff = 1000;
      } catch (e) {
        if (signal.aborted || e instanceof AbortedError) break;
        log.warn({ err: errInfo(e) }, 'getUpdates failed; backing off');
        try {
          await clock.sleep(backoff, signal);
        } catch {
          break;
        }
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  return {
    accept,
    webhookHandler,
    async start() {
      closing = false;
      const allowed = allowedUpdatesFor(config.features);
      const raw = rawOf(d.bot().api);
      if (config.mode === 'webhook') {
        await raw['setWebhook']!({
          url: `${config.publicUrl}/tg/webhook`, secret_token: config.telegram.webhookSecret, allowed_updates: allowed, max_connections: 40, drop_pending_updates: false,
        });
        log.info({ allowedUpdates: allowed.length }, 'webhook set');
        return;
      }
      if (!(d.poll ?? config.env !== 'test')) return;
      await raw['deleteWebhook']!({ drop_pending_updates: false });
      pollAbort = new AbortController();
      pollLoop = poll(pollAbort.signal).catch((e: unknown) => log.error({ err: e instanceof Error ? e.name : 'error' }, 'polling loop crashed'));
      log.info({ allowedUpdates: allowed.length }, 'polling started');
    },
    async stop() {
      closing = true;
      pollAbort?.abort();
      if (pollLoop) await pollLoop;
      pollLoop = null;
      pollAbort = null;
    },
  };
}
