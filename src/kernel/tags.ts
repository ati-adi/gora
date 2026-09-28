// kernel/tags.ts (WP0) — neutralizes Gora's reserved tag names in inbound text (01 §5.9, §11.3):
// '<' (and '</') before a reserved name becomes '‹', so inline context and untrusted wrappers cannot be forged.
// 'user_model' (friend-mode, spec 05 A4): the owner-facts block inside <gora_context>.
export const RESERVED_TAGS: readonly string[] = ['gora_context', 'gora_event', 'untrusted', 'previous_epoch_summary', 'guest_request', 'system-reminder', 'user_model'];

const RESERVED_RE = new RegExp(`<(\\s*\\/?\\s*)(${RESERVED_TAGS.map((t) => t.replace(/[-_]/g, '[-_]')).join('|')})(?=[\\s>/=]|$)`, 'gi');

/** A '<' or a compatibility form of it (fullwidth U+FF1C, small U+FE64), then what may follow it inside a tag name. */
const LOOKALIKE_OPEN_RE = /[<\uFF1C\uFE64]([\p{Cf}\s\/\uFF0F\p{L}\p{N}\p{Pd}_\uFF3F]{1,64})/gu;
const RESERVED_FOLDED_RE = new RegExp(`^\\s*\\/?\\s*(?:${RESERVED_TAGS.map((t) => t.replace(/[-_]/g, '[-_]')).join('|')})(?=[\\s>/=]|$)`, 'i');

/**
 * 01 §11.3 item 1: the ASCII neutralizer misses reserved tags hidden by format characters or compatibility forms
 * ('</untrusted\u200B>', '<\u200B/untrusted>', '＜/untrusted＞'). Tokenizers drop Cf characters and fold such forms,
 * so the model would still read a closing tag. Each candidate is folded (NFKC, Cf removed) and, when it spells a
 * reserved tag, its bracket becomes '‹'. The rest of the text is left untouched.
 */
export function neutralizeLookalikeTags(text: string): string {
  return text.replace(LOOKALIKE_OPEN_RE, (m: string, rest: string) => {
    const folded = rest.normalize('NFKC').replace(/\p{Cf}/gu, '');
    return RESERVED_FOLDED_RE.test(folded) ? `‹${rest}` : m;
  });
}

/** ASCII reserved tags and their Cf / compatibility-form lookalikes (TRUST-08: every caller gets both). */
export function neutralizeReservedTags(text: string): string {
  return neutralizeLookalikeTags(text.replace(RESERVED_RE, (_m, slash: string, name: string) => `‹${slash}${name}`));
}

export function containsReservedTag(text: string): boolean {
  RESERVED_RE.lastIndex = 0;
  const hit = RESERVED_RE.test(text);
  RESERVED_RE.lastIndex = 0;
  return hit || neutralizeLookalikeTags(text) !== text;
}

/** Escapes a value for use inside a double-quoted XML-ish attribute (labels in <untrusted label="…">). */
export function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
}
