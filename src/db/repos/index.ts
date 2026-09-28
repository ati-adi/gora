// db/repos/index.ts (WP1) — the core repos over gora.db (01 §4.4 contracts/storage.ts, §7.2 WP1 tables).
import type { Clock } from '../../contracts/common.ts';
import type { CoreRepos, Crypto, Db } from '../../contracts/storage.ts';
import { createConversationsRepo } from './conversations.ts';
import { createInputsRepo } from './inputs.ts';
import { createKvRepo } from './kv.ts';
import { createMessagesRepo } from './messages.ts';
import { createRunsRepo } from './runs.ts';
import { createUsersRepo } from './users.ts';

export function createCoreRepos(db: Db, crypto: Crypto, clock: Clock): CoreRepos {
  const x = { db, crypto, clock };
  return {
    users: createUsersRepo(x),
    conversations: createConversationsRepo(x),
    messages: createMessagesRepo(x),
    inputs: createInputsRepo(x),
    runs: createRunsRepo(x),
    kv: createKvRepo(db, clock),
  };
}

export { createUsageRepo, type UsageRepo, type UsageDay } from './usage.ts';
export { DEFAULT_SETTINGS } from './users.ts';
