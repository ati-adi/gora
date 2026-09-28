// Review (platform): ledger.append() truncates the summary with String.slice at a UTF-16 index (ledger.ts oneLine), which
// can cut an emoji / astral character in half and leave a lone surrogate. The HMAC is computed over that JS string
// (canonicalJson escapes the lone surrogate as "\ud83d"), but seal() encodes it with TextEncoder, which replaces the
// lone surrogate with U+FFFD. verify() decrypts U+FFFD, recomputes a different HMAC and reports the chain BROKEN at
// that seq forever — a false tamper alarm on the Mini App "Ledger verified" check for a perfectly intact ledger.
// FIXED: src/ledger/ledger.ts oneLine() cuts on a code-point boundary and stores a well-formed string.
import { afterEach, describe, expect, it } from 'vitest';
import { createLedgerCore } from '../../../src/ledger/index.ts';
import { dbEnv, mkUser, type DbEnv } from '../../unit/db/env.ts';

let e: DbEnv | undefined;
afterEach(() => e?.dispose());

describe('ledger verify with astral characters at the 300-char summary cut', () => {
  it('an untampered ledger whose summary had an emoji straddling the cut still verifies', () => {
    e = dbEnv();
    const ledger = createLedgerCore(() => e!.db, () => e!.crypto, () => e!.clock);
    const u = mkUser(e).id;
    // 298 ASCII chars then an emoji: slice(0, 299) keeps only the emoji's high surrogate.
    const summary = 'a'.repeat(298) + '😀' + ' tail that pushes the summary over 300 chars';
    ledger.append({ userId: u, actor: 'user', kind: 'settings', summary });
    ledger.append({ userId: u, actor: 'user', kind: 'settings', summary: 'next' });
    expect(ledger.verify(u)).toEqual({ ok: true });
    const [, first] = ledger.list(u, { limit: 2 });
    expect(first!.summary).toBe('a'.repeat(298) + '…');
  });

  it('a summary that itself carries a lone surrogate still verifies', () => {
    e = dbEnv();
    const ledger = createLedgerCore(() => e!.db, () => e!.crypto, () => e!.clock);
    const u = mkUser(e).id;
    ledger.append({ userId: u, actor: 'user', kind: 'settings', summary: 'broken \ud83d text' });
    expect(ledger.verify(u)).toEqual({ ok: true });
  });
});
