// agent/groq/strictSchema.ts (WP3) — 03 R1: JSON Schema (from z.toJSONSchema) → Groq strict json_schema.
// Strict mode needs every property in `required`, `additionalProperties:false`, and nullable fields written as a type
// union with 'null' (or anyOf [T, {type:'null'}]). Optional properties become required-but-nullable; after the call the
// nulls are mapped back to undefined (nullsToUndefined) and the value is validated with the original zod schema.
// Constructs strict mode cannot express ($ref, records, tuples, not/if/allOf, patternProperties) → strict:false with the
// schema passed through (minus $schema), still zod-validated afterwards.

type Json = Record<string, unknown>;

class Unsupported extends Error {}

/** Validation keywords stripped in strict mode (zod re-validates them after the call). */
const STRIP = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'multipleOf', 'default', 'uniqueItems', 'examples', 'id', '$id']);
const UNSUPPORTED = ['$ref', '$defs', 'definitions', 'patternProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'dependentSchemas', 'dependentRequired', 'prefixItems', 'unevaluatedProperties'];

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function allowsNull(s: Json): boolean {
  const t = s['type'];
  if (t === 'null' || (Array.isArray(t) && t.includes('null'))) return true;
  if (Array.isArray(s['enum']) && (s['enum'] as unknown[]).includes(null)) return true;
  if (s['const'] === null) return true;
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(s[k]) && (s[k] as unknown[]).some((x) => isObj(x) && allowsNull(x))) return true;
  return false;
}

function makeNullable(s: Json): Json {
  if (allowsNull(s)) return s;
  const t = s['type'];
  if (typeof t === 'string' && !('anyOf' in s) && !('const' in s)) {
    const out: Json = { ...s, type: [t, 'null'] };
    if (Array.isArray(s['enum'])) out['enum'] = [...(s['enum'] as unknown[]), null];
    return out;
  }
  if (Array.isArray(t) && !('enum' in s)) return { ...s, type: [...(t as unknown[]), 'null'] };
  if (Array.isArray(s['anyOf'])) return { ...s, anyOf: [...(s['anyOf'] as unknown[]), { type: 'null' }] };
  return { anyOf: [s, { type: 'null' }] };
}

function convert(node: unknown): Json {
  if (!isObj(node)) throw new Unsupported('non-object schema node');
  for (const k of UNSUPPORTED) if (k in node) throw new Unsupported(k);
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) if (!STRIP.has(k)) out[k] = v;
  if (Array.isArray(out['oneOf'])) {
    out['anyOf'] = out['oneOf'];
    delete out['oneOf'];
  }
  if (Array.isArray(out['anyOf'])) out['anyOf'] = (out['anyOf'] as unknown[]).map(convert);
  const isObject = out['type'] === 'object' || isObj(out['properties']);
  if (isObject) {
    const ap = out['additionalProperties'];
    if (isObj(ap) || (ap === true && !isObj(out['properties']))) throw new Unsupported('record');
    const props = isObj(out['properties']) ? (out['properties'] as Json) : {};
    const required = new Set(Array.isArray(out['required']) ? (out['required'] as string[]) : []);
    const next: Json = {};
    for (const [k, v] of Object.entries(props)) {
      const c = convert(v);
      next[k] = required.has(k) ? c : makeNullable(c);
    }
    out['type'] = 'object';
    out['properties'] = next;
    out['required'] = Object.keys(next);
    out['additionalProperties'] = false;
  }
  if (out['type'] === 'array' || 'items' in out) {
    if (Array.isArray(out['items'])) throw new Unsupported('tuple');
    if ('items' in out) out['items'] = convert(out['items']);
  }
  return out;
}

/** 03 R1 toGroqStrictSchema: `strict:true` when the conversion succeeds, else the schema as-is with `strict:false`. */
export function toGroqStrictSchema(schema: Json): { schema: Json; strict: boolean } {
  try {
    return { schema: convert(schema), strict: true };
  } catch {
    const { $schema: _drop, ...rest } = schema;
    return { schema: rest, strict: false };
  }
}

/**
 * Maps the nulls strict mode forced into optional properties back to undefined (deleted keys), guided by the ORIGINAL
 * schema: a property is cleaned only when it is not required there and its own schema does not allow null.
 */
export function nullsToUndefined(value: unknown, schema: unknown): unknown {
  if (!isObj(schema)) return value;
  if (Array.isArray(value)) {
    const items = schema['items'];
    return isObj(items) ? value.map((x) => nullsToUndefined(x, items)) : value;
  }
  if (isObj(value)) {
    const alts = [...(Array.isArray(schema['anyOf']) ? (schema['anyOf'] as unknown[]) : []), ...(Array.isArray(schema['oneOf']) ? (schema['oneOf'] as unknown[]) : [])];
    const objAlt = isObj(schema['properties']) ? schema : (alts.find((a) => isObj(a) && isObj(a['properties'])) as Json | undefined);
    if (!objAlt) return value;
    const props = objAlt['properties'] as Json;
    const required = new Set(Array.isArray(objAlt['required']) ? (objAlt['required'] as string[]) : []);
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      const ps = props[k];
      if (v === null && !required.has(k) && !(isObj(ps) && allowsNull(ps))) continue;
      out[k] = isObj(ps) ? nullsToUndefined(v, ps) : v;
    }
    return out;
  }
  return value;
}
