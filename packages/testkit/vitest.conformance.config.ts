import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `npm run conformance`: registry invariants plus the storage and formatter suites over foundation code.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['packages/testkit/conformance/**/*.conformance.ts'],
    testTimeout: 60_000,
  },
});
