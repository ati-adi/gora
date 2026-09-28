// WP2 e2e — webhook → inbox → handlers; ALLOWED_UPDATES passed to setWebhook (01 §15.2). Runs the real Telegram module
// inside the whole app (createTestApp); surfaces/business/http are pinned to the harness no-ops so that this test's own
// grammY handlers receive the updates.
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_UPDATES_ALL } from '../../src/contracts/index.ts';
import { createTelegramModule } from '../../src/telegram/index.ts';
import { NOOP_FACTORIES } from '../harness/fakes.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { OTHER_USER, U } from '../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const factories = {
  createTelegramModule,
  createSurfaces: NOOP_FACTORIES.createSurfaces,
  createBusinessModule: NOOP_FACTORIES.createBusinessModule,
  createHttpApp: NOOP_FACTORIES.createHttpApp,
};

describe('webhook e2e', () => {
  it('boots in webhook mode: setWebhook with the secret and ALLOWED_UPDATES; commands and menu once', async () => {
    t = await createTestApp({ config: { mode: 'webhook' }, factories });
    expect(t.app.fallbacksUsed).not.toContain('createTelegramModule');
    const hooks = t.tg.byMethod('setWebhook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toEqual({ url: 'https://gora.test/tg/webhook', secret_token: t.config.telegram.webhookSecret, allowed_updates: [...ALLOWED_UPDATES_ALL], max_connections: 40, drop_pending_updates: false });
    expect(t.tg.byMethod('setMyCommands').length).toBeGreaterThanOrEqual(2);
    expect(t.tg.byMethod('setChatMenuButton')).toEqual([{ menu_button: { type: 'web_app', text: 'Gora', web_app: { url: 'https://gora.test/app/' } } }]);
    // spec 05 A5: the published private menu is exactly /memory and /settings (every other command still works, unlisted)
    for (const lang of [undefined, 'ru']) {
      const privateCmds = t.tg.byMethod('setMyCommands').find((p) => p.scope.type === 'all_private_chats' && p.language_code === lang);
      expect(privateCmds.commands.map((c: { command: string }) => c.command)).toEqual(['memory', 'settings']);
    }
    // spec 05 A1: the description (≤ 512, carries the memory notice) and the short description (≤ 120), en + ru, once
    const desc = t.tg.byMethod('setMyDescription');
    const short = t.tg.byMethod('setMyShortDescription');
    expect(desc.map((p) => p.language_code ?? 'default')).toEqual(['default', 'ru']);
    expect(short.map((p) => p.language_code ?? 'default')).toEqual(['default', 'ru']);
    for (const p of desc) expect(p.description.length).toBeLessThanOrEqual(512);
    for (const p of short) expect(p.short_description.length).toBeLessThanOrEqual(120);
    expect(desc.find((p) => p.language_code === 'ru').description).toContain('/memory');
    expect(desc.find((p) => p.language_code === 'ru').description).toContain('Гора — друг в Telegram.');
    const groupCmds = t.tg.byMethod('setMyCommands').find((p) => p.scope.type === 'all_group_chats' && !p.language_code);
    expect(groupCmds.commands.find((c: { command: string }) => c.command === 'me')).toMatchObject({ is_ephemeral: true });

    // a restart with unchanged definitions does not call setMyCommands again (kv.commands_hash)
    const n = t.tg.byMethod('setMyCommands').length;
    t = await t.restart();
    expect(t.tg.byMethod('setMyCommands').length).toBe(n);
    expect(t.tg.byMethod('setMyDescription')).toHaveLength(2); // once per hash, both languages
    expect(t.tg.byMethod('setMyShortDescription')).toHaveLength(2);
    expect(t.tg.byMethod('setWebhook')).toHaveLength(2);
  });

  it('routes webhook → inbox → dispatcher → grammY handlers (DM lanes, control lane, payments inline)', async () => {
    t = await createTestApp({ config: { mode: 'webhook' }, factories });
    const seen: string[] = [];
    t.app.tg.bot.on('message:text', (ctx) => void seen.push(`${ctx.from!.id}:${ctx.msg.text}`));
    t.app.tg.bot.on('callback_query:data', async (ctx) => {
      seen.push(`cb:${ctx.callbackQuery.data}`);
      await ctx.answerCallbackQuery();
    });
    t.app.tg.bot.on('stopped_message_generation', (ctx) => void seen.push(`stop:${ctx.update.stopped_message_generation!.draft_id}`));
    t.app.tg.bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

    await t.userSends('hi Gora');
    await t.send(U.privateText('hello', { user: OTHER_USER }));
    await t.send(U.callbackQuery('a1:X'));
    await t.send(U.stoppedGeneration(77));
    const pcq = U.preCheckoutQuery({ payload: 'plan:plus', amount: 250 });
    await t.send(pcq);

    expect(seen).toEqual(['1001:hi Gora', '1002:hello', 'cb:a1:X', 'stop:77']);
    expect(t.tg.byMethod('answerPreCheckoutQuery')).toEqual([{ pre_checkout_query_id: pcq.pre_checkout_query!.id, ok: true }]);
    const rows = t.s.db.prepare('SELECT kind, lane, status FROM tg_updates ORDER BY update_id').all();
    expect(rows).toEqual([
      { kind: 'message', lane: 'dm:1001:0', status: 'done' },
      { kind: 'message', lane: 'dm:1002:0', status: 'done' },
      { kind: 'callback_query', lane: 'ctl', status: 'done' },
      { kind: 'stopped_message_generation', lane: 'ctl', status: 'done' },
    ]);
    expect(t.app.tg.dispatcher.lagMs()).toBe(0);

    // the HTTP app's /tg/webhook path reaches the same handler, and the secret is enforced there too
    const u = U.privateText('via http');
    const unauth = await t.app.http.request('/tg/webhook', { method: 'POST', body: JSON.stringify(u) });
    expect(unauth.status).toBe(401);
    const ok = await t.app.http.request('/tg/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': t.config.telegram.webhookSecret }, body: JSON.stringify(u) });
    expect(ok.status).toBe(200);
    await t.settle();
    expect(seen.at(-1)).toBe('1001:via http');
  });

  it('the real gateway is s.telegram: outbox, codec, links and topics work end to end', async () => {
    t = await createTestApp({ factories });
    const data = t.s.telegram.codec.encode('a1', ['A7K2QX'], 1001);
    expect(t.s.telegram.codec.decode(data, 1001)).toEqual({ kind: 'a1', parts: ['A7K2QX'] });
    const card = t.s.telegram.render.card({ icon: '🔐', title: 'Send email?', rows: [['To', 'anna@example.com']], buttons: [[{ text: '✅ Approve', callback_data: data }]] });
    const refs = await t.s.telegram.outbox.sendNow({ idempotencyKey: 'card:1', chatId: 1001, method: 'sendRichMessage', markdown: card.markdown, payload: { reply_markup: card.replyMarkup } });
    t.s.telegram.links.record({ chatId: 1001, messageId: refs[0]!.messageId, kind: 'card', pendingActionId: 'A7K2QX' });
    expect(t.s.telegram.links.lookup(1001, refs[0]!.messageId)?.pendingActionId).toBe('A7K2QX');
    expect(t.lastCard().buttons[0]).toMatchObject({ text: '✅ Approve', callback_data: data });
    expect(t.s.telegram.flags).toMatchObject({ topics: true, guest: true, business: true });
  });
});
