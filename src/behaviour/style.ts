// behaviour/style.ts (friend set B, spec 05 C3) — exponential moving averages of how the owner writes, and the hints
// derived from them. Pure functions. Explicit preferences (UserSettings.style, written by settings_update) win.
import type { Ms, StyleHints, StyleOverrides } from '../contracts/index.ts';
import { langOf, type TextFeatures } from './features.ts';
import type { StyleState } from './repo.ts';

/** EMA weight of each new message (≈ the last 10 messages dominate). */
export const STYLE_EMA = 0.2;
/** No hints before this many messages (C3 "null until about 5 messages"). */
export const STYLE_MIN_MESSAGES = 5;

export function emptyStyle(since: Ms): StyleState {
  return { n: 0, len: 0, emoji: 0, formal: null, registerN: 0, scripts: {}, since };
}

const ema = (prev: number, x: number, n: number) => (n === 0 ? x : prev + STYLE_EMA * (x - prev));

export function updateStyle(st: StyleState, f: TextFeatures): StyleState {
  const scripts: Record<string, number> = {};
  const keys = new Set([...Object.keys(st.scripts), ...(f.script ? [f.script] : [])]);
  for (const k of keys) scripts[k] = f.script ? ema(st.scripts[k] ?? 0, k === f.script ? 1 : 0, st.n === 0 ? 0 : 1) : (st.scripts[k] ?? 0);
  const formal = f.register ? (st.formal === null ? (f.register === 'formal' ? 1 : 0) : st.formal + STYLE_EMA * ((f.register === 'formal' ? 1 : 0) - st.formal)) : st.formal;
  return {
    n: st.n + 1,
    len: ema(st.len, f.length, st.n),
    emoji: ema(st.emoji, f.emoji, st.n),
    formal,
    registerN: st.registerN + (f.register ? 1 : 0),
    scripts,
    since: st.since,
  };
}

export function hintsOf(st: StyleState | null, languageCode: string | null): StyleHints | null {
  if (!st || st.n < STYLE_MIN_MESSAGES) return null;
  const replyLength: StyleHints['replyLength'] = st.len < 80 ? 'short' : st.len < 280 ? 'medium' : 'long';
  const emoji: StyleHints['emoji'] = st.emoji < 0.15 ? 'none' : st.emoji < 1.5 ? 'light' : 'lots';
  const register: StyleHints['register'] = st.formal === null || st.registerN < 2 ? 'mixed' : st.formal < 0.3 ? 'informal' : st.formal > 0.7 ? 'formal' : 'mixed';
  const languages = Object.entries(st.scripts)
    .filter(([, v]) => v >= 0.2)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => langOf(k as 'cyrillic' | 'latin' | 'other', languageCode))
    .filter((x): x is string => !!x);
  return { replyLength, emoji, register, languages: [...new Set(languages)] };
}

/** The one `<user_model>` line (C3): explicit overrides replace the learned hints field by field. */
export function styleLine(h: StyleHints | null, o: StyleOverrides | null): string | null {
  const length = o?.length ?? h?.replyLength;
  const emoji = o?.emoji ?? h?.emoji;
  const register = o?.register ?? (h && h.register !== 'mixed' ? h.register : undefined);
  const lang = h?.languages.length ? h.languages.join('+') : undefined;
  const parts = [length && `reply_length=${length}`, emoji && `emoji=${emoji}`, register && `register=${register}`, lang && `lang=${lang}`].filter(Boolean);
  if (!parts.length) return null;
  const set = o ? (['length', 'emoji', 'register'] as const).filter((k) => o[k]) : [];
  return `style: ${parts.join(' ')}${set.length ? ` set_by_owner=${set.join(',')}` : ''}`;
}
