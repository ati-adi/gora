// Runs the telegram review proofs: npx vitest run --config test/review/telegram/vitest.review.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: new URL('../../..', import.meta.url).pathname,
  test: { environment: 'node', setupFiles: ['./test/harness/setup.ts'], testTimeout: 20000, hookTimeout: 20000, include: ['test/review/telegram/**/*.test.ts'] },
});
