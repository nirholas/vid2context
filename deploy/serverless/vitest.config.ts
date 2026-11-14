import { defineConfig } from 'vitest/config';

// Run with: npx vitest run -c deploy/serverless/vitest.config.ts
// (the root config only collects packages/* and providers/* tests).
export default defineConfig({
  test: {
    root: new URL('../..', import.meta.url).pathname,
    include: ['deploy/serverless/test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
