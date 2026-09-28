// WP2 — callback codec (01 §15.2): callback_data ≤ 64 bytes; MAC and owner binding.
import { describe, expect, it } from 'vitest';
import { createCallbackCodec } from '../../../src/telegram/callbackCodec.ts';

const key = new Uint8Array(32).fill(3);
const codec = createCallbackCodec(key);

describe('callback codec', () => {
  it('round-trips kind and parts for the owner', () => {
    const d = codec.encode('a1', ['A7K2QX', 'y'], 1001);
    expect(d.startsWith('a1:A7K2QX:y:')).toBe(true);
    expect(codec.decode(d, 1001)).toEqual({ kind: 'a1', parts: ['A7K2QX', 'y'] });
    expect(codec.decode(codec.encode('dl', [], 1001), 1001)).toEqual({ kind: 'dl', parts: [] });
  });
  it('binds to the owner: another user gets not_owner; owner 0 accepts any group member', () => {
    const d = codec.encode('td', ['t_1'], 1001);
    expect(codec.decode(d, 1002)).toEqual({ error: 'not_owner' });
    const any = codec.encode('pl', ['p1', '2'], 0);
    expect(codec.decode(any, 1002)).toEqual({ kind: 'pl', parts: ['p1', '2'] });
    expect(codec.decode(any, 555)).toEqual({ kind: 'pl', parts: ['p1', '2'] });
  });
  it('rejects forged MACs, changed parts, other keys and malformed data', () => {
    const d = codec.encode('a1', ['A7K2QX', 'y'], 1001);
    const flipOwnerMac = d.slice(0, -3) + (d.at(-3) === 'A' ? 'B' : 'A') + d.slice(-2);
    expect(codec.decode(flipOwnerMac, 1001)).toHaveProperty('error'); // rejected (reported as not_owner: the tag still matches)
    const flipTag = d.slice(0, -1) + (d.at(-1) === 'A' ? 'B' : 'A');
    expect(codec.decode(flipTag, 1001)).toEqual({ error: 'bad_mac' });
    expect(codec.decode(d.replace(':y:', ':n:'), 1001)).toEqual({ error: 'bad_mac' });
    expect(codec.decode(d.replace('a1:', 'ud:'), 1001)).toEqual({ error: 'bad_mac' });
    expect(createCallbackCodec(new Uint8Array(32).fill(4)).decode(d, 1001)).toEqual({ error: 'bad_mac' });
    for (const bad of ['', 'a1', 'zz:x:AAAAAAAAAAAA', 'a1:x:short', 'x'.repeat(65), 'a1:X|1001']) expect(codec.decode(bad, 1001)).toEqual({ error: 'malformed' });
  });
  it('never exceeds 64 bytes (throws instead) and rejects separators in parts', () => {
    const d = codec.encode('ct', ['c_01JABCDEFGHJKMNPQRSTVWXYZ0', 'r'], 1234567890);
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(() => codec.encode('mm', ['x'.repeat(60)], 1)).toThrow(/64 bytes/);
    expect(() => codec.encode('mm', ['a:b'], 1)).toThrow();
    expect(() => codec.encode('zz' as 'mm', [], 1)).toThrow(/unknown/);
    for (const kind of ['a1', 'ud', 'ob', 'ch', 'td', 'rm', 'ng', 'mm', 'ms', 'wt', 'bz', 'cn', 'pl', 'ct', 'tz', 'dl', 'vo'] as const) {
      expect(Buffer.byteLength(codec.encode(kind, ['01JABCDEFGHJKMNPQRSTVWXYZ0'], 9_999_999_999))).toBeLessThanOrEqual(64);
    }
  });
});
