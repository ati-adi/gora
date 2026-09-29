import { defineConfig } from 'vitest/config';
// s07 red-team LIVE proofs (real headless Chromium against a loopback-only HTTP server; no internet, no bot, no LLM):
//   LIVE_BROWSER=1 npx vitest run --config test/review/s07/vitest.live.config.ts
export default defineConfig({
  test: { environment: 'node', include: ['test/review/s07/**/*.live.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
