// Shared fixture for WP1 unit tests: a migrated gora.db + a real keys.db + real crypto/repos over a FakeClock.
import type { ConversationRow, CoreRepos, Crypto, KeyStore } from '../../../src/contracts/storage.ts';
import { createCrypto } from '../../../src/db/crypto.ts';
import { openKeyStore } from '../../../src/db/keystore.ts';
import { createCoreRepos } from '../../../src/db/repos/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';

export const KEK = new Uint8Array(32).fill(7);
export const HASH_KEY = new Uint8Array(32).fill(9);

export interface DbEnv extends TmpDb { clock: FakeClock; ks: KeyStore; crypto: Crypto; repos: CoreRepos; dispose(): void }

export function dbEnv(o: { now?: number } = {}): DbEnv {
  const clock = new FakeClock(o.now);
  const t = openTmpDb({ now: clock.now() });
  const ks = openKeyStore(t.keysDbPath, KEK, { clock });
  const crypto = createCrypto(ks, HASH_KEY);
  const repos = createCoreRepos(t.db, crypto, clock);
  return {
    ...t,
    clock,
    ks,
    crypto,
    repos,
    dispose() {
      try {
        ks.close();
      } catch {
        /* closed */
      }
      t.cleanup();
    },
  };
}

let tg = 5000;
export function mkUser(e: Pick<DbEnv, 'repos'>, o: { tgId?: number; tz?: string; plan?: 'free' | 'plus' | 'pro' } = {}) {
  const u = e.repos.users.upsertFromTelegram({ id: o.tgId ?? ++tg, first_name: 'Ann', language_code: 'en' }, { dmChatId: o.tgId ?? tg });
  if (o.tz || o.plan) e.repos.users.update(u.id, { ...(o.tz ? { tz: o.tz } : {}), ...(o.plan ? { plan: o.plan } : {}) });
  return e.repos.users.getById(u.id)!;
}

export function mkConv(e: Pick<DbEnv, 'repos'>, userId: string | null, o: Partial<Pick<ConversationRow, 'kind' | 'scopeKey' | 'tgChatId' | 'businessConnectionId' | 'route' | 'toolset'>> = {}): ConversationRow {
  const kind = o.kind ?? 'dm';
  return e.repos.conversations.create({
    scopeKey: o.scopeKey ?? `${kind}:${userId ?? 'x'}:${Math.random().toString(36).slice(2)}`,
    kind,
    userId,
    tgChatId: o.tgChatId ?? null,
    threadId: null,
    businessConnectionId: o.businessConnectionId ?? null,
    route: o.route ?? (kind === 'guest' ? 'guest' : kind === 'biz_draft' ? 'biz' : kind === 'group' ? 'group' : 'chat'),
    model: 'claude-opus-5',
    effort: 'medium',
    toolset: o.toolset ?? (kind === 'guest' ? 'GUEST' : kind === 'biz_draft' ? 'BIZ' : kind === 'group' ? 'GROUP' : 'FULL'),
    toolsHash: 'h',
    systemVersion: 'v',
    betas: [],
    contextMode: 'system',
    singleShot: kind === 'guest',
  });
}

/** Appends a user turn + an assistant answer (valid grammar). */
export function chat(e: Pick<DbEnv, 'repos'>, convId: string, epoch: number, q: string, a: string, runId?: string): number[] {
  return e.repos.messages.append(convId, epoch, [
    { role: 'user', kind: 'user_input', content: { role: 'user', content: [{ type: 'text', text: q }] } },
    { role: 'assistant', kind: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: a }] }, ...(runId ? { runId } : {}), stopReason: 'end_turn' },
  ]);
}
