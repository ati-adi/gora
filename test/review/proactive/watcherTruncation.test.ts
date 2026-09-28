// REVIEW (proactive) — page watchers never see text past the first 20 000 characters.
// watchers.ts check(): the hash covers the FULL page text, but the condition is evaluated on
// `value = f.text.slice(0, LAST_VALUE_MAX_CHARS)` (20 000) for both before and after. A `contains` / `absent` /
// `number_below` target that sits beyond 20 000 visible characters (common on listing / shop / schedule pages) changes the
// hash, yet evaluateChange sees identical truncated snapshots → no_hit, forever, silently. The same truncated pair is
// what the semantic check gets (changedWindow finds no difference), so semantic watchers miss it too.
import { afterEach, describe, expect, it } from 'vitest';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
const URL1 = 'https://shop.example.com/listing';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const filler = Array.from({ length: 500 }, (_, i) => `<p>Item ${i}: a long product description line padding the page</p>`).join('');

describe('watcher value truncation', () => {
  it('a contains-condition whose text appears after 20K chars never fires', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = t.user();
    t.caps.safeFetch.set(URL1, `<html><body>${filler}<p>Concert tickets: sold out</p></body></html>`);
    const { id } = await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'contains', text: 'Tickets available' }, intervalMin: 360 });
    t.caps.safeFetch.set(URL1, `<html><body>${filler}<p>Concert tickets: Tickets available now</p></body></html>`);
    await t.advance(6 * HOUR); // 15:00 UTC, outside quiet hours
    const hits = t.tg.callsOf('sendRichMessage').map((c) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, '')).filter((m) => m.includes(`Watcher ${id}`));
    expect(hits).toHaveLength(1);
  });
});
