import { afterEach, describe, expect, it } from 'vitest';
import { createMediaTextCache } from '../../../src/agent/index.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('Groq media-text cache (integration: privacy of derived media text)', () => {
  it('is scoped to the epoch DEK, sealed at rest, and unreadable once that DEK is shredded', async () => {
    t = await createTestApp();
    const s = t.s;
    s.crypto.ensureDek('e:c1:1', 'u1', 'epoch');
    s.crypto.ensureDek('e:c2:1', 'u2', 'epoch');
    const cache = createMediaTextCache(s);
    cache.set('vision', 'abc', 'e:c1:1', 'a photo of a passport');
    expect(cache.get('vision', 'abc', 'e:c1:1')).toBe('a photo of a passport');
    expect(cache.get('vision', 'abc', 'e:c2:1')).toBeUndefined(); // another conversation / user: no shared entry
    const raw = s.db.prepare(`SELECT key, value_json FROM kv WHERE key LIKE 'vision:%'`).all() as Array<{ key: string; value_json: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.key).not.toContain('abc');
    expect(raw[0]!.value_json).not.toContain('passport');
    s.crypto.destroyDek('e:c1:1');
    expect(cache.get('vision', 'abc', 'e:c1:1')).toBeUndefined();
  });
});
