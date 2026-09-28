// Review (platform): GET /api/ledger/verify (read class, any Telegram user — the Mini App auto-creates accounts) runs
// ledger.verify(), which synchronously decrypts + re-HMACs EVERY ledger row of the user on the single Node event loop
// (src/ledger/ledger.ts verify; src/http/routes/ledger.ts). Nothing caches the result and the only limiter is the
// generic 240 req/min per user (src/http/server.ts API_RATE_PER_MIN). A user can grow their own ledger cheaply (every
// PATCH /api/settings appends a row, 240/min ≈ 345k rows/day) and then call /verify in a loop: at 50k rows one call
// blocks the process ~1.5 s, so 240 calls/min is ~6 minutes of blocked event loop per minute — the bot (webhook
// ingress, streaming, scheduler) stalls for every user. Measured here with 20k rows (≈ 1.5 h of settings PATCHes).
// FIXED: the route walks the chain in batches that yield, keeps a verified checkpoint per user, and has its own rate.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Runs `fn` while sampling the event loop every 2 ms; returns the longest gap between two ticks. */
async function maxStall<T>(fn: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
  let last = performance.now();
  let worst = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 2);
  try {
    const value = await fn();
    return { value, stallMs: Math.max(worst, performance.now() - last) };
  } finally {
    clearInterval(iv);
  }
}

describe('/api/ledger/verify cost is bounded per user', () => {
  it('a long chain is walked without blocking the event loop, and repeat calls only check new rows', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    // What 20k PATCH /api/settings calls leave behind (seeded directly to keep the test fast).
    t.s.db.tx(() => {
      for (let i = 0; i < 20_000; i++) t!.s.ledger.append({ userId: u.id, actor: 'user', kind: 'settings', summary: 'Settings changed (Mini App): quietStart', detail: { keys: ['quietStart'] } });
    });
    const first = await maxStall(async () => (await t!.api('GET', '/api/ledger/verify')).json());
    expect(first.value).toEqual({ ok: true, brokenAtSeq: null });
    expect(first.stallMs, `the first (full) verify stalled the event loop for ${Math.round(first.stallMs)} ms`).toBeLessThan(250);

    const statuses: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 4; i++) statuses.push((await t.api('GET', '/api/ledger/verify')).status);
    const repeatMs = performance.now() - t0;
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(repeatMs, `4 repeat verify calls took ${Math.round(repeatMs)} ms`).toBeLessThan(200);
    // …and the per-user verify rate applies (the generic Mini App bucket allows 240/min).
    expect((await t.api('GET', '/api/ledger/verify')).status).toBe(200);
    expect((await t.api('GET', '/api/ledger/verify')).status).toBe(429);
  }, 60_000);

  it('rows appended after a verified checkpoint are still checked (a forged new row is caught)', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    for (let i = 0; i < 5; i++) t.s.ledger.append({ userId: u.id, actor: 'user', kind: 'settings', summary: `s${i}` });
    expect(await (await t.api('GET', '/api/ledger/verify')).json()).toEqual({ ok: true, brokenAtSeq: null });
    t.s.ledger.append({ userId: u.id, actor: 'user', kind: 'settings', summary: 'genuine' });
    expect(await (await t.api('GET', '/api/ledger/verify')).json()).toEqual({ ok: true, brokenAtSeq: null });
    const head = t.s.db.prepare('SELECT seq, row_hmac FROM ledger WHERE user_id = ? ORDER BY seq DESC LIMIT 1').get<{ seq: number; row_hmac: string }>(u.id)!;
    const seq = Number(head.seq) + 1;
    const forged = t.s.crypto.seal(`u:${u.id}`, 'I approved everything', `ledger|summary_enc|${u.id}:${seq}`);
    t.s.db
      .prepare(`INSERT INTO ledger(user_id, seq, ts, actor, kind, summary_enc, prev_hmac, row_hmac) VALUES (?, ?, ?, 'user', 'approval_resolved', ?, ?, ?)`)
      .run(u.id, seq, t.clock.now(), forged, head.row_hmac, 'f'.repeat(64));
    expect(await (await t.api('GET', '/api/ledger/verify')).json()).toEqual({ ok: false, brokenAtSeq: seq });
  });
});
