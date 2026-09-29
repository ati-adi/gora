// s07 lead (integration gate) — CAL finding "no cap on pending connect links / polls issued from the Mini App": each
// POST /api/connections/:kind/link issued a new link polled every 5 s for 10 min. Now at most
// MAX_PENDING_LINKS_PER_USER links of a user are pending; the oldest expire (and stop polling) when another is issued.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../../src/contracts/index.ts';
import { FakeIntegrationProvider } from '../../../src/integrations/fake.ts';
import { createLinksRepo, MAX_PENDING_LINKS_PER_USER } from '../../../src/integrations/links.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const NOW = Date.UTC(2026, 8, 29, 6, 0);
function addUser(app: TestApp): UserRow {
  const u = app.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
  return app.s.repos.users.getById(u.id)!;
}

describe('s07 lead: pending connect links are capped per user', () => {
  it('ten Mini App taps keep at most the cap pending, and only those are polled', async () => {
    const provider = new FakeIntegrationProvider({ now: () => NOW });
    t = await createTestApp({ integrations: provider, now: NOW });
    const u = addUser(t);
    const urls: string[] = [];
    for (let i = 0; i < 10; i++) urls.push((await t.s.integrations.startConnect(u.id, i % 2 ? 'gmail' : 'gcal', { chatId: 1001 })).url);
    const links = createLinksRepo(t.s);
    expect(links.pendingIds(u.id, t.clock.now())).toHaveLength(MAX_PENDING_LINKS_PER_USER);
    // the newest links are the pending ones
    const newest = urls.slice(-MAX_PENDING_LINKS_PER_USER).map((x) => links.byState(new URL(x).searchParams.get('state')!)!.id);
    expect(new Set(links.pendingIds(u.id, t.clock.now()))).toEqual(new Set(newest));
    await t.advance(5_000);
    expect(provider.calls.filter((c) => c.startsWith('connectionStatus:')).length).toBe(MAX_PENDING_LINKS_PER_USER);
  });
});
