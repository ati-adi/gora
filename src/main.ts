// src/main.ts (WP0) — boot sequence and signals (01 §4.5).
//  1 loadConfig (fail fast)  2 gora.db + migrate + lock  3 keys.db  4 services  5–6 Telegram flags/commands
//  7 handlers + HTTP  8 ingress  9 recover + scheduler/outbox/dispatcher  10 SIGTERM → graceful stop.
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { ConfigError, errorMessage, isNotBuilt } from './kernel/errors.ts';
import { createLogger } from './kernel/log.ts';

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : errorMessage(e)}\n`);
    process.exit(1);
  }
  const log = createLogger({ level: cfg.logLevel });
  log.info({ env: cfg.env, mode: cfg.mode, llm: cfg.llm.transport, profile: cfg.profile.id }, 'gora booting');

  let app;
  try {
    app = await createApp({ config: cfg, log, fetchImpl: globalThis.fetch });
  } catch (e) {
    if (isNotBuilt(e)) {
      log.error({ wp: e.wp }, `${e.message} — this work package has not been merged yet; only \`npm test\` works until then`);
      process.exit(2);
    }
    throw e;
  }

  // step 7: start HTTP (webhook, Mini App, API, health)
  const server = serve({ fetch: app.http.fetch, port: cfg.port }, (info) => log.info({ port: info.port }, 'http listening'));
  // steps 8–9
  await app.start();
  log.info({}, 'gora ready');

  // step 10
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    // No new connections from here on; requests already accepted are drained by app.stop() (its first step) before
    // the runner stops and the databases close.
    server.close();
    try {
      await app.stop({ graceMs: 20_000, drainMs: 5_000 });
    } catch (e) {
      log.error({ err: e }, 'shutdown failed');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandled rejection'));
  // A throw from any timer/event callback must not kill every user's runs. Log the error's name only (its message may
  // carry user text) and keep serving; a burst (> 10 within a minute) means the process is wedged → stop gracefully so
  // the supervisor restarts it and recovery (step 9) resumes the runs.
  const crashes: number[] = [];
  process.on('uncaughtException', (err) => {
    const now = app.s.clock.now();
    crashes.push(now);
    while (crashes.length && crashes[0]! < now - 60_000) crashes.shift();
    log.error({ errName: err instanceof Error ? err.name : typeof err, code: (err as { code?: unknown } | null)?.code ?? null }, 'uncaught exception');
    if (crashes.length > 10) void shutdown('uncaughtException');
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(e)}\n`);
  process.exit(1);
});
