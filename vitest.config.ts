import { defineConfig } from 'vitest/config';

// Two projects: `unit` (npm test, the per-WP merge gate; includes the test/review/** regression proofs) and `e2e` (npm run test:e2e, the final gate).
// Both inherit the root options: the network-disabling setup file and the node environment.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/harness/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts', 'test/review/**/*.test.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['test/e2e/**/*.e2e.test.ts'] } },
    ],
  },
});
