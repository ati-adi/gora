// INTEGRATION (PLAT-1-chat): the chat import path (/import, then a paste) is an LLM side call: it now passes the same
// gate as the Mini App importGate (cooldown, cost cap, turn quota) and spends a turn; out of quota → no import call.
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeQuotas } from '../../harness/fakes.ts';
import { TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, lastButtons, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const paste = ['- Lives in Almaty', '- Vegetarian', '- Has a dog named Bars', '- Works as a product designer', '- Learning Spanish'].join('\n') + '\n' + 'x'.repeat(120);

async function ready() {
  const app = await createSurfacesApp();
  t = app;
  await app.send(U.start());
  const user = app.s.repos.users.getByTg(TEST_USER.id)!;
  app.s.repos.users.update(user.id, { onboardingStep: 'done', tz: 'Asia/Almaty', tzSource: 'manual', memoryConsent: true });
  return { app, user, q: app.s.quotas as unknown as FakeQuotas };
}

describe('chat /import respects the quota gate (PLAT-1)', () => {
  it('in quota: the import runs and spends one turn', async () => {
    const { app, user, q } = await ready();
    await app.send(U.command('import'));
    await app.userSends(paste);
    expect(app.memory.imports).toHaveLength(1);
    expect(q.check(user.id, 'turn').used).toBe(1);
  });
  it('out of turns: no import call', async () => {
    const { app, user, q } = await ready();
    q.limits.turn = 0;
    await app.send(U.command('import'));
    await app.userSends(paste);
    expect(app.memory.imports).toHaveLength(0);
    expect(q.check(user.id, 'turn').used).toBe(0);
  });
});
