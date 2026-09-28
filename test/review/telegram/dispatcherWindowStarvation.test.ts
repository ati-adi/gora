// REVIEW (telegram) — dispatcher control-lane starvation: pump() only looks at the 500 OLDEST due rows
// (inbox.due(now, 500)). The per-user inbound limit (§11.8) is applied only when a row is dequeued, and rows of a busy
// serial lane are never dequeued. So one user whose lane handler is slow (voice/STT, file download) and who sends ≥ 500
// more messages meanwhile pushes every other update — Stop presses, approval callbacks, other users' DMs — out of the
// window until that handler finishes. The control lane is supposed to "run immediately and concurrently".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushMicrotasks } from '../../../src/kernel/clock.ts';
import { U } from '../../harness/updates.ts';
import { makeEnv, type Env } from '../../unit/telegram/helpers.ts';

let e: Env;
let release: () => void = () => {};
beforeEach(async () => {
  e = await makeEnv();
});
afterEach(async () => {
  release();
  await e.close();
});
const post = (u: unknown) =>
  e.mod.webhookHandler(new Request('https://gora.test/tg/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': e.config.telegram.webhookSecret }, body: JSON.stringify(u) }));

describe('dispatcher window', () => {
  it('a Stop press is processed while one DM lane is busy with a 500-message backlog', async () => {
    const gate = new Promise<void>((r) => (release = r));
    e.mod.bot.on('message:text', async () => {
      await gate; // a slow handler (e.g. STT of a voice note)
    });
    const stops: number[] = [];
    e.mod.bot.on('stopped_message_generation', (ctx) => void stops.push(ctx.update.stopped_message_generation!.draft_id));
    e.mod.dispatcher.start();
    await post(U.privateText('slow one'));
    await flushMicrotasks();
    for (let i = 0; i < 500; i++) await post(U.privateText(`spam ${i}`)); // same user → same serial lane, all queued
    await post(U.stoppedGeneration(4242));
    await e.clock.advance(3000); // several dispatcher ticks
    await flushMicrotasks();
    expect(stops).toEqual([4242]);
  });
});
