import { defineConfig } from 'vitest/config';
// s07 red-team proofs (spec 07: browser, Composio, groups): npx vitest run --config test/review/s07/vitest.review.config.ts
// The *.live.test.ts file needs real Chromium + loopback only: LIVE_BROWSER=1 npx vitest run --config test/review/s07/vitest.live.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/harness/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 20_000,
    include: ['test/review/s07/**/*.test.ts'],
    exclude: ['test/review/s07/**/*.live.test.ts'],
  },
});
