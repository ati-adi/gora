import { describe, expect, it } from 'vitest';
import { luhnValid, redact } from '../../../src/trust/redact.ts';

// 01 §11.6: a table of positive and negative examples.
const positive: Array<[string, string]> = [
  ['Your verification code is 482913.', 'Your verification code is [code removed].'],
  ['Код подтверждения: 5521', 'Код подтверждения: [code removed]'],
  ['OTP 123 456 expires soon', 'OTP [code removed] expires soon'],
  ['Your one-time passcode: 99812345', 'Your one-time passcode: [code removed]'],
  ['Reset your password: https://acme.com/reset?token=abc123', 'Reset your password: [login link removed]'],
  ['Sign in: https://app.example.com/magic/xyz', 'Sign in: [login link removed]'],
  ['Confirm https://x.io/__/auth/action?mode=verifyEmail&oobCode=Q1', 'Confirm [login link removed]'],
  ['api_key: sk_live_AbCdEfGhIjKlMnOpQrStUvWx12', 'api_key: [secret removed]'],
  ['The token is ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'The token is [secret removed]'],
  ['Card 4111 1111 1111 1111 exp 12/27', 'Card [card number removed] exp 12/27'],
  ['pay with 5500-0000-0000-0004 now', 'pay with [card number removed] now'],
];
const negative: string[] = [
  'Meeting at 14:30 in room 1204',
  'Invoice 2024 total 1500 USD',
  'See https://example.com/blog/post-1',
  'Order number 4111 1111 1111 1112',
  'Call me at +7 701 555 1234',
  'The secret is out, the key is under the mat',
  'Code review at 10',
];

describe('redact (01 §11.6)', () => {
  for (const [input, want] of positive) it(`redacts: ${input}`, () => expect(redact(input)).toBe(want));
  for (const input of negative) it(`keeps: ${input}`, () => expect(redact(input)).toBe(input));

  it('is idempotent', () => {
    for (const [input] of positive) expect(redact(redact(input))).toBe(redact(input));
  });

  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('123')).toBe(false);
  });
});
