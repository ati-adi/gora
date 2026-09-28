// kernel/canonicalJson.ts (WP0) — deterministic JSON: object keys sorted (UTF-16 order), no whitespace,
// `undefined` members dropped (as JSON.stringify does). Used for hashes, HMACs and tool schemas.
export function canonicalJson(v: unknown): string {
  const out = enc(v);
  return out === undefined ? 'null' : out;
}

function enc(v: unknown): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not serializable');
    default:
      break;
  }
  const o = v as { toJSON?: () => unknown };
  if (typeof o.toJSON === 'function') return enc(o.toJSON());
  if (Array.isArray(v)) return '[' + v.map((x) => enc(x) ?? 'null').join(',') + ']';
  if (v instanceof Uint8Array) throw new TypeError('canonicalJson: encode bytes explicitly (e.g. base64) first');
  const rec = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    const s = enc(rec[k]);
    if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}
