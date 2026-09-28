// scripts/admin.ts (WP1) — operator CLI (01 §11.7, §11.8):
//   npm run admin -- stats
//   npm run admin -- refund <tgUserId> <chargeId>     → s.payments.refund (idempotent; WP7)
//   npm run admin -- purge-user <tgUserId>            → s.privacy.deleteUser(userId, 'admin') (the full §7.2 plan + hooks)
//   npm run admin -- verify-ledger <tgUserId>         → Ledger.verify
//   npm run admin -- set-webhook                      → setWebhook(PUBLIC_URL/tg/webhook, secret, allowedUpdates(features))
//   npm run admin -- rewrap                           → re-wraps every DEK under GORA_KEK_NEW (server must be stopped)
//
// Output is JSON on stdout (one object per command); errors go to stderr with exit code 1 (usage: 2). Tokens, secrets
// and message text are never printed. Read-only commands open gora.db without the single-writer lock (WAL readers);
// `rewrap` takes the lock (the running server caches the old KEK); refund / purge-user build the app without starting
// it (no ingress, scheduler or outbox loop) so its services and privacy hooks are available.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type App } from '../src/app.ts';
import { decodeKey, loadConfig, type Config } from '../src/config.ts';
import { allowedUpdates } from '../src/contracts/telegram.ts';
import type { Db, KeyStore } from '../src/contracts/storage.ts';
import { createCrypto } from '../src/db/crypto.ts';
import { openKeyStore } from '../src/db/keystore.ts';
import { migrate } from '../src/db/migrate.ts';
import { acquireLock, openDb } from '../src/db/sqlite.ts';
import { createLedgerCore } from '../src/ledger/ledger.ts';
import { backupStamp } from '../src/privacy/backup.ts';
import { systemClock } from '../src/kernel/clock.ts';
import { errorMessage } from '../src/kernel/errors.ts';
import { createLogger } from '../src/kernel/log.ts';

export const USAGE = `usage: npm run admin -- <command>
  stats
  refund <tgUserId> <chargeId>
  purge-user <tgUserId>
  verify-ledger <tgUserId>
  set-webhook
  rewrap                      (reads the new key from GORA_KEK_NEW; stop the server first)`;

export interface AdminDeps {
  config: Config;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  out(line: string): void;
  err(line: string): void;
  /** Builds the (unstarted) app for refund / purge-user. Tests inject one. */
  openApp?(cfg: Config): Promise<App>;
}

class UsageError extends Error {}

const dbPathOf = (cfg: Config): string => join(cfg.dataDir, 'gora.db');

function parseTgId(v: string | undefined): number {
  const n = Number(v);
  if (!v || !Number.isSafeInteger(n) || n <= 0) throw new UsageError('expected a positive Telegram user id');
  return n;
}

function withDb<T>(cfg: Config, fn: (db: Db) => T): T {
  const db = openDb(dbPathOf(cfg));
  try {
    migrate(db, { now: systemClock().now() });
    return fn(db);
  } finally {
    db.close();
  }
}

function userIdOf(db: Db, tgUserId: number): string {
  const r = db.prepare('SELECT id FROM users WHERE tg_user_id = ?').get<{ id: string }>(tgUserId);
  if (!r) throw new Error(`no user with Telegram id ${tgUserId}`);
  return r.id;
}

export function stats(cfg: Config, now: number): Record<string, unknown> {
  return withDb(cfg, (db) => {
    const group = (sql: string, ...p: Array<string | number>) =>
      Object.fromEntries(db.prepare(sql).all<{ k: string; n: number }>(...p).map((r) => [r.k, Number(r.n)]));
    const one = (sql: string, ...p: Array<string | number>) => Number(db.prepare(sql).get<{ n: number }>(...p)?.n ?? 0);
    const day = new Date(now).toISOString().slice(0, 10);
    const since = now - 24 * 3_600_000;
    return {
      at: new Date(now).toISOString(),
      usersByStatus: group('SELECT status AS k, COUNT(*) AS n FROM users GROUP BY status'),
      usersByPlan: group('SELECT plan AS k, COUNT(*) AS n FROM users GROUP BY plan'),
      conversationsByKind: group(`SELECT kind AS k, COUNT(*) AS n FROM conversations WHERE status = 'active' GROUP BY kind`),
      runs24hByState: group('SELECT state AS k, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY state', since),
      llmCalls24h: one('SELECT COUNT(*) AS n FROM llm_calls WHERE created_at >= ?', since),
      usageToday: db
        .prepare('SELECT COALESCE(SUM(turns),0) AS turns, COALESCE(SUM(cost_micros),0) AS costMicros, COALESCE(SUM(refusals),0) AS refusals FROM usage_daily WHERE day = ?')
        .get<Record<string, number>>(day),
      ledgerRows: one('SELECT COUNT(*) AS n FROM ledger'),
      deletionRequests: group('SELECT status AS k, COUNT(*) AS n FROM deletion_requests GROUP BY status'),
      epochsAwaitingShred: one('SELECT COUNT(*) AS n FROM epochs WHERE closed_at IS NOT NULL AND shredded_at IS NULL'),
    };
  });
}

export function verifyLedger(cfg: Config, tgUserId: number): { tgUserId: number; ok: boolean; brokenAtSeq?: number } {
  return withDb(cfg, (db) => {
    const userId = userIdOf(db, tgUserId);
    const ks = openKeyStore(cfg.keysDbPath, cfg.secrets.kek);
    try {
      const crypto = createCrypto(ks, cfg.secrets.hashKey);
      const ledger = createLedgerCore(() => db, () => crypto, () => systemClock());
      return { tgUserId, ...ledger.verify(userId) };
    } finally {
      ks.close();
    }
  });
}

export async function setWebhook(cfg: Config, fetchImpl: typeof fetch): Promise<{ ok: boolean; url: string; allowedUpdates: string[]; description?: string }> {
  const token = cfg.telegram.token;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  if (!cfg.publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must be https for a webhook');
  const url = cfg.publicUrl.replace(/\/+$/, '') + '/tg/webhook';
  const updates = allowedUpdates(cfg.features);
  const endpoint = `${cfg.telegram.apiRoot}/bot${token}/${cfg.telegram.testEnv ? 'test/' : ''}setWebhook`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, secret_token: cfg.telegram.webhookSecret, allowed_updates: updates, max_connections: 40, drop_pending_updates: false }),
  });
  let body: { ok?: boolean; description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error page */
  }
  const out: { ok: boolean; url: string; allowedUpdates: string[]; description?: string } = { ok: body.ok === true, url, allowedUpdates: updates };
  if (typeof body.description === 'string') out.description = body.description;
  return out;
}

/** Re-wraps every live DEK under the new KEK. Takes the single-writer lock and backs keys.db up first (7-day retention applies). */
export async function rewrap(cfg: Config, env: Record<string, string | undefined>, now: number): Promise<{ rewrapped: number; kekVersion: number; backup: string }> {
  const issues: string[] = [];
  const newKek = decodeKey('GORA_KEK_NEW', env.GORA_KEK_NEW, issues);
  if (!newKek) throw new UsageError(issues[0] ?? 'GORA_KEK_NEW (base64, 32 bytes) is required');
  const release = acquireLock(dbPathOf(cfg) + '.lock');
  let ks: KeyStore | undefined;
  try {
    ks = openKeyStore(cfg.keysDbPath, cfg.secrets.kek);
    const backup = join(cfg.backupDir, 'keys', `keys-${backupStamp(now)}.db`);
    await ks.backup(backup);
    const kekVersion = ks.kekVersion + 1;
    const rewrapped = ks.rewrap(newKek, kekVersion);
    return { rewrapped, kekVersion, backup };
  } finally {
    ks?.close();
    newKek.fill(0);
    release();
  }
}

async function withApp<T>(d: AdminDeps, fn: (app: App) => Promise<T>): Promise<T> {
  const app = d.openApp
    ? await d.openApp(d.config)
    : await createApp({ config: d.config, log: createLogger({ level: 'warn' }), fetchImpl: d.fetchImpl, lock: false });
  try {
    return await fn(app);
  } finally {
    await app.stop({ graceMs: 0, drainMs: 5_000 });
  }
}

/** Runs one admin command. Returns the process exit code. */
export async function runAdmin(argv: string[], d: AdminDeps): Promise<number> {
  const [cmd, a1, a2] = argv;
  const print = (v: unknown) => d.out(JSON.stringify(v, null, 2));
  try {
    switch (cmd) {
      case 'stats':
        print(stats(d.config, systemClock().now()));
        return 0;
      case 'verify-ledger': {
        const r = verifyLedger(d.config, parseTgId(a1));
        print(r);
        return r.ok ? 0 : 1;
      }
      case 'purge-user': {
        const tgUserId = parseTgId(a1);
        await withApp(d, async (app) => {
          const u = app.s.repos.users.getByTg(tgUserId);
          if (!u) throw new Error(`no user with Telegram id ${tgUserId}`);
          await app.s.privacy.deleteUser(u.id, 'admin');
        });
        print({ purged: true, tgUserId });
        return 0;
      }
      case 'refund': {
        const tgUserId = parseTgId(a1);
        if (!a2) throw new UsageError('expected a telegram_payment_charge_id');
        await withApp(d, (app) => app.s.payments.refund(tgUserId, a2));
        print({ refunded: true, tgUserId, chargeId: a2 });
        return 0;
      }
      case 'set-webhook': {
        const r = await setWebhook(d.config, d.fetchImpl);
        print(r);
        return r.ok ? 0 : 1;
      }
      case 'rewrap': {
        const r = await rewrap(d.config, d.env, systemClock().now());
        print(r);
        d.err('rewrap done: set GORA_KEK to the new key (GORA_KEK_NEW) before starting the server.');
        return 0;
      }
      default:
        d.err(USAGE);
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    d.err(`admin ${cmd}: ${errorMessage(e)}`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    process.stderr.write(`${errorMessage(e)}\n`);
    process.exit(1);
  }
  const code = await runAdmin(process.argv.slice(2), {
    config,
    env: process.env,
    fetchImpl: globalThis.fetch,
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
  });
  process.exit(code);
}
