import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests for the CI runner, hygiene checks and release scripts. Kept out of the
// root Vitest config: run with `npx vitest run --config tooling/vitest.config.ts`.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
