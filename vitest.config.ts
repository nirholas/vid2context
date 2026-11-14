import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'providers/*/test/**/*.test.ts', 'examples/test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
