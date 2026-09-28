// ledger/index.ts (WP1) — createLedger(s): the per-user hash-chained ledger over s.db / s.crypto / s.clock.
import type { Ledger, Services } from '../contracts/index.ts';
import { createLedgerCore } from './ledger.ts';

export function createLedger(s: Services): Ledger {
  return createLedgerCore(() => s.db, () => s.crypto, () => s.clock);
}

export { createLedgerCore, LEDGER_GENESIS, ledgerRowMaterial } from './ledger.ts';
