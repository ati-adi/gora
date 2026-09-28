// trust/redact.ts (WP4) — 01 §11.6 redaction, applied to email, business and web text before the model sees it
// (via untrusted.wrap) and to every tool output (executor, §5.6 step 3). Pure; unit-tested with a positive/negative table.

export const CODE_REMOVED = '[code removed]';
export const LOGIN_LINK_REMOVED = '[login link removed]';
export const SECRET_REMOVED = '[secret removed]';
export const CARD_REMOVED = '[card number removed]';

/** URLs (http/https or bare www.) up to whitespace or a closing bracket/quote. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]{}]+/gi;
/** A URL is a login/one-time link when it carries any of these markers (01 §11.6). */
const LOGIN_MARKERS = /token=|reset|magic|login|log-in|verify|signin|sign-in|auth|oobcode/i;

/** Secret-ish words; the secret itself is ≥ 24 base64url(ish) characters right next to one of them. */
const SECRET_WORD = String.raw`(?:api[_\- ]?key|secret|token|key|password|passwd|bearer)`;
const SECRET_VALUE = String.raw`[A-Za-z0-9_\-+/]{24,}={0,2}`;
// Word boundaries are alphanumeric only: '_' separates words too (access_token=, client_secret:, GITHUB_TOKEN=).
/** word … value: the gap is short punctuation/filler ("key: ", "token=", "secret is "). */
const SECRET_AFTER_RE = new RegExp(String.raw`((?<![A-Za-z0-9])${SECRET_WORD}(?![A-Za-z0-9])[^A-Za-z0-9\n]{0,4}(?:(?:is|was|:)\s{0,3})?)(${SECRET_VALUE})`, 'gi');
/** value … word ("AbC…xyz is your API key"). */
const SECRET_BEFORE_RE = new RegExp(String.raw`(?<![A-Za-z0-9_\-+/])(${SECRET_VALUE})(?=[^A-Za-z0-9\n]{0,4}(?:is\s+)?(?:your|the|my|our)?\s{0,3}${SECRET_WORD}(?![A-Za-z0-9]))`, 'gi');

/** A JSON Web Token (header.payload[.signature]); the header alone is a constant, so the whole token goes. */
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
/** An opaque bearer credential may contain '.', '~' and '=' (RFC 6750 b64token). */
const BEARER_RE = /((?<![A-Za-z0-9])bearer\s+)([A-Za-z0-9\-._~+/]{20,}=*)/gi;

/** 13–19 digits, optionally grouped by single spaces or hyphens. */
const CARD_RE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;

/** 4–8 digit codes (also "123 456" / "123-456"), not part of a longer number. A ':' or '-' right before the code is
 * allowed only after a letter ("code:123456", Google's "G-123456"), never after a digit ("555-1234", "10:3000"). */
const CODE_RE = /(?<![\w.,/+])(?<![^A-Za-z][:-])(?<!^[:-])(?<!\d[ -])(?:\d{3}[- ]\d{3}|\d{4,8})(?![\d\w]|[.,:/-]\d|[ -]\d)/g;
/** Keywords that make a nearby number a one-time code. Cyrillic words use letter look-arounds (JS \b is ASCII-only). */
const CODE_WORD_RE = /\b(?:codes?|otp|one[- ]time|passcode|verification|verify)\b|(?<!\p{L})(?:пароль\p{L}{0,3}|код\p{L}{0,2})(?!\p{L})/iu;
const CODE_WINDOW = 40;

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function redactLoginLinks(text: string): string {
  return text.replace(URL_RE, (url) => (LOGIN_MARKERS.test(url) ? LOGIN_LINK_REMOVED : url));
}

function redactSecrets(text: string): string {
  return text
    .replace(JWT_RE, SECRET_REMOVED)
    .replace(BEARER_RE, (_m, lead: string) => `${lead}${SECRET_REMOVED}`)
    .replace(SECRET_AFTER_RE, (_m, lead: string) => `${lead}${SECRET_REMOVED}`).replace(SECRET_BEFORE_RE, SECRET_REMOVED);
}

function redactCards(text: string): string {
  return text.replace(CARD_RE, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return luhnValid(digits) ? CARD_REMOVED : m;
  });
}

function redactCodes(text: string): string {
  // Decide on the original text (so an earlier replacement cannot move the window), then rebuild.
  const hits: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(CODE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const window = text.slice(Math.max(0, start - CODE_WINDOW), Math.min(text.length, end + CODE_WINDOW));
    if (CODE_WORD_RE.test(window)) hits.push({ start, end });
  }
  if (hits.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const h of hits) {
    out += text.slice(pos, h.start) + CODE_REMOVED;
    pos = h.end;
  }
  return out + text.slice(pos);
}

/**
 * 01 §11.6, in this order: login links, secrets, card numbers (Luhn), one-time codes. Idempotent: the replacement
 * markers never match any rule again.
 */
export function redact(text: string): string {
  if (!text) return text;
  let t = redactLoginLinks(text);
  t = redactSecrets(t);
  t = redactCards(t);
  t = redactCodes(t);
  return t;
}
