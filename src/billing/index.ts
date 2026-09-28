// billing/index.ts (WP1) — createQuotaService(s): quotas over s.db / s.clock (01 §11.8, §13). Payments are WP7's.
import type { QuotaService, Services } from '../contracts/index.ts';
import { createQuotas } from './quotas.ts';

export function createQuotaService(s: Services): QuotaService {
  return createQuotas({ db: () => s.db, clock: () => s.clock, log: () => s.log });
}

export { createQuotas, nextLocalMidnight, planLimit, QUOTA_KINDS, COOLDOWN_MS, PERSISTED_WINDOW_MS, cooldownKey } from './quotas.ts';
