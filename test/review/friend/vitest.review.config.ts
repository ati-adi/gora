import { defineConfig } from 'vitest/config';
// Red-team proofs for friend mode (spec 05, privacy / creepiness): npx vitest run --config test/review/friend/vitest.review.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/harness/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 20_000,
    include: ['test/review/friend/**/*.test.ts'],
  },
});
