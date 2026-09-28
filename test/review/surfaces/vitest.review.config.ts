import { defineConfig } from 'vitest/config';
// Review proofs for area "surfaces": npx vitest run --config test/review/surfaces/vitest.review.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/harness/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['test/review/surfaces/**/*.test.ts'],
  },
});
