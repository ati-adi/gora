// memory/text.ts (WP6a) — text normalization, word tokens (Intl.Segmenter), shingles and fingerprint grams (01 §9).
// Pure functions; no I/O.

/** Lower-case, NFKC, diacritics folded, punctuation → spaces, whitespace collapsed. Shared by fingerprints and dedupe. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function words(text: string): string[] {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/** Every run of `k` consecutive words. */
export function kgrams(ws: readonly string[], k: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + k <= ws.length; i++) out.push(ws.slice(i, i + k).join(' '));
  return out;
}

export const SHINGLE = 5;

/**
 * What a forget records (§9 step 2): the normalized full text plus every 5-word shingle. A text shorter than five words
 * has no shingle; its full text is its only fingerprint.
 */
export function fingerprintGrams(text: string): string[] {
  const ws = words(text);
  if (!ws.length) return [];
  return [...new Set([ws.join(' '), ...kgrams(ws, SHINGLE)])];
}

/**
 * What is probed against the fingerprints for a candidate text: the full text and every 1..5-word gram (a forgotten
 * fact of fewer than five words is found inside a longer sentence; longer ones through their 5-word shingles).
 */
export function probeGrams(text: string): string[] {
  const ws = words(text);
  if (!ws.length) return [];
  const out = new Set<string>([ws.join(' ')]);
  for (let k = 1; k <= SHINGLE; k++) for (const g of kgrams(ws, k)) out.add(g);
  return [...out];
}

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(lang: string): Intl.Segmenter {
  const key = (lang || 'en').slice(0, 2).toLowerCase();
  let s = segmenters.get(key);
  if (!s) {
    try {
      s = new Intl.Segmenter(key, { granularity: 'word' });
    } catch {
      s = new Intl.Segmenter('en', { granularity: 'word' });
    }
    segmenters.set(key, s);
  }
  return s;
}

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are', 'was', 'be', 'i', 'me', 'my', 'you', 'your', 'it', 'this', 'that',
  'with', 'as', 'by', 'from', 'do', 'does', 'what', 'who', 'how', 'when', 'where', 'please',
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'по', 'о', 'об', 'у', 'а', 'но', 'я', 'мне', 'меня', 'мой', 'моя', 'мои', 'ты', 'это', 'что', 'как', 'не', 'же', 'ли',
]);

/** Retrieval tokens: word-like segments (Intl.Segmenter), normalized, stop words dropped, a light prefix stem for long words. */
export function tokens(text: string, lang = 'en'): string[] {
  const out: string[] = [];
  for (const seg of segmenter(lang).segment(text)) {
    if (!seg.isWordLike) continue;
    const w = normalize(seg.segment);
    if (!w) continue;
    for (const part of w.split(' ')) {
      if (!part || STOP.has(part)) continue;
      // crude stemming that works for inflected Russian and English plurals alike: long words are cut to 6 chars
      out.push(part.length > 6 ? part.slice(0, 6) : part);
    }
  }
  return out;
}

/** Splits text into sentences (for fingerprint filtering of transcripts and summaries). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}
