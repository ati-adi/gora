import { Writable } from 'node:stream';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/kernel/canonicalJson.ts';
import { FakeClock, systemClock } from '../../../src/kernel/clock.ts';
import { AbortedError, BadRequestLlmError, isNotBuilt, NotBuilt, NotBuiltError, TransientLlmError } from '../../../src/kernel/errors.ts';
import { CROCKFORD, draftId, factId, newId, randomToken, shortId, ulid } from '../../../src/kernel/ids.ts';
import { KeyedMutex } from '../../../src/kernel/keyedMutex.ts';
import { createLogger, createMemoryLogger, scrubString } from '../../../src/kernel/log.ts';
import { createCallbackRegistry, NamedRegistry, registerNamed } from '../../../src/kernel/registries.ts';
import { containsReservedTag, escapeAttr, neutralizeReservedTags } from '../../../src/kernel/tags.ts';
import { acquireLock, openDb } from '../../../src/db/sqlite.ts';
import { makeTmpDir, openTmpDb, removeDir, type TmpDb } from '../../harness/tmpDb.ts';

let tmp: TmpDb | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

describe('kernel/ids', () => {
  it('ulid: 26 Crockford chars, time-sortable and monotonic within a millisecond', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_000);
    const c = ulid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b && b < c).toBe(true);
    expect(ulid(1_600_000_000_000) > c).toBe(true); // clock went backwards → still monotonic
    expect(newId('b', 1)).toMatch(/^b_[0-9A-Z]{26}$/);
  });
  it('short ids, fact ids, draft ids, tokens', () => {
    for (let i = 0; i < 50; i++) {
      expect(shortId()).toMatch(new RegExp(`^[${CROCKFORD}]{6}$`));
      expect(factId()).toMatch(/^m[0-9a-z]{6}$/);
      const d = draftId();
      expect(Number.isInteger(d) && d > 0 && d < 2 ** 31).toBe(true);
    }
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('kernel/canonicalJson', () => {
  it('sorts keys recursively, drops undefined, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined, x: null }], c: 'é' } })).toBe('{"a":{"c":"é","d":[3,{"x":null,"z":1}]},"b":1}');
    expect(canonicalJson([undefined, () => 1])).toBe('[null,null]');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(NaN)).toBe('null');
    expect(() => canonicalJson(1n)).toThrow();
    expect(canonicalJson({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
  });
});

describe('kernel/keyedMutex', () => {
  it('serializes per key and runs different keys concurrently', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a1 = m.run('a', async () => {
      order.push('a1:start');
      await gate;
      order.push('a1:end');
    });
    const a2 = m.run('a', async () => void order.push('a2'));
    const b1 = m.run('b', async () => void order.push('b1'));
    await b1;
    expect(order).toEqual(['a1:start', 'b1']);
    expect(m.isLocked('a')).toBe(true);
    release();
    await Promise.all([a1, a2]);
    expect(order).toEqual(['a1:start', 'b1', 'a1:end', 'a2']);
    expect(m.size()).toBe(0);
  });
  it('a failing task does not block the next one', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(m.run('k', () => 7)).resolves.toBe(7);
  });
});

describe('kernel/tags', () => {
  it('neutralizes reserved tags (open, close, spacing, case) and nothing else', () => {
    const s = '<gora_context v="1">x</gora_context> < /untrusted> <UNTRUSTED source="web"> <system-reminder> <previous_epoch_summary> <guest_request caller="x"> <gora_event/>';
    const out = neutralizeReservedTags(s);
    expect(out).not.toMatch(/<\s*\/?\s*(gora_context|gora_event|untrusted|previous_epoch_summary|guest_request|system-reminder)/i);
    expect(out).toContain('‹gora_context v="1">');
    expect(out).toContain('‹/gora_context>');
    expect(out).toContain('‹ /untrusted>');
    expect(neutralizeReservedTags('<details><summary>ok</summary></details> <untrustedness> a<b')).toBe('<details><summary>ok</summary></details> <untrustedness> a<b');
    expect(containsReservedTag('hello <untrusted>')).toBe(true);
    expect(containsReservedTag('hello')).toBe(false);
    expect(escapeAttr('a"b<c>&\nd')).toBe('a&quot;b&lt;c&gt;&amp; d');
  });
});

describe('kernel/errors', () => {
  it('NotBuilt throws NotBuiltError carrying the WP', () => {
    expect(() => NotBuilt('WP3', 'x')).toThrow(NotBuiltError);
    try {
      NotBuilt('WP3');
    } catch (e) {
      expect(isNotBuilt(e)).toBe(true);
      expect((e as NotBuiltError).wp).toBe('WP3');
    }
    expect(new TransientLlmError('rate_limit', undefined, { retryAfterMs: 5 }).retryAfterMs).toBe(5);
    expect(new BadRequestLlmError('x', 'req_1', 'prompt_budget')).toMatchObject({ requestId: 'req_1', code: 'prompt_budget', name: 'BadRequestLlmError' });
  });
});

describe('kernel/clock', () => {
  it('FakeClock fires timers in order while advancing and supports abortable sleep', async () => {
    const c = new FakeClock(1000);
    const fired: string[] = [];
    c.setTimeout(() => fired.push('b@300'), 300);
    c.setTimeout(() => fired.push('a@100'), 100);
    const h = c.setTimeout(() => fired.push('never'), 200);
    c.clearTimeout(h);
    c.setTimeout(() => c.setTimeout(() => fired.push('nested@150'), 50), 100);
    await c.advance(250);
    expect(fired).toEqual(['a@100', 'nested@150']);
    expect(c.now()).toBe(1250);
    await c.advance(100);
    expect(fired).toEqual(['a@100', 'nested@150', 'b@300']);
    let done = false;
    const p = c.sleep(1000).then(() => (done = true));
    await c.advance(999);
    expect(done).toBe(false);
    await c.advance(1);
    await p;
    expect(done).toBe(true);
    const ac = new AbortController();
    const s = c.sleep(10_000, ac.signal);
    ac.abort('stop');
    await expect(s).rejects.toBeInstanceOf(AbortedError);
    expect(c.pending()).toBe(0);
  });
  it('systemClock sleeps for real and is abortable', async () => {
    const c = systemClock();
    const t0 = c.now();
    await c.sleep(5);
    expect(c.now()).toBeGreaterThanOrEqual(t0);
    const ac = new AbortController();
    ac.abort();
    await expect(c.sleep(10, ac.signal)).rejects.toBeInstanceOf(AbortedError);
  });
});

describe('kernel/log redaction', () => {
  it('pino logger censors sensitive keys and scrubs tokens from strings', () => {
    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const log = createLogger({ level: 'debug', destination: dest as unknown as import('pino').DestinationStream });
    log.info({ text: 'my secret message', nested: { token: 'abc', initData: 'user=...' }, url: 'https://api.telegram.org/file/bot123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/voice/1.oga', chat: 7 }, 'hello');
    log.child({ mod: 'x', apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz' }).warn({ msgLen: 3 });
    const out = lines.join('');
    expect(out).not.toContain('my secret message');
    expect(out).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(out).not.toContain('user=...');
    expect(out).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('"chat":7');
    expect(out).toContain('[redacted]');
  });
  it('scrubString and the memory logger', () => {
    expect(scrubString('Authorization: tma query_id=1&hash=abc')).toBe('Authorization: tma [redacted]');
    expect(scrubString('see https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/sendMessage')).not.toContain('ABCDEFGHIJ');
    const m = createMemoryLogger();
    m.child({ run: 'r1' }).info({ text: 'private', n: 1 }, 'm');
    expect(m.entries[0]).toMatchObject({ level: 'info', msg: 'm', obj: { text: '[redacted]', n: 1 }, bindings: { run: 'r1' } });
  });
});

describe('kernel/registries', () => {
  it('callback registry dispatches by kind and rejects duplicates', async () => {
    const r = createCallbackRegistry();
    r.register('a1', async (c) => ({ text: `ok ${c.parts.join(',')}` }));
    expect(() => r.register('a1', async () => undefined)).toThrow(/already registered/);
    const ctx = { kind: 'a1' as const, parts: ['X', 'y'], fromTgId: 1, user: undefined, callbackQueryId: 'q' };
    expect(await r.dispatch(ctx)).toEqual({ text: 'ok X,y' });
    expect(await r.dispatch({ ...ctx, kind: 'ud' })).toEqual({ text: 'This button is no longer active.' });
    expect(r.kinds()).toEqual(['a1']);
  });
  it('named registries keep order and reject duplicate names', () => {
    const n = new NamedRegistry<{ name: string }>();
    n.add({ name: 'b' });
    n.add({ name: 'a' });
    expect(n.list().map((x) => x.name)).toEqual(['b', 'a']);
    expect(() => n.add({ name: 'a' })).toThrow();
    const arr: Array<{ name: string }> = [];
    registerNamed(arr, { name: 'x' });
    expect(() => registerNamed(arr, { name: 'x' })).toThrow();
  });
});

describe('db/sqlite', () => {
  it('tx commits, rolls back, nests with savepoints and refuses async bodies', () => {
    tmp = openTmpDb();
    const db = tmp.db;
    const count = () => Number(db.prepare(`SELECT COUNT(*) AS n FROM kv`).get<{ n: number }>()!.n);
    const put = (k: string) => db.prepare(`INSERT INTO kv(key, value_json, updated_at) VALUES (?, '1', 0)`).run(k);
    db.tx(() => put('a'));
    expect(count()).toBe(1);
    expect(() => db.tx(() => { put('b'); throw new Error('x'); })).toThrow('x');
    expect(count()).toBe(1);
    db.tx(() => {
      put('c');
      expect(() => db.tx(() => { put('d'); throw new Error('inner'); })).toThrow('inner');
      db.tx(() => put('e'));
    });
    expect(db.prepare(`SELECT key FROM kv ORDER BY key`).all<{ key: string }>().map((r) => r.key)).toEqual(['a', 'c', 'e']);
    expect(() => db.tx(() => Promise.resolve(put('f')) as unknown as void)).toThrow(/synchronous/);
    expect(count()).toBe(3);
    expect(db.prepare('SELECT 1 AS x')).toBe(db.prepare('SELECT 1 AS x')); // cached
  });
  it('a failing COMMIT rolls back and leaves the connection usable', () => {
    tmp = openTmpDb();
    const db = tmp.db;
    // A deferred FK violation makes COMMIT itself throw (the same path as SQLITE_BUSY on COMMIT).
    db.exec(`CREATE TABLE t_parent(id INTEGER PRIMARY KEY); CREATE TABLE t_child(pid INTEGER REFERENCES t_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
    expect(() => db.tx(() => db.prepare(`INSERT INTO t_child(pid) VALUES (42)`).run())).toThrow(/FOREIGN KEY/i);
    expect(db.raw.isTransaction).toBe(false);
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM t_child`).get<{ n: number }>()!.n)).toBe(0);
    db.tx(() => db.prepare(`INSERT INTO t_parent(id) VALUES (1)`).run()); // the next tx() works
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM t_parent`).get<{ n: number }>()!.n)).toBe(1);
  });
  it('applies the §4.5 pragmas', () => {
    tmp = openTmpDb();
    const p = (name: string) => Object.values(tmp!.db.raw.prepare(`PRAGMA ${name}`).get() as object)[0];
    expect(p('journal_mode')).toBe('wal');
    expect(p('foreign_keys')).toBe(1);
    expect(p('secure_delete')).toBe(1);
    expect(p('busy_timeout')).toBe(5000);
    expect(p('synchronous')).toBe(1);
    const mem = openDb(':memory:');
    expect(Object.values(mem.raw.prepare('PRAGMA foreign_keys').get() as object)[0]).toBe(1);
    mem.close();
  });
  it('single-writer lockfile', () => {
    const dir = makeTmpDir();
    try {
      const lock = join(dir, 'gora.db.lock');
      const release = acquireLock(lock);
      writeFileSync(lock, String(process.ppid)); // pretend another live process holds it
      expect(() => acquireLock(lock)).toThrow(/locked by another Gora process/);
      writeFileSync(lock, '2147483646'); // dead pid, no heartbeat for a while → stale, taken over
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      const r2 = acquireLock(lock);
      r2();
      release();
    } finally {
      removeDir(dir);
    }
  });
});
