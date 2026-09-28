// WP1 — 01 §15.2: round trip; an AAD mismatch fails; a destroyed DEK throws DekDestroyedError and cannot be re-created;
// a wrong KEK fails; keys.db is a separate file. Plus envelope format, LRU/TTL, destroyOwner, rewrap and backup.
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeyStore } from '../../../src/contracts/storage.ts';
import { createCrypto, ENVELOPE_VERSION, isShredded, ownerOfDek, parseEnvelope } from '../../../src/db/crypto.ts';
import { KeyStoreError, openKeyStore } from '../../../src/db/keystore.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { DekDestroyedError } from '../../../src/kernel/errors.ts';
import { openTmpDb, type TmpDb } from '../../harness/tmpDb.ts';

const KEK = new Uint8Array(32).fill(7);
const HASH = new Uint8Array(32).fill(9);

let t: TmpDb | null = null;
const stores: KeyStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  t?.cleanup();
  t = null;
});

function setup(kek = KEK, clock?: FakeClock) {
  t ??= openTmpDb();
  const ks = openKeyStore(t.keysDbPath, kek, clock ? { clock } : {});
  stores.push(ks);
  return { ks, crypto: createCrypto(ks, HASH) };
}

describe('crypto (01 §11.7)', () => {
  it('round-trips text, bytes and JSON with the envelope 0x01 ‖ len ‖ dek_id ‖ iv ‖ tag ‖ ct', () => {
    const { crypto } = setup();
    const ct = crypto.seal('u:U1', 'hello', 'users|first_name_enc|U1');
    expect(ct[0]).toBe(ENVELOPE_VERSION);
    expect(ct[1]).toBe('u:U1'.length);
    const env = parseEnvelope(ct);
    expect(env.dek).toBe('u:U1');
    expect(env.iv.length).toBe(12);
    expect(env.tag.length).toBe(16);
    expect(crypto.openText(ct, 'users|first_name_enc|U1')).toBe('hello');
    const bin = randomBytes(100);
    expect(Buffer.from(crypto.open(crypto.seal('u:U1', bin, 'a'), 'a'))).toEqual(bin);
    expect(crypto.openJson(crypto.sealJson('u:U1', { a: [1, 'x'] }, 'j'), 'j')).toEqual({ a: [1, 'x'] });
    // Fresh IV every time.
    expect(Buffer.from(crypto.seal('u:U1', 'hello', 'x'))).not.toEqual(Buffer.from(crypto.seal('u:U1', 'hello', 'x')));
  });

  it('an AAD mismatch or a tampered byte fails', () => {
    const { crypto } = setup();
    const ct = crypto.seal('u:U1', 'secret', 'messages|content_enc|c1:1:1');
    expect(() => crypto.open(ct, 'messages|content_enc|c1:1:2')).toThrow(/authentication failed/);
    const bad = new Uint8Array(ct);
    bad[bad.length - 1]! ^= 1;
    expect(() => crypto.open(bad, 'messages|content_enc|c1:1:1')).toThrow(/authentication failed/);
    expect(() => crypto.open(new Uint8Array([2, 0]), 'x')).toThrow(/envelope/);
    expect(() => crypto.open(new Uint8Array([1, 5, 1]), 'x')).toThrow(/malformed/);
  });

  it('a destroyed DEK throws DekDestroyedError on open and seal, and can never be re-created', () => {
    const { ks, crypto } = setup();
    const ct = crypto.seal('u:U1', 'x', 'a');
    crypto.destroyDek('u:U1');
    expect(crypto.isDestroyed('u:U1')).toBe(true);
    expect(() => crypto.open(ct, 'a')).toThrow(DekDestroyedError);
    let err: unknown;
    try {
      crypto.open(ct, 'a');
    } catch (e) {
      err = e;
    }
    expect(isShredded(err)).toBe(true);
    expect(() => crypto.seal('u:U1', 'y', 'a')).toThrow(DekDestroyedError);
    expect(() => crypto.ensureDek('u:U1', 'U1', 'data')).toThrow(DekDestroyedError);
    expect(() => ks.getOrCreate('u:U1', 'U1', 'data')).toThrow(DekDestroyedError);
    // Survives a reopen (tombstone in keys.db, not just the cache).
    ks.close();
    const ks2 = openKeyStore(t!.keysDbPath, KEK);
    stores.push(ks2);
    expect(ks2.isDestroyed('u:U1')).toBe(true);
    expect(() => ks2.getOrCreate('u:U1', 'U1', 'data')).toThrow(DekDestroyedError);
  });

  it('a wrong KEK fails at open time', () => {
    const { ks, crypto } = setup();
    crypto.seal('u:U1', 'x', 'a');
    ks.close();
    expect(() => openKeyStore(t!.keysDbPath, new Uint8Array(32).fill(8))).toThrow(KeyStoreError);
    expect(() => openKeyStore(t!.keysDbPath, new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it('keys.db is a separate file from gora.db and holds no plaintext DEKs', () => {
    const { crypto } = setup();
    crypto.seal('u:U1', 'x', 'a');
    expect(t!.keysDbPath).not.toBe(t!.dbPath);
    expect(existsSync(t!.keysDbPath)).toBe(true);
    expect(statSync(t!.keysDbPath).isFile()).toBe(true);
    const tables = t!.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deks'`).all();
    expect(tables).toEqual([]);
  });

  it('epoch DEKs need ensureDek (owner cannot be derived); destroyOwner covers every DEK of the owner', () => {
    const { crypto } = setup();
    expect(ownerOfDek('u:U1')).toBe('U1');
    expect(ownerOfDek('m:U1:3')).toBe('U1');
    expect(ownerOfDek('g:-100')).toBe('grp:-100');
    expect(ownerOfDek('e:c1:1')).toBeNull();
    expect(() => crypto.seal('e:c1:1', 'x', 'a')).toThrow(/ensureDek/);
    crypto.ensureDek('e:c1:1', 'U1', 'epoch');
    crypto.ensureDek('e:c1:1', 'someone-else', 'epoch'); // idempotent; keeps its owner
    const a = crypto.seal('e:c1:1', 'x', 'a');
    crypto.seal('u:U1', 'x', 'a');
    crypto.seal('m:U1:1', 'x', 'a');
    crypto.seal('u:U2', 'x', 'a');
    expect(crypto.destroyOwner('U1')).toBe(3);
    expect(() => crypto.open(a, 'a')).toThrow(DekDestroyedError);
    expect(crypto.isDestroyed('u:U2')).toBe(false);
    expect(crypto.destroyOwner('U1')).toBe(0);
  });

  it('hmac is keyed and domain-separated', () => {
    const { crypto } = setup();
    expect(crypto.hmac('content', 'abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.hmac('content', 'abc')).toBe(crypto.hmac('content', 'abc'));
    expect(crypto.hmac('content', 'abc')).not.toBe(crypto.hmac('target', 'abc'));
    const other = createCrypto(setup().ks, new Uint8Array(32).fill(1));
    expect(other.hmac('content', 'abc')).not.toBe(crypto.hmac('content', 'abc'));
  });

  it('rewrap moves every live DEK to the new KEK; the old KEK no longer opens keys.db', () => {
    const { ks, crypto } = setup();
    const ct = crypto.seal('u:U1', 'x', 'a');
    crypto.seal('u:U2', 'y', 'a');
    crypto.destroyDek('u:U2');
    const newKek = new Uint8Array(32).fill(3);
    expect(ks.rewrap(newKek, ks.kekVersion + 1)).toBe(1);
    ks.close();
    expect(() => openKeyStore(t!.keysDbPath, KEK)).toThrow(KeyStoreError);
    const ks2 = openKeyStore(t!.keysDbPath, newKek);
    stores.push(ks2);
    expect(ks2.kekVersion).toBe(2);
    expect(createCrypto(ks2, HASH).openText(ct, 'a')).toBe('x');
    expect(ks2.isDestroyed('u:U2')).toBe(true);
  });

  it('the unwrapped-DEK cache expires (TTL) and still serves the key from keys.db', () => {
    const clock = new FakeClock();
    const { ks } = setup(KEK, clock);
    const k1 = ks.getOrCreate('u:U1', 'U1', 'data');
    clock.advance(11 * 60_000);
    expect(Buffer.from(ks.get('u:U1')!)).toEqual(Buffer.from(k1));
    expect(ks.get('u:never')).toBeUndefined();
  });

  it('backup() copies keys.db, including tombstones', async () => {
    const { ks, crypto } = setup();
    crypto.seal('u:U1', 'x', 'a');
    crypto.destroyDek('u:U1');
    const dest = join(t!.backupDir, 'keys', 'k.db');
    await ks.backup(dest);
    const copy = openKeyStore(dest, KEK);
    stores.push(copy);
    expect(copy.isDestroyed('u:U1')).toBe(true);
  });
});
