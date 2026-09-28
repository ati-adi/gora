// http/security.ts (WP8) — security headers for the Mini App (01 §12 "Hosting", ⚠U16) and the JSON API.
// /app/*: CSP with frame-ancestors from MINIAPP_FRAME_ANCESTORS (default 'https://web.telegram.org https://*.telegram.org'),
// X-Content-Type-Options, Referrer-Policy. /api/*: no-store, nosniff, no-referrer, and a CSP that forbids everything
// (JSON is never rendered). The export download adds `Access-Control-Allow-Origin: https://web.telegram.org` itself.
import type { MiddlewareHandler } from 'hono';

export const DEFAULT_FRAME_ANCESTORS = 'https://web.telegram.org https://*.telegram.org';
/** Telegram Web's origin: `WebApp.downloadFile` requires it in Access-Control-Allow-Origin (research §8). */
export const TELEGRAM_WEB_ORIGIN = 'https://web.telegram.org';

/**
 * Keeps only well-formed CSP source expressions from the env value (scheme://host[:port] with an optional leading
 * `*.` label, or 'self' / 'none'), so a malformed env value can never inject another directive or header.
 * Falls back to the default when nothing valid is left.
 */
export function sanitizeFrameAncestors(v: string | undefined | null): string {
  const ok = (v ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t === "'self'" || t === "'none'" || /^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i.test(t));
  if (ok.includes("'none'")) return "'none'";
  return ok.length ? [...new Set(ok)].join(' ') : DEFAULT_FRAME_ANCESTORS;
}

/** 01 §12: the exact Mini App policy (Telegram's script is the only third-party code). */
export function miniAppCsp(frameAncestors: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `frame-ancestors ${sanitizeFrameAncestors(frameAncestors)}`,
  ].join('; ');
}

export function miniAppHeaders(frameAncestors: string): MiddlewareHandler {
  const csp = miniAppCsp(frameAncestors);
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  };
}

export function apiHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  };
}
