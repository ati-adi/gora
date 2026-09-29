// test/harness/testApp.ts (WP0) — createTestApp(): the whole process wired against fakes (01 §15.1).
// Real factories are used wherever the owning WP has merged; while a factory is still a WP0 stub (NotBuiltError),
// the matching no-op / in-memory fake from fakes.ts is used instead (disable with `noopFallback: false`).
import type { Update, UserFromGetMe } from 'grammy/types';
import { createApp, type App } from '../../src/app.ts';
import { testConfig, type Config, type DeepPartial } from '../../src/config.ts';
import type { Factories, IntegrationProvider, Logger, Ms, Random, Services } from '../../src/contracts/index.ts';
import { FakeClock, flushMicrotasks } from '../../src/kernel/clock.ts';
import { createMemoryLogger } from '../../src/kernel/log.ts';
import { seededRandom } from '../../src/kernel/random.ts';
import { createFakeTelegram, TEST_BOT_INFO, type FakeTelegram } from './fakeTelegram.ts';
import { signInitData } from './initData.ts';
import { ScriptedTransport } from './scriptedTransport.ts';
import { makeTmpDir, removeDir, tmpPaths } from './tmpDb.ts';
import { NOOP_FACTORIES } from './fakes.ts';
import { FakeBrowser } from './fakeBrowser.ts';
import { setUpdateClock, TEST_USER, U, type TestUser } from './updates.ts';

export interface CreateTestAppOptions {
  config?: DeepPartial<Config>;
  /** Extra env passed to loadConfig (NODE_ENV=test is always set), e.g. { LLM_PROVIDER: 'groq' } for the Groq profile. */
  env?: Record<string, string>;
  integrations?: IntegrationProvider;
  now?: Ms;
  dir?: string;
  factories?: Partial<Factories>;
  /** Default true: stub factories (NotBuiltError) fall back to NOOP_FACTORIES. */
  noopFallback?: boolean;
  /** Reuse across restart(). */
  llm?: ScriptedTransport;
  tg?: FakeTelegram;
  clock?: FakeClock;
  log?: Logger;
  /** Spec 05 §E: the app's Random (default seededRandom(42): Thompson draws and jitters are reproducible). Kept across restart(). */
  random?: Random;
  /** Default true: call app.start() (ingress, recover, scheduler, outbox, dispatcher). */
  start?: boolean;
  /** s07 (spec 07 A6): the browser (default: a FakeBrowser with no sites). Kept across restart() (sessions are closed by app.stop, like a crash). */
  browser?: FakeBrowser;
  /** s07 (spec 07 C1): getMe() result, e.g. TEST_BOT_INFO_READS_ALL (privacy mode OFF). Default TEST_BOT_INFO (privacy mode ON). Kept across restart(). */
  botInfo?: UserFromGetMe;
  /** internal: the temp dir was created by the harness (removed on close, kept across restart). */
  _ownsDir?: boolean;
}

export interface CardView { messageId: number; markdown: string; buttons: Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string }; copy_text?: { text: string }; style?: string }> }

export interface TestApp {
  s: Services;
  tg: FakeTelegram;
  llm: ScriptedTransport;
  clock: FakeClock;
  app: App;
  config: Config;
  dir: string;
  /** s07: the FakeBrowser injected as caps.browser. */
  browser: FakeBrowser;
  send(u: Update): Promise<void>;
  userSends(text: string, o?: { user?: TestUser; threadId?: number; replyTo?: number }): Promise<void>;
  tap(callbackData: string, o?: { user?: TestUser; messageId?: number }): Promise<void>;
  pressStop(o?: { threadId?: number; user?: TestUser }): Promise<void>;
  lastCard(): CardView;
  api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, o?: { initData?: string | null; user?: TestUser }): Promise<Response>; // Hono app.request
  advance(ms: number): Promise<void>; // FakeClock + scheduler.tick + runner/dispatcher settle
  settle(): Promise<void>;
  /** New App on the same files, same FakeTelegram / ScriptedTransport, clock continued; shares the integration provider (`o.integrations` or `s.integrations.provider`). */
  restart(): Promise<TestApp>;
  close(): Promise<void>;
}

export async function createTestApp(o: CreateTestAppOptions = {}): Promise<TestApp> {
  const dir = o.dir ?? makeTmpDir();
  const paths = tmpPaths(dir);
  const clock = o.clock ?? new FakeClock(o.now);
  setUpdateClock(() => clock.now());
  const tg = o.tg ?? createFakeTelegram({ now: () => clock.now() });
  const llm = o.llm ?? new ScriptedTransport({ clock });
  const browser = o.browser ?? new FakeBrowser([], () => clock.now());
  const config = testConfig({ DATA_DIR: paths.dataDir, KEYS_DB_PATH: paths.keysDbPath, BACKUP_DIR: paths.backupDir, PUBLIC_URL: 'https://gora.test', ...o.env }, o.config ?? {});
  const app = await createApp({
    config,
    clock,
    random: o.random ?? seededRandom(42),
    log: o.log ?? createMemoryLogger(),
    fetchImpl: tg.fetch,
    transport: llm,
    ...(o.integrations ? { integrationProvider: o.integrations } : {}),
    browser,
    telegram: { transformers: [tg.transformer], botInfo: o.botInfo ?? TEST_BOT_INFO, fetchImpl: tg.fetch },
    ...(o.factories ? { factories: o.factories } : {}),
    ...(o.noopFallback === false ? {} : { notBuiltFallback: NOOP_FACTORIES }),
  });
  if (o.start !== false) await app.start();
  const s = app.s;
  let closed = false;

  const settle = async () => {
    let lastSig = '';
    for (let i = 0; i < 50; i++) {
      await flushMicrotasks();
      await app.tg.dispatcher.drain();
      await s.runner.idle();
      await s.telegram.outbox.flush();
      await flushMicrotasks();
      const sig = `${tg.calls.length}|${llm.requests.length}|${llm.parseRequests.length}`;
      if (sig === lastSig && i > 0) return;
      lastSig = sig;
    }
  };

  const send = async (u: Update) => {
    const res = await app.tg.webhookHandler(
      new Request('https://gora.test/tg/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': config.telegram.webhookSecret },
        body: JSON.stringify(u),
      }),
    );
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    await settle();
  };

  const lastCard = (): CardView => {
    for (let i = tg.calls.length - 1; i >= 0; i--) {
      const c = tg.calls[i]!;
      if (!['sendRichMessage', 'sendMessage', 'editMessageText', 'editMessageReplyMarkup'].includes(c.method)) continue;
      const kb = c.payload?.reply_markup?.inline_keyboard as CardView['buttons'][] | undefined;
      if (!kb) continue;
      const result = c.result as { message_id?: number } | undefined;
      const messageId = Number(c.payload.message_id ?? result?.message_id ?? 0);
      return { messageId, markdown: String(c.payload.rich_message?.markdown ?? c.payload.text ?? ''), buttons: kb.flat() };
    }
    throw new Error('lastCard(): no message with an inline keyboard was sent');
  };

  const t: TestApp = {
    s, tg, llm, clock, app, config, dir, browser,
    send,
    settle,
    userSends: (text, uo = {}) => send(U.privateText(text, { ...(uo.user ? { user: uo.user } : {}), ...(uo.threadId ? { threadId: uo.threadId } : {}), ...(uo.replyTo ? { replyTo: uo.replyTo } : {}) })),
    tap: (data, uo = {}) => {
      let messageId = uo.messageId;
      if (messageId === undefined) {
        try {
          messageId = lastCard().messageId;
        } catch {
          messageId = 1;
        }
      }
      return send(U.callbackQuery(data, { ...(uo.user ? { user: uo.user } : {}), messageId }));
    },
    pressStop: async (so = {}) => {
      const draftId = tg.lastDraftId();
      if (draftId === null) throw new Error('pressStop(): no draft was sent');
      await send(U.stoppedGeneration(draftId, { ...(so.threadId ? { threadId: so.threadId } : {}), ...(so.user ? { user: so.user } : {}) }));
    },
    lastCard,
    api: async (method, path, body, ao = {}) => {
      const initData = ao.initData === undefined ? signInitData(ao.user ?? TEST_USER, { authDate: Math.floor(clock.now() / 1000), token: config.telegram.token ?? 'TEST_TOKEN' }) : ao.initData;
      const headers: Record<string, string> = {};
      if (initData) headers['authorization'] = `tma ${initData}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      return app.http.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    },
    advance: async (ms) => {
      await clock.advance(ms);
      await s.scheduler.tick();
      await settle();
    },
    restart: async () => {
      // The external world survives: the provider given by the test, else the one the IntegrationService built
      // (WP5's default fake provider with its drafts / sent mail / events).
      const provider = o.integrations ?? s.integrations.provider ?? undefined;
      await app.stop();
      closed = true;
      return createTestApp({ ...o, dir, _ownsDir: !o.dir || !!o._ownsDir, clock: new FakeClock(clock.now()), tg, llm, browser, ...(provider ? { integrations: provider } : {}) });
    },
    close: async () => {
      if (!closed) await app.stop();
      closed = true;
      if (!o.dir || o._ownsDir) removeDir(dir);
    },
  };
  return t;
}
