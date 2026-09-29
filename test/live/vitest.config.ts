import { defineConfig } from 'vitest/config';

// Opt-in live tests (never part of `npm test` / `npm run test:e2e`): `LIVE_BROWSER=1 npx vitest run --config test/live/vitest.config.ts`.
// No network-disabling setup file: Chromium itself talks to the internet; everything else stays local.
export default defineConfig({
  test: { environment: 'node', include: ['test/live/**/*.live.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
