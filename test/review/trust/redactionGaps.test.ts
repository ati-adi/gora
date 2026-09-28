// REVIEW (trust) — 01 §11.6 redaction gaps in trust/redact.ts on very common real-world formats.
//  - one-time codes: "4–8 digit codes near the words code, OTP, verification" — the CODE_RE look-behind excludes a
//    preceding '-' or ':' so Google's "G-123456 is your Google verification code" and "code:123456" leak.
//  - secrets: "≥ 24 base64url characters next to key, secret or token" — SECRET_WORD is anchored with \b, and '_' is a
//    word character, so access_token= / client_secret: / GITHUB_TOKEN= are never matched.
//  - a JWT bearer token keeps its payload + signature (only the first dot-segment is replaced; the header is a constant).
import { describe, expect, it } from 'vitest';
import { CODE_REMOVED, redact, SECRET_REMOVED } from '../../../src/trust/redact.ts';

const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('redaction (01 §11.6) on common formats', () => {
  it.each([
    'G-123456 is your Google verification code.',
    'Your verification code:123456',
  ])('one-time code is removed: %s', (t) => {
    expect(redact(t)).toContain(CODE_REMOVED);
    expect(redact(t)).not.toMatch(/123456/);
  });

  it.each([
    `access_token=${SECRET}`,
    `client_secret: ${SECRET}`,
    `GITHUB_TOKEN=ghp_${SECRET}`,
  ])('secret next to a token/secret/key word is removed: %s', (t) => {
    expect(redact(t)).toContain(SECRET_REMOVED);
    expect(redact(t)).not.toContain(SECRET);
  });

  it('a bearer JWT does not keep its signature', () => {
    const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.${sig}`;
    expect(redact(`Authorization: Bearer ${jwt}`)).not.toContain(sig);
  });

  it.each([
    'Call 555-1234 about the code review',
    'The meeting is at 10:30, code freeze after',
    'Order 2026-09-28 verification pending',
    'monkeypatch_keyboard_layout AbCdEfGhIjKlMnOpQrStUvWxYz is fine',
  ])('no false positive: %s', (t) => {
    expect(redact(t)).toBe(t);
  });
});
