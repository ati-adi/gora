// WP2 — dispatcher (01 §15.2): a lane is serial; different lanes run in parallel; a control update (Stop) is processed
// while a lane handler is blocked. Plus lagMs, crash re-queue, handler failures, inbound limits (§11.8), bot senders.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushMicrotasks } from '../../../src/kernel/clock.ts';
import { laneOf } from '../../../src/telegram/lanes.ts';
import { OTHER_USER, TEST_GROUP_ID, U } from '../../harness/updates.ts';
import { makeEnv, type Env } from './helpers.ts';

let e: Env;
beforeEach(async () => {
  e = await makeEnv();
});
afterEach(async () => {
  await e.close();
});

const post = (u: unknown) =>
  e.mod.webhookHandler(new Request('https://gora.test/tg/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': e.config.telegram.webhookSecret }, body: JSON.stringify(u) }));
function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

describe('lanes', () => {
  it('maps updates to lanes (§4.1, §10.1)', () => {
    expect(laneOf(U.privateText('x'))).toEqual({ kind: 'message', lane: 'dm:1001:0' });
    expect(laneOf(U.topicMessage('x', 55))).toEqual({ kind: 'message', lane: 'dm:1001:55' });
    expect(laneOf(U.groupMention('x')).lane).toBe(`grp:${TEST_GROUP_ID}:0`);
    expect(laneOf(U.ephemeralMe('q')).lane).toBe('ctl');
    expect(laneOf(U.guestMessage('x', { guestQueryId: 'gq1' })).lane).toBe('guest:gq1');
    expect(laneOf(U.businessMessage('x', { connectionId: 'bc1', chatId: 77 })).lane).toBe('biz:bc1:77');
    expect(laneOf(U.deletedBusinessMessages([1], { connectionId: 'bc1', chatId: 77 })).lane).toBe('biz:bc1:77');
    for (const u of [U.callbackQuery('a1:x'), U.stoppedGeneration(5), U.subscription('active', { payload: 'p' }), U.messageReaction(1, '👍'), U.myChatMember('member'), U.businessConnection()]) {
      expect(laneOf(u).lane).toBe('ctl');
    }
    expect(laneOf(U.successfulPayment({ payload: 'p', amount: 1, chargeId: 'c' })).lane).toBe('dm:1001:0');
  });
});

describe('dispatcher', () => {
  it('runs one lane serially, in update order', async () => {
    const order: string[] = [];
    const gates = [deferred(), deferred()];
    let n = 0;
    e.mod.bot.on('message:text', async (ctx) => {
      const i = n++;
      order.push(`start ${ctx.msg.text}`);
      await gates[i]!.p;
      order.push(`end ${ctx.msg.text}`);
    });
    e.mod.dispatcher.start();
    await post(U.privateText('one'));
    await post(U.privateText('two'));
    await flushMicrotasks();
    expect(order).toEqual(['start one']);
    gates[0]!.resolve();
    await flushMicrotasks();
    expect(order).toEqual(['start one', 'end one', 'start two']);
    gates[1]!.resolve();
    await e.mod.dispatcher.drain();
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two']);
  });

  it('runs different lanes in parallel', async () => {
    const started: number[] = [];
    const gate = deferred();
    e.mod.bot.on('message:text', async (ctx) => {
      started.push(ctx.from!.id);
      await gate.p;
    });
    e.mod.dispatcher.start();
    await post(U.privateText('a'));
    await post(U.privateText('b', { user: OTHER_USER }));
    await post(U.groupMention('c'));
    await flushMicrotasks();
    expect(started.sort()).toEqual([1001, 1001, 1002].sort());
    expect(e.mod.dispatcher.lagMs()).toBe(0);
    gate.resolve();
    await e.mod.dispatcher.drain();
  });

  it('processes a control update (Stop) while the lane handler is blocked', async () => {
    const gate = deferred();
    const stops: number[] = [];
    e.mod.bot.on('message:text', async () => {
      await gate.p;
    });
    e.mod.bot.on('stopped_message_generation', (ctx) => {
      stops.push(ctx.update.stopped_message_generation!.draft_id);
      gate.resolve(); // the Stop is what unblocks the "run"
    });
    e.mod.dispatcher.start();
    await post(U.privateText('long task'));
    await flushMicrotasks();
    expect(e.mod.dispatcher.lagMs()).toBe(0);
    await post(U.stoppedGeneration(4242));
    await e.mod.dispatcher.drain();
    expect(stops).toEqual([4242]);
  });

  it('reports lag as the age of the oldest queued row', async () => {
    await post(U.privateText('queued'));
    await e.clock.advance(4000);
    expect(e.mod.dispatcher.lagMs()).toBe(4000);
    await e.mod.dispatcher.drain();
    expect(e.mod.dispatcher.lagMs()).toBe(0);
  });

  it('re-queues rows a crashed process left in processing, on start', async () => {
    const seen: string[] = [];
    e.mod.bot.on('message:text', (ctx) => void seen.push(ctx.msg.text));
    const u = U.privateText('crashed');
    await post(u);
    e.db.db.prepare(`UPDATE tg_updates SET status = 'processing' WHERE update_id = ?`).run(u.update_id);
    e.mod.dispatcher.start();
    await e.mod.dispatcher.drain();
    expect(seen).toEqual(['crashed']);
  });

  it('a failing handler marks its row failed and the lane continues', async () => {
    const seen: string[] = [];
    e.mod.bot.on('message:text', (ctx) => {
      if (ctx.msg.text === 'boom') throw new Error('handler bug');
      seen.push(ctx.msg.text);
    });
    const bad = U.privateText('boom');
    await post(bad);
    await post(U.privateText('fine'));
    await e.mod.dispatcher.drain();
    expect(seen).toEqual(['fine']);
    expect(e.db.db.prepare('SELECT status, error FROM tg_updates WHERE update_id = ?').get(bad.update_id)).toEqual({ status: 'failed', error: 'Error' });
  });

  it('inbound limit: 20/min per user with a burst of 10, one "slow down" per minute; bot senders are ignored', async () => {
    const seen: string[] = [];
    e.mod.bot.on('message:text', (ctx) => void seen.push(ctx.msg.text));
    for (let i = 0; i < 13; i++) await post(U.privateText(`m${i}`));
    await e.mod.dispatcher.drain();
    expect(seen).toHaveLength(10);
    await e.s.telegram.outbox.flush();
    expect(e.tg.byMethod('sendMessage').filter((m) => m.text === 'slow_down')).toHaveLength(1);
    await e.clock.advance(3000); // one token back (20/min)
    await post(U.privateText('again'));
    await e.mod.dispatcher.drain();
    expect(seen.at(-1)).toBe('again');

    const fromBot = U.privateText('beep');
    (fromBot.message as { from: { is_bot: boolean } }).from.is_bot = true;
    await post(fromBot);
    await e.mod.dispatcher.drain();
    expect(seen).not.toContain('beep');
  });
});
