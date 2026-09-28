// integrations/index.ts (WP5) — createIntegrationService(s, provider?): a passed provider is used as-is (testApp.restart
// hands it to the next App); otherwise it is built from config: fake (default), composio, or none (null).
import type { IntegrationProvider, IntegrationService, Services } from '../contracts/index.ts';
import { ComposioProvider } from './composio.ts';
import { FakeIntegrationProvider } from './fake.ts';
import { createIntegrationServiceImpl } from './service.ts';

/** `fetchImpl` for Composio: app.ts does not pass one to this factory (CONTRACT REQUEST), so it is taken from `o`. */
export function createIntegrationService(s: Services, provider?: IntegrationProvider, o: { fetchImpl?: typeof fetch } = {}): IntegrationService {
  return createIntegrationServiceImpl(s, provider ?? buildProvider(s, o.fetchImpl));
}

function buildProvider(s: Services, fetchImpl: typeof fetch | undefined): IntegrationProvider | null {
  const cfg = s.config;
  switch (cfg.providers.integrations) {
    case 'fake':
      return new FakeIntegrationProvider({ now: () => s.clock.now(), publicUrl: cfg.publicUrl });
    case 'composio':
      if (!cfg.keys.composio || !fetchImpl) {
        s.log.warn({ provider: 'composio' }, 'composio selected without a key or fetchImpl; integrations disabled');
        return null;
      }
      return new ComposioProvider({ apiKey: cfg.keys.composio, fetchImpl, clock: s.clock, log: s.log.child({ mod: 'composio' }) });
    default:
      return null;
  }
}

export { FakeIntegrationProvider } from './fake.ts';
export { ComposioProvider } from './composio.ts';
