// WP3 — 03 R1 toGroqStrictSchema + nullsToUndefined round trip over zod schemas.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nullsToUndefined, toGroqStrictSchema } from '../../../src/agent/groq/strictSchema.ts';

const js = (s: z.ZodType) => z.toJSONSchema(s, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;

describe('toGroqStrictSchema', () => {
  it('makes every property required, optional ones nullable, additionalProperties false (recursively)', () => {
    const schema = z.object({
      title: z.string().max(60),
      due: z.string().optional(),
      tags: z.array(z.object({ name: z.string(), weight: z.number().min(0).optional() })),
      kind: z.enum(['a', 'b']).optional(),
      note: z.string().nullable(),
    });
    const { schema: out, strict } = toGroqStrictSchema(js(schema));
    expect(strict).toBe(true);
    expect(out['additionalProperties']).toBe(false);
    expect(out['required']).toEqual(['title', 'due', 'tags', 'kind', 'note']);
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['due']!['type']).toEqual(['string', 'null']);
    expect(props['kind']!['enum']).toEqual(['a', 'b', null]);
    expect(props['title']).not.toHaveProperty('maxLength');
    const item = (props['tags']!['items'] as Record<string, unknown>);
    expect(item['additionalProperties']).toBe(false);
    expect(item['required']).toEqual(['name', 'weight']);
    expect(JSON.stringify(out)).not.toContain('$schema');
  });

  it('falls back to strict:false for records and tuples (still zod-validated afterwards)', () => {
    expect(toGroqStrictSchema(js(z.object({ m: z.record(z.string(), z.number()) }))).strict).toBe(false);
    const tuple = toGroqStrictSchema(js(z.object({ p: z.tuple([z.number(), z.number()]) })));
    expect(tuple.strict).toBe(false);
    expect(tuple.schema).not.toHaveProperty('$schema');
  });

  it('nullsToUndefined maps forced nulls back so the ORIGINAL zod schema validates', () => {
    const schema = z.object({ a: z.string(), b: z.string().optional(), c: z.string().nullable(), list: z.array(z.object({ x: z.number().optional() })) });
    const original = js(schema);
    const fromModel = { a: 'x', b: null, c: null, list: [{ x: null }, { x: 2 }] };
    expect(schema.safeParse(fromModel).success).toBe(false);
    const cleaned = nullsToUndefined(fromModel, original);
    expect(cleaned).toEqual({ a: 'x', c: null, list: [{}, { x: 2 }] });
    expect(schema.safeParse(cleaned).success).toBe(true);
  });
});
