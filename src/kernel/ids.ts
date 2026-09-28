// kernel/ids.ts (WP0) — ULIDs, short ids, draft ids and random tokens.
import { randomBytes, randomInt } from 'node:crypto';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

let lastTime = -1;
let lastRandom: number[] = [];

/** Monotonic ULID (26 chars, Crockford base32). `now` comes from a Clock. */
export function ulid(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('ulid: bad time');
  let rnd: number[];
  if (now <= lastTime && lastRandom.length === 16) {
    // same (or earlier) millisecond: increment the random part to stay monotonic
    rnd = lastRandom.slice();
    for (let i = 15; i >= 0; i--) {
      if (rnd[i]! < 31) {
        rnd[i]!++;
        break;
      }
      rnd[i] = 0;
    }
    now = lastTime;
  } else {
    const b = randomBytes(16);
    rnd = Array.from(b, (x) => x & 31);
  }
  lastTime = now;
  lastRandom = rnd;
  let t = '';
  let n = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[n % 32] + t;
    n = Math.floor(n / 32);
  }
  return t + rnd.map((x) => CROCKFORD[x]).join('');
}

/** '<prefix>_<ulid>' e.g. newId('b', now) → 'b_01J…' (blob ids per 01 §4.4). */
export function newId(prefix: string, now: number): string {
  return `${prefix}_${ulid(now)}`;
}

/** 6-char Crockford base32, upper case (pending action ids like 'A7K2QX'). */
export function shortId(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CROCKFORD[randomInt(32)];
  return s;
}

/** Memory fact id: 'm' + 6 base36 chars. */
export function factId(): string {
  let s = 'm';
  for (let i = 0; i < 6; i++) s += BASE36[randomInt(36)];
  return s;
}

/** Random non-zero positive int32 for sendMessageDraft / sendRichMessageDraft. */
export function draftId(): number {
  return randomInt(1, 2 ** 31 - 1);
}

/** URL-safe random token (base64url), default 16 bytes. */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}
