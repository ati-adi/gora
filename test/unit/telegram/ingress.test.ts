// WP2 — ingress (01 §15.2): 401 without the secret; update_id dedupe; pre_checkout_query answered inline in under 1 s
// with no LLM call; 200 immediately. Plus setWebhook's allowed_updates, polling offsets and SIGTERM → 503.
import type { Update } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_UPDATES_ALL } from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../../src/kernel/log.ts';
import { testConfig } from '../../../src/config.ts';
import { createInboxRepo } from '../../../src/telegram/inboxRepo.ts';
import { createIngress } from '../../../src/telegram/ingress.ts';
import { createFakeCrypto, createFakeKeyStore, createMemoryKv } from '../../harness/fakes.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';
import { U } from '../../harness/updates.ts';
import { makeEnv, type Env } from './helpers.ts';

let e: Env | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});

const post = (env: Env, u: unknown, secret: string | null = env.config.telegram.webhookSecret) =>
  env.mod.webhookHandler(new Request('https://gora.test/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret !== null ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body: JSON.stringify(u) }));
const rows = (env: Env) => env.db.db.prepare('SELECT update_id, kind, lane, status FROM tg_updates ORDER BY update_id').all<{ update_id: number; kind: string; lane: string; status: string }>();

describe('webhook ingress', () => {
  it('401 without (or with a wrong) secret; nothing is stored', async () => {
    e = await makeEnv();
    expect((await post(e, U.privateText('x'), null)).status).toBe(401);
    expect((await post(e, U.privateText('x'), 'wrong')).status).toBe(401);
    expect(rows(e)).toEqual([]);
    expect((await post(e, { not: 'an update' })).status).toBe(400);
  });

  it('stores the update in the inbox (sealed) and answers 200 immediately, before the handler finishes', async () => {
    e = await makeEnv();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let handled = 0;
    e.mod.bot.on('message', async () => {
      await gate;
      handled++;
    });
    e.mod.dispatcher.start();
    const u = U.privateText('hello');
    const res = await post(e, u);
    expect(res.status).toBe(200);
    expect(rows(e)).toEqual([{ update_id: u.update_id, kind: 'message', lane: 'dm:1001:0', status: 'processing' }]);
    const enc = e.db.db.prepare('SELECT payload_enc FROM tg_updates').get<{ payload_enc: Uint8Array }>()!.payload_enc;
    expect(Buffer.from(enc).toString('utf8')).not.toContain('hello');
    expect(handled).toBe(0);
    release();
    await e.mod.dispatcher.drain();
    expect(handled).toBe(1);
    expect(rows(e)[0]!.status).toBe('done');
  });

  it('deduplicates by update_id (Telegram re-delivery)', async () => {
    e = await makeEnv();
    const seen: number[] = [];
    e.mod.bot.on('message', (ctx) => void seen.push(ctx.update.update_id));
    const u = U.privateText('once');
    await post(e, u);
    await post(e, u);
    await e.mod.dispatcher.drain();
    await post(e, u);
    await e.mod.dispatcher.drain();
    expect(seen).toEqual([u.update_id]);
    expect(rows(e)).toHaveLength(1);
  });

  it('answers pre_checkout_query inline in under 1 s, never stores it, and never calls an LLM', async () => {
    e = await makeEnv();
    e.mod.bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
    const t0 = e.clock.now();
    const u = U.preCheckoutQuery({ payload: 'plan:plus', amount: 250 });
    expect((await post(e, u)).status).toBe(200);
    expect(e.tg.byMethod('answerPreCheckoutQuery')).toEqual([{ pre_checkout_query_id: u.pre_checkout_query!.id, ok: true }]);
    expect(e.clock.now() - t0).toBeLessThan(1000);
    expect(rows(e)).toEqual([]);
    expect((e.s as unknown as { transport?: unknown }).transport).toBeUndefined(); // no LLM is even wired here
  });

  it('answers a pre_checkout_query with ok:false when no handler answered (Telegram would cancel after 10 s)', async () => {
    e = await makeEnv();
    const u = U.preCheckoutQuery({ payload: 'plan:plus', amount: 250 });
    await post(e, u);
    expect(e.tg.byMethod('answerPreCheckoutQuery')[0]).toMatchObject({ pre_checkout_query_id: u.pre_checkout_query!.id, ok: false });
  });

  it('webhook mode: setWebhook with the secret and ALLOWED_UPDATES (feature-filtered); stopIngress → 503', async () => {
    e = await makeEnv({ config: { mode: 'webhook' } });
    await e.mod.startIngress();
    expect(e.tg.byMethod('setWebhook')).toEqual([{ url: 'https://gora.test/tg/webhook', secret_token: e.config.telegram.webhookSecret, allowed_updates: [...ALLOWED_UPDATES_ALL], max_connections: 40, drop_pending_updates: false }]);
    await e.mod.stopIngress();
    expect((await post(e, U.privateText('late'))).status).toBe(503);
    await e.close();
    e = await makeEnv({ config: { mode: 'webhook', features: { business: false, guest: false } } });
    await e.mod.startIngress();
    const allowed = e.tg.byMethod('setWebhook')[0].allowed_updates as string[];
    expect(allowed).not.toContain('guest_message');
    expect(allowed.some((a) => a.includes('business'))).toBe(false);
    expect(allowed).toContain('message_reaction');
  });
});

describe('polling ingress', () => {
  it('deleteWebhook, then getUpdates with offset / allowed_updates, storing kv.polling_offset', async () => {
    const clock = new FakeClock();
    const db = openTmpDb();
    const kv = createMemoryKv();
    kv.set('polling_offset', 500);
    const inbox = createInboxRepo(db.db, createFakeCrypto(createFakeKeyStore(), new Uint8Array(32).fill(1)));
    const calls: Array<{ method: string; p: Record<string, unknown> }> = [];
    const batches: Update[][] = [[{ ...U.privateText('a'), update_id: 500 }, { ...U.privateText('b'), update_id: 501 }]];
    let notified = 0;
    let ingress: ReturnType<typeof createIngress>;
    const bot = {
      api: {
        raw: {
          deleteWebhook: async (p: Record<string, unknown>) => void calls.push({ method: 'deleteWebhook', p }),
          getUpdates: async (p: Record<string, unknown>, signal?: AbortSignal) => {
            calls.push({ method: 'getUpdates', p });
            const b = batches.shift();
            if (b) return b;
            await clock.sleep(30_000, signal);
            return [];
          },
        },
      },
    };
    ingress = createIngress({
      config: testConfig({}, { mode: 'polling' }), clock, log: createMemoryLogger(), kv, inbox, bot: () => bot as never, pcq: { answered: () => true }, poll: true,
      dispatcher: { notify: () => void notified++ } as never,
    });
    await ingress.start();
    await clock.advance(10);
    expect(calls[0]).toEqual({ method: 'deleteWebhook', p: { drop_pending_updates: false } });
    expect(calls[1]!.p).toMatchObject({ offset: 500, limit: 100, timeout: 30 });
    expect(calls[1]!.p['allowed_updates']).toEqual([...ALLOWED_UPDATES_ALL]);
    expect(calls[2]!.p['offset']).toBe(502);
    expect(kv.get('polling_offset')).toBe(502);
    expect(inbox.due(clock.now(), 10).map((r) => r.updateId)).toEqual([500, 501]);
    expect(notified).toBe(2);
    await ingress.stop();
    db.cleanup();
  });
});
