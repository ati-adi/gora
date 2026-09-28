// kernel/log.ts (WP0) — pino logging with redaction. Never log message text, tokens or initData (01 §4.2):
// known sensitive keys are censored at any depth up to 3, and bot-token / file-URL / tma patterns are scrubbed from strings.
import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import type { Logger } from '../contracts/common.ts';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/** Keys whose values are never written. */
export const REDACT_KEYS: readonly string[] = [
  'token', 'botToken', 'bot_token', 'apiKey', 'api_key', 'authorization', 'Authorization', 'initData', 'init_data', 'initDataRaw',
  'secret', 'secret_token', 'webhookSecret', 'password', 'kek', 'hashKey', 'callbackKey', 'cookie',
  'text', 'markdown', 'caption', 'content', 'body', 'transcript', 'prompt', 'message_text', 'rich_message', 'payload', 'fileUrl', 'file_url',
];
const PATHS = REDACT_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

const TOKEN_RE = /\bbot\d{3,}:[A-Za-z0-9_-]{20,}/g; // Telegram bot token inside URLs
const BARE_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g; // bare bot token
const TMA_RE = /\btma\s+[^\s"']+/gi; // Authorization: tma <initData>
const KEY_RE = /\b(gsk|sk-ant|sk)_?[A-Za-z0-9_-]{20,}\b/g; // Groq / Anthropic / OpenAI-style keys

export function scrubString(s: string): string {
  return s.replace(TOKEN_RE, 'bot[redacted]').replace(BARE_TOKEN_RE, '[redacted-token]').replace(TMA_RE, 'tma [redacted]').replace(KEY_RE, '[redacted-key]');
}

function scrub(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (depth <= 0 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth - 1));
  if (v instanceof Error) return { type: v.name, message: scrubString(v.message) };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrub(x, depth - 1);
  return out;
}

function wrap(p: PinoLogger): Logger {
  return {
    debug: (o, m) => p.debug(o, m),
    info: (o, m) => p.info(o, m),
    warn: (o, m) => p.warn(o, m),
    error: (o, m) => p.error(o, m),
    child: (b) => wrap(p.child(scrub(b, 3) as object)),
  };
}

export function createLogger(o: { level?: LogLevel; base?: Record<string, unknown>; destination?: DestinationStream } = {}): Logger {
  const p = pino(
    {
      level: o.level ?? 'info',
      base: o.base ?? { app: 'gora' },
      redact: { paths: PATHS, censor: '[redacted]' },
      formatters: { log: (obj) => scrub(obj, 4) as Record<string, unknown> },
      serializers: { err: (e: unknown) => (e instanceof Error ? { type: e.name, message: scrubString(e.message), stack: e.stack ? scrubString(e.stack) : undefined } : e) },
    },
    o.destination,
  );
  return wrap(p);
}

export interface LogEntry { level: 'debug' | 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg?: string; bindings: Record<string, unknown> }

/** In-memory logger for tests: entries are captured after the same scrubbing (keys in REDACT_KEYS are censored). */
export function createMemoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const censor = (o: object): Record<string, unknown> => censorKeys(scrub(o, 4), 4) as Record<string, unknown>;
  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: (o, m) => void entries.push({ level: 'debug', obj: censor(o), msg: m, bindings }),
    info: (o, m) => void entries.push({ level: 'info', obj: censor(o), msg: m, bindings }),
    warn: (o, m) => void entries.push({ level: 'warn', obj: censor(o), msg: m, bindings }),
    error: (o, m) => void entries.push({ level: 'error', obj: censor(o), msg: m, bindings }),
    child: (b) => make({ ...bindings, ...censor(b) }),
  });
  return Object.assign(make({}), { entries });
}

/** A logger that drops everything. */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => nullLogger };

function censorKeys(v: unknown, depth: number): unknown {
  if (depth <= 0 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => censorKeys(x, depth - 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = REDACT_KEYS.includes(k) ? '[redacted]' : censorKeys(x, depth - 1);
  return out;
}
