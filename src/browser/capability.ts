// browser/capability.ts (s07 BR, spec 07 A1) — createBrowserCapability(cfg, deps): the Capabilities.browser factory
// called by capabilities/index.ts. Returns the lazy PlaywrightBrowser (src/browser/playwright.ts, the only runtime
// importer of 'playwright' — nothing is loaded or launched at boot) when BROWSER_PROVIDER=playwright and the browser
// feature is on; otherwise the unavailable 'none' capability. Tests inject FakeBrowser through AppOptions.browser.
import type { Config } from '../config.ts';
import type { BrowserCapability, Clock, Logger } from '../contracts/index.ts';
import { PlaywrightBrowser } from './playwright.ts';

export interface BrowserCapabilityDeps { clock: Clock; log: Logger }

/** The unavailable browser: available() is false and openSession rejects. */
export function createNoBrowser(): BrowserCapability {
  return {
    name: 'none',
    available: () => false,
    openSession: async () => {
      throw new Error('browser unavailable');
    },
    session: () => undefined,
    sessions: () => [],
    closeAll: async () => {},
  };
}

export function createBrowserCapability(cfg: Config, deps: BrowserCapabilityDeps): BrowserCapability {
  if (cfg.providers.browser !== 'playwright' || !cfg.features.browser) return createNoBrowser();
  return new PlaywrightBrowser(
    {
      headless: cfg.browser.headless, sandbox: cfg.browser.sandbox, ...(cfg.browser.executablePath ? { executablePath: cfg.browser.executablePath } : {}),
      navigationTimeoutMs: cfg.limits.browserNavigationTimeoutMs, actionTimeoutMs: cfg.limits.browserActionTimeoutMs,
    },
    deps,
  );
}
