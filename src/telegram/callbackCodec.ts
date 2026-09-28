// telegram/callbackCodec.ts (WP2) — MAC'd, owner-bound callback_data (≤ 64 bytes; 01 §4.4 CallbackCodec, §5.6 step 1).
//
// Format: `<kind>:<part>:<part>…:<mac>` where mac = 12 base64url chars:
//   - 10 chars of HMAC-SHA256(GORA_CALLBACK_KEY, 'o|<kind>|<parts…>|<ownerTgId>')  — binds the button to its owner
//     (ownerTgId 0 = any member of a group chat);
//   - 2 chars of HMAC-SHA256(GORA_CALLBACK_KEY, 't|<kind>|<parts…>')              — owner-independent tag, used only to
//     tell "someone else's button" (not_owner) from a forgery (bad_mac). Both outcomes are rejections.
// The owner id is never written into the data (it would cost bytes and leak ids to forwarded screenshots).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CallbackCodec, CallbackKind } from '../contracts/index.ts';

export const CALLBACK_KINDS: readonly CallbackKind[] = Object.freeze(['a1', 'ud', 'ob', 'ch', 'td', 'rm', 'ng', 'mm', 'ms', 'wt', 'bz', 'cn', 'pl', 'ct', 'tz', 'dl', 'vo']);
const KIND_SET = new Set<string>(CALLBACK_KINDS);
const MAX_BYTES = 64;
const OWNER_MAC_LEN = 10;
const TAG_LEN = 2;

export function createCallbackCodec(key: Uint8Array): CallbackCodec {
  if (key.length < 16) throw new Error('callback key too short');
  const mac = (msg: string, len: number) => createHmac('sha256', key).update(msg).digest('base64url').slice(0, len);
  const ownerMac = (kind: string, parts: string[], owner: number) => mac(`o|${kind}|${parts.join('|')}|${owner}`, OWNER_MAC_LEN);
  const tag = (kind: string, parts: string[]) => mac(`t|${kind}|${parts.join('|')}`, TAG_LEN);
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  return {
    encode(kind, parts, ownerTgId) {
      if (!KIND_SET.has(kind)) throw new Error(`unknown callback kind: ${kind}`);
      if (!Number.isSafeInteger(ownerTgId) || ownerTgId < 0) throw new Error('callback owner must be a Telegram user id or 0');
      for (const p of parts) if (p.includes(':') || p.includes('|')) throw new Error('callback part must not contain ":" or "|"');
      const data = [kind, ...parts, ownerMac(kind, parts, ownerTgId) + tag(kind, parts)].join(':');
      if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) throw new Error(`callback_data exceeds ${MAX_BYTES} bytes (${kind})`);
      return data;
    },
    decode(data, fromTgId) {
      if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_BYTES) return { error: 'malformed' };
      const segs = data.split(':');
      if (segs.length < 2) return { error: 'malformed' };
      const kind = segs[0]!;
      const m = segs[segs.length - 1]!;
      if (!KIND_SET.has(kind) || !/^[A-Za-z0-9_-]{12}$/.test(m)) return { error: 'malformed' };
      const parts = segs.slice(1, -1);
      const om = m.slice(0, OWNER_MAC_LEN);
      const tg = m.slice(OWNER_MAC_LEN);
      if (eq(om, ownerMac(kind, parts, fromTgId)) || eq(om, ownerMac(kind, parts, 0))) {
        if (!eq(tg, tag(kind, parts))) return { error: 'bad_mac' };
        return { kind: kind as CallbackKind, parts };
      }
      return eq(tg, tag(kind, parts)) ? { error: 'not_owner' } : { error: 'bad_mac' };
    },
  };
}
