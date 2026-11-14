import { defineConfig } from 'vitest/config';

// Tests over the built site in dist/. Run `npm run build:site` (repo root) first.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
