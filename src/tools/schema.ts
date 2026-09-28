// tools/schema.ts (WP5) — deterministic JSON Schema for tool inputs (01 §6): z.toJSONSchema(zod) in input mode, `$schema`
// removed, `additionalProperties:false` on every object, keys canonicalized. Also small zod helpers shared by the tools.
import { createHash } from 'node:crypto';
import { z, type ZodType } from 'zod';
import { canonicalJson } from '../kernel/canonicalJson.ts';
import { isValidTz } from '../kernel/timeMath.ts';

function closeObjects(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(closeObjects);
  if (!v || typeof v !== 'object') return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = closeObjects(x);
  if (o['type'] === 'object' && o['additionalProperties'] === undefined) o['additionalProperties'] = false;
  return o;
}

/** The input_schema of a tool definition. Deterministic for a given zod schema. */
export function toolInputJsonSchema(schema: ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js['$schema'];
  return JSON.parse(canonicalJson(closeObjects(js))) as Record<string, unknown>;
}

/** Validation-only keywords dropped from compact (toolkits-mode) definitions: zod re-validates every input anyway. */
const COMPACT_STRIP = new Set(['additionalProperties', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'default', 'format']);

/**
 * 03 R3 (integration): the compact JSON Schema sent on `toolMode:'toolkits'` profiles (Groq), so the `core` toolkit fits
 * its 1,100-token budget. Drops validation-only keywords, `type` next to an all-string `enum`, and a `pattern` whose
 * property already carries a description (the description states the format). The zod schema still validates every
 * call (INVALID_INPUT with issues), so nothing is enforced less.
 */
export function compactJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const stringEnum = Array.isArray(src['enum']) && (src['enum'] as unknown[]).every((v) => typeof v === 'string');
  for (const [k, v] of Object.entries(src)) {
    if (COMPACT_STRIP.has(k)) continue;
    if (k === 'type' && v === 'string' && stringEnum) continue;
    if (k === 'pattern' && typeof src['description'] === 'string') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, compactJsonSchema(pv)]));
      continue;
    }
    out[k] = compactJsonSchema(v);
  }
  return out;
}

/** 16 hex chars of sha256 over the canonical JSON of the definitions (ToolDefinitions.hash). */
export function definitionsHash(defs: unknown): string {
  return createHash('sha256').update(canonicalJson(defs)).digest('hex').slice(0, 16);
}

// ── shared zod pieces (compact JSON Schema: no huge generated patterns)
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
export function isEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s);
}
export const zEmail = z
  .string()
  .max(254)
  .refine(isEmail, { message: 'invalid email address' })
  .meta({ format: 'email' });
/** 'YYYY-MM-DDTHH:mm' interpreted in the tool's tz (01 §6). */
export const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const zLocal = z.string().regex(LOCAL_RE, { message: 'expected YYYY-MM-DDTHH:mm' });
export const zHHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'expected HH:mm' });
export const zTz = z
  .string()
  .max(64)
  .refine((t) => isValidTz(t), { message: 'expected an IANA time zone such as Asia/Almaty' });
