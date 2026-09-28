import { defineConfig } from 'vitest/config';
// Review proofs for area "trust": npx vitest run --config test/review/trust/vitest.review.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/harness/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['test/review/trust/**/*.test.ts'],
  },
});
