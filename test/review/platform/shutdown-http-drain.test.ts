// Review (platform) PLAT-9: shutdown closed gora.db/keys.db while the Mini App API still accepted requests
// (src/main.ts awaited app.stop() and only then server.close(); app.stop() had no HTTP step). In-flight requests then
// failed on a closed database (500) and new writes ran against a stopping runner.
// FIXED: app.stop() drains HTTP first (src/http/drain.ts): new /api/* requests get 503, in-flight ones finish before the
// runner stops and the databases close; main.ts closes the listener before app.stop().
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { TEST_USER } from '../../harness/updates.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('shutdown drains the Mini App API before closing the databases', () => {
  it('an in-flight request completes (200) and a request after stop started gets 503, not 500', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/me')).status).toBe(200);
    const u = t.s.repos.users.getByTg(TEST_USER.id)!;
    // A verify long enough to yield to the event loop many times while stop() runs.
    t.s.db.tx(() => {
      for (let i = 0; i < 5_000; i++) t!.s.ledger.append({ userId: u.id, actor: 'user', kind: 'settings', summary: `s${i}` });
    });
    const inflight = t.api('GET', '/api/ledger/verify');
    await new Promise<void>((r) => setImmediate(r));
    const stopping = t.app.stop();
    const late = await t.api('GET', '/api/home');
    expect(late.status).toBe(503);
    expect(await late.json()).toEqual({ error: 'shutting_down' });
    const r = await inflight;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, brokenAtSeq: null });
    await stopping;
  });
});
