import { defineConfig } from 'vitest/config';

// The root vitest config only collects packages/* and providers/*, so the
// integrations tests run through this config: npx vitest run --config integrations/vitest.config.ts
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/test/fixtures/**'],
    testTimeout: 60_000,
  },
});
