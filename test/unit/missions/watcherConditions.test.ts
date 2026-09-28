// WP6b — watcher conditions (pure): normalization + hash input, transitions, numbers near text, URL rules (§11.5).
import { describe, expect, it } from 'vitest';
import {
  changedWindow, checkWatchUrl, currentlyMet, evaluateChange, htmlToText, inboxIdsOf, inboxSnapshot, numberNear, pageText, parseNumberToken, sha256Hex,
} from '../../../src/missions/watcherConditions.ts';

describe('page text', () => {
  it('drops scripts/styles/comments, decodes entities, collapses whitespace (stable hash across cosmetic changes)', () => {
    const a = htmlToText('<html><head><title>x</title></head><body><script>var t=Date.now()</script><p>Best&nbsp;fare:   <b>$310</b></p><!-- ad --></body></html>');
    expect(a).toBe('Best fare: $310');
    const b = pageText(new TextEncoder().encode('<div>Best fare: <b>$310</b></div>\n\n<style>.x{}</style>'), 'text/html');
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(pageText(new TextEncoder().encode('{"price": 12}'), 'application/json')).toBe('{"price": 12}');
  });
});

describe('conditions fire on transitions only', () => {
  it('baseline never fires', () => {
    expect(evaluateChange({ type: 'changed' }, null, 'x', { kind: 'page' })).toEqual({ kind: 'no_hit' });
  });
  it('changed / contains / absent', () => {
    expect(evaluateChange({ type: 'changed' }, 'a', 'b', { kind: 'page' }).kind).toBe('hit');
    expect(evaluateChange({ type: 'contains', text: 'In stock' }, 'Sold out', 'In STOCK now', { kind: 'page' }).kind).toBe('hit');
    expect(evaluateChange({ type: 'contains', text: 'In stock' }, 'In stock', 'In stock!', { kind: 'page' }).kind).toBe('no_hit');
    expect(evaluateChange({ type: 'absent', text: 'Sold out' }, 'Sold out', 'Available', { kind: 'page' }).kind).toBe('hit');
  });
  it('number_below near a label, ignoring digits in the label; hit only when it crosses', () => {
    expect(numberNear('ALA→IST 20 Oct: $310, taxes included', 'ALA→IST 20 Oct')).toBe(310);
    expect(numberNear('Price 1,299.50 USD', 'Price')).toBe(1299.5);
    expect(parseNumberToken('1 234')).toBe(1234);
    const c = { type: 'number_below' as const, near_text: 'Best fare', threshold: 250 };
    expect(evaluateChange(c, 'Best fare: $310', 'Best fare: $231', { kind: 'page' })).toEqual({ kind: 'hit', summary: 'Best fare 231 < 250' });
    expect(evaluateChange(c, 'Best fare: $231', 'Best fare: $229', { kind: 'page' }).kind).toBe('no_hit');
    expect(currentlyMet(c, 'Best fare: $231')).toBe(true);
  });
  it('semantic defers to the LLM; inbox "changed" counts new threads only', () => {
    expect(evaluateChange({ type: 'semantic', description: 'a new date is announced' }, 'a', 'b', { kind: 'page' })).toEqual({ kind: 'needs_semantic', description: 'a new date is announced' });
    expect(evaluateChange({ type: 'changed' }, 't1', 't1\nt2', { kind: 'inbox', newItems: 0 }).kind).toBe('no_hit');
    expect(evaluateChange({ type: 'changed' }, 't1', 't1\nt2', { kind: 'inbox', newItems: 1 })).toEqual({ kind: 'hit', summary: '1 new matching email' });
  });
  it('inbox snapshot hashes ids+dates only (an unread flip is not a change)', () => {
    const t = [{ threadId: 'a', from: 'A', subject: 's', snippet: 'x', date: 2, unread: true }, { threadId: 'b', from: 'B', subject: 's', snippet: 'y', date: 1, unread: false }];
    const s1 = inboxSnapshot(t);
    const s2 = inboxSnapshot(t.map((x) => ({ ...x, unread: !x.unread })));
    expect(s1.hashInput).toBe(s2.hashInput);
    expect(inboxIdsOf(s1.text)).toEqual(['a', 'b']);
  });
  it('changedWindow keeps the area around the change', () => {
    const w = changedWindow(`${'x'.repeat(1000)}OLD${'y'.repeat(1000)}`, `${'x'.repeat(1000)}NEW${'y'.repeat(1000)}`, 5000, 10);
    expect(w.before).toContain('OLD');
    expect(w.after).toContain('NEW');
    expect(w.after.length).toBeLessThan(40);
  });
});

describe('checkWatchUrl (SafeFetch static rules)', () => {
  const o = { publicUrl: 'https://gora.example.org', blockedDomains: ['evil.test'] };
  it.each([
    ['ftp://x.com/a', 'only http'],
    ['http://user:pw@x.com/', 'credentials'],
    ['http://x.com:8080/', 'ports'],
    ['http://localhost/', 'local'],
    ['http://printer.local/', 'local'],
    ['http://10.0.0.1/', 'private'],
    ['http://169.254.169.254/latest/meta-data', 'private'],
    ['http://[::1]/', 'IP'],
    ['http://[::ffff:127.0.0.1]/', 'not allowed'],
    ['http://2130706433/', 'not allowed'],
    ['https://gora.example.org/api', 'not allowed'],
    ['https://a.evil.test/x', 'blocked'],
  ])('rejects %s', (url, why) => {
    const r = checkWatchUrl(url, o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });
  it('accepts a public https URL', () => expect(checkWatchUrl('https://fares.example.com/ala-ist?d=20', o).ok).toBe(true));
});
