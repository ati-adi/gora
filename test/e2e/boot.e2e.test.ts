// WP0: the e2e project always has at least this file, so `npm run test:e2e:strict` fails if the e2e glob ever matches nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../harness/testApp.ts';

describe('boot (WP0)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('boots the whole app against fakes and answers /healthz', async () => {
    t = await createTestApp();
    const res = await t.app.http.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('restarts on the same files', async () => {
    t = await createTestApp();
    t = await t.restart();
    expect((await t.app.http.request('/healthz')).status).toBe(200);
  });
});
