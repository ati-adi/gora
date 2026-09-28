// telegram/render/time.ts (WP2) — <tg-time> rendering and validation (01 §11.4 step 2; Bot API date_time entity).
import { escapeHtmlText } from './escape.ts';

export type TgTimeFormat = 'wDT' | 'DT' | 'dt' | 't' | 'r' | 'wd';

/** 01 §11.4: `format` must match r|w?[dD]?[tT]? (anchored as a whole). */
export const TG_TIME_FORMAT = /^(?:r|w?[dD]?[tT]?)$/;
const FIVE_YEARS_SEC = 5 * 366 * 24 * 3600;

/** A code-built <tg-time> element. The visible text is escaped; `unixSec` is truncated to an integer. */
export function tgTime(unixSec: number, format: TgTimeFormat, text: string): string {
  const unix = Math.trunc(unixSec);
  return `<tg-time unix="${unix}" format="${format}">${escapeHtmlText(text)}</tg-time>`;
}

/** True when a model-written tg-time may survive: integer unix within ±5 years of now, and a valid format. */
export function isValidTgTime(unixRaw: string | undefined, formatRaw: string | undefined, nowMs: number): boolean {
  if (unixRaw === undefined || !/^-?\d{1,12}$/.test(unixRaw)) return false;
  const unix = Number(unixRaw);
  if (!Number.isSafeInteger(unix)) return false;
  if (Math.abs(unix - Math.floor(nowMs / 1000)) > FIVE_YEARS_SEC) return false;
  const format = formatRaw ?? '';
  return TG_TIME_FORMAT.test(format);
}
