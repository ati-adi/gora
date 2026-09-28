// db/crypto.ts (WP1) — envelope encryption over the KeyStore (01 §11.7).
//
// Envelope: 0x01 ‖ len(dek_id) (1 byte) ‖ dek_id (UTF-8) ‖ iv(12) ‖ tag(16) ‖ ciphertext — AES-256-GCM with the caller's
// AAD ('<table>|<column>|<row key>'). The DEK id travels inside the envelope, so open() needs only the AAD.
// HMACs are HMAC-SHA256 under GORA_HASH_KEY over `domain ‖ 0x00 ‖ data`, hex-encoded.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Crypto, DekId, KeyStore } from '../contracts/storage.ts';
import { DekDestroyedError, GoraError } from '../kernel/errors.ts';

export class CryptoError extends GoraError {
  override name = 'CryptoError';
}

export const ENVELOPE_VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/**
 * The owner of a DEK that seal() may create lazily, derived from its id (contracts/storage.ts DEK owner rules).
 * Epoch DEKs ('e:<conv>:<n>') cannot be attributed from the id and MUST be created with ensureDek() first: null.
 */
export function ownerOfDek(dek: DekId): string | null {
  const i = dek.indexOf(':');
  const kind = i < 0 ? dek : dek.slice(0, i);
  const rest = i < 0 ? '' : dek.slice(i + 1);
  const first = rest.split(':')[0] ?? '';
  switch (kind) {
    case 'sys':
      return rest === '' ? 'sys' : null;
    case 'u':
    case 'm':
      return first ? first : null;
    case 'g':
    case 'mg':
      return first ? `grp:${first}` : null;
    case 'b':
      return rest ? `biz:${rest}` : null;
    default:
      return null;
  }
}

export function parseEnvelope(ct: Uint8Array): { dek: DekId; iv: Uint8Array; tag: Uint8Array; body: Uint8Array } {
  if (!(ct instanceof Uint8Array) || ct.length < 2) throw new CryptoError('crypto: malformed envelope');
  if (ct[0] !== ENVELOPE_VERSION) throw new CryptoError('crypto: unknown envelope version');
  const n = ct[1]!;
  const start = 2 + n;
  if (n === 0 || ct.length < start + IV_LEN + TAG_LEN) throw new CryptoError('crypto: malformed envelope');
  let dek: string;
  try {
    dek = dec.decode(ct.subarray(2, start));
  } catch {
    throw new CryptoError('crypto: malformed envelope');
  }
  return { dek, iv: ct.subarray(start, start + IV_LEN), tag: ct.subarray(start + IV_LEN, start + IV_LEN + TAG_LEN), body: ct.subarray(start + IV_LEN + TAG_LEN) };
}

export function createCrypto(ks: KeyStore, hashKey: Uint8Array): Crypto {
  if (!(hashKey instanceof Uint8Array) || hashKey.length < 32) throw new CryptoError('GORA_HASH_KEY must be at least 32 bytes');
  const hk = Buffer.from(hashKey);

  const keyForSeal = (dek: DekId): Uint8Array => {
    const existing = ks.get(dek); // throws DekDestroyedError when destroyed
    if (existing) return existing;
    const owner = ownerOfDek(dek);
    if (owner === null) throw new CryptoError(`crypto: DEK ${dek.split(':')[0]}:… must be created with ensureDek() before seal()`);
    return ks.getOrCreate(dek, owner, 'data');
  };

  const c: Crypto = {
    seal(dek, plaintext, aad) {
      const idBytes = enc.encode(dek);
      if (idBytes.length === 0 || idBytes.length > 255) throw new CryptoError('crypto: invalid DEK id');
      const key = keyForSeal(dek);
      const iv = randomBytes(IV_LEN);
      const ci = createCipheriv('aes-256-gcm', key, iv);
      ci.setAAD(enc.encode(aad));
      const body = Buffer.concat([ci.update(typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext), ci.final()]);
      return new Uint8Array(Buffer.concat([Buffer.from([ENVELOPE_VERSION, idBytes.length]), idBytes, iv, ci.getAuthTag(), body]));
    },
    open(ct, aad) {
      const e = parseEnvelope(ct);
      const key = ks.get(e.dek);
      if (!key) throw new CryptoError('crypto: unknown DEK');
      const d = createDecipheriv('aes-256-gcm', key, e.iv);
      d.setAAD(enc.encode(aad));
      d.setAuthTag(e.tag);
      try {
        return new Uint8Array(Buffer.concat([d.update(e.body), d.final()]));
      } catch {
        throw new CryptoError('crypto: authentication failed (wrong AAD or tampered ciphertext)');
      }
    },
    openText(ct, aad) {
      return new TextDecoder().decode(c.open(ct, aad));
    },
    sealJson(dek, v, aad) {
      const s = JSON.stringify(v);
      return c.seal(dek, s === undefined ? 'null' : s, aad);
    },
    openJson<T>(ct: Uint8Array, aad: string): T {
      return JSON.parse(c.openText(ct, aad)) as T;
    },
    hmac(domain, data) {
      return createHmac('sha256', hk).update(domain, 'utf8').update(Buffer.from([0])).update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
    },
    destroyDek(dek) {
      ks.destroy(dek);
    },
    destroyOwner(owner) {
      return ks.destroyOwner(owner);
    },
    isDestroyed(dek) {
      return ks.isDestroyed(dek);
    },
    ensureDek(dek, owner, purpose) {
      ks.getOrCreate(dek, owner, purpose);
    },
  };
  return c;
}

/** True when `e` means "this ciphertext can never be opened again" (its DEK was shredded). */
export function isShredded(e: unknown): boolean {
  return e instanceof DekDestroyedError;
}
